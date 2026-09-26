// ====================================================================
// Map feature interactions: flowpath hover tooltip, click info panel,
// divide click -> upstream highlight.
// ====================================================================
import { state, map } from "../state.js";
import {
  HIDDEN_FILTER,
  GAGE_LAYER,
  GAGE_FEATURE,
  USGS_FLOW_PARAM,
  VARIABLES,
  isValid,
} from "../config.js";
import { valueAt, dataTimeRangeMs } from "../data/access.js";
import { fetchGageMeta, peekGageMeta } from "../data/usgs.js";
import { siteFromGageFeature } from "./gages.js";
import { iconButton, labeledRow, fmtDay } from "../ui/dom.js";
import { showFeatureInfo } from "../ui/infopanel.js";
import { showGageInfo } from "../ui/gagepanel.js";
// maplibregl is a global provided by the CDN <script> in index.html.


// toggle hill shade and highlight the button icon
function toggleHillshade() {
  const visible =  this._map.getLayoutProperty("hills", "visibility") === "visible";
  this._map.setLayoutProperty("hills", "visibility", visible ? "none" : "visible");
  this._button.classList.toggle("active", !visible);
}

// hillshade toggle control
export class HillshadeControl {
  // onclick make it toggle the visibility of the hillshade layer
  onAdd(map) {
    this._map = map;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this._button = iconButton(
      "maplibregl-ctrl-hillshade",
      "Enable hillshade",
      "M9.4,13.61,13,21H4l3.6-7.39A1,1,0,0,1,9.4,13.61Zm5.48-2.09a1,1,0,0,0-1.76,0l-2.49,4.62L13,21h7ZM3,21H21M6,3A3,3,0,1,0,9,6,3,3,0,0,0,6,3Z",
      {
        pathStyle:
          "fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1px",
      },
    );
    this._button.onclick = toggleHillshade.bind(this);
    this._container.appendChild(this._button);
    return this._container;
  }
  onRemove() {
    this._container.remove();
    this._map = undefined;
  }
}

// ---- Hover tooltip -------------------------------------------------

export function onFlowpathHover(e) {
  if (!state.data || !e.features?.length) return;
  // A hovered gage owns the cursor: keep the reach tooltip out of its way.
  if (hoveredGageId != null) {
    onFlowpathLeave();
    return;
  }
  const id = e.features[0].id;
  state.hoveredId = id;

  const tooltip = document.getElementById("tooltip");
  tooltip.classList.add("visible");
  tooltip.style.left = `${e.point.x + 15}px`;
  tooltip.style.top = `${e.point.y + 15}px`;
  updateTooltipContent(id);
}

export function onFlowpathLeave() {
  state.hoveredId = null;
  document.getElementById("tooltip").classList.remove("visible");
}

function updateTooltipContent(id) {
  const row = state.data.index.get(id);
  document.getElementById("tooltipTitle").textContent = `wb-${id}`;
  // One row per routed variable, so adding a variable to config.VARIABLES is
  // all it takes to show up here.
  document.getElementById("tooltipRows").replaceChildren(
    ...Object.entries(VARIABLES).map(([key, { label, units }]) => {
      const v = row === undefined ? undefined : valueAt(key, row, state.timeIndex);
      const text =
        v !== undefined && isValid(v) ? `${v.toFixed(3)} ${units}` : "N/A";
      return labeledRow(label, text, { prefix: "tooltip" });
    }),
  );
}

export function refreshTooltip() {
  if (state.hoveredId == null || !state.data) return;
  const tooltip = document.getElementById("tooltip");
  if (!tooltip.classList.contains("visible")) return;
  updateTooltipContent(state.hoveredId);
}

// ---- Click info panel ----------------------------------------------

export function onFlowpathClick(e) {
  if (!state.data || !e.features?.length || clickHitsGage(e)) return;
  showFeatureInfo(e.features[0]);
}

// ---- Gages: hover glow + tooltip, click -> hydrograph panel ---------

// MapLibre runs every layer's click handler for one click, so the gage
// handler can't stop the flowpath/divide ones; those layers bail out when a
// gage dot is under the cursor instead.
function clickHitsGage(e) {
  return map.queryRenderedFeatures(e.point, { layers: [GAGE_LAYER] }).length > 0;
}

let hoveredGageId = null;
let hoveredGagePoint = null;
let metaTimer = null;

// Sweeping the cursor over a cluster of dots shouldn't fire a request per dot:
// an unknown gage's metadata lookup waits this long before going out.
const META_HOVER_DELAY_MS = 180;

export function onGageHover(e) {
  if (!e.features?.length) return;
  const feature = e.features[0];
  const id = feature.id;
  if (id !== hoveredGageId) {
    setGageHover(hoveredGageId, false);
    setGageHover(id, true);
    hoveredGageId = id;
    showGageTooltip(feature);
  }
  hoveredGagePoint = e.point;
  positionGageTooltip();
}

export function onGageLeave() {
  setGageHover(hoveredGageId, false);
  hoveredGageId = null;
  hoveredGagePoint = null;
  clearTimeout(metaTimer);
  document.getElementById("gageTooltip").classList.remove("visible");
  map.getCanvas().style.cursor = "";
}

function setGageHover(id, hover) {
  if (id == null) return;
  map.setFeatureState({ ...GAGE_FEATURE, id }, { hover });
}

// The gage tooltip grows once its metadata lands, so unlike the reach tooltip
// it has to be kept inside the map rather than always hung below-right.
// Canvas size, refreshed on map resize rather than read on every pointermove:
// the read came straight after writing the tooltip's contents, so it forced a
// synchronous layout each time the cursor moved over a gage.
let canvasBox = null;
export function invalidateCanvasBox() {
  canvasBox = null;
}

function canvasSize() {
  if (!canvasBox) {
    const canvas = map.getCanvas();
    canvasBox = { w: canvas.clientWidth, h: canvas.clientHeight };
  }
  return canvasBox;
}

function positionGageTooltip() {
  if (!hoveredGagePoint) return;
  const tooltip = document.getElementById("gageTooltip");
  const { w, h } = canvasSize();
  const pad = 8;
  let x = hoveredGagePoint.x + 15;
  let y = hoveredGagePoint.y + 15;
  if (x + tooltip.offsetWidth > w - pad) {
    x = Math.max(pad, hoveredGagePoint.x - 15 - tooltip.offsetWidth);
  }
  if (y + tooltip.offsetHeight > h - pad) {
    y = Math.max(pad, h - pad - tooltip.offsetHeight);
  }
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}

// Site number and reach show immediately; the station name and USGS metadata
// fill in once the (cached) lookup resolves, provided this gage is still the
// hovered one.
function showGageTooltip(feature) {
  const site = siteFromGageFeature(feature);
  const reachId = feature.properties.id;
  const tooltip = document.getElementById("gageTooltip");
  document.getElementById("gageTooltipTitle").textContent = `USGS-${site}`;
  document.getElementById("gageTooltipName").textContent = `wb-${reachId}`;
  document.getElementById("gageTooltipMeta").innerHTML =
    '<div class="tooltip-loading"><span class="spinner"></span>Loading info…</div>';
  tooltip.classList.add("visible");
  map.getCanvas().style.cursor = "pointer";

  // A gage looked up earlier in the session renders without the debounce.
  const id = feature.id;
  clearTimeout(metaTimer);
  const known = peekGageMeta(site);
  if (known) {
    applyGageMeta(known, id, reachId);
  } else {
    metaTimer = setTimeout(
      () => applyGageMeta(fetchGageMeta(site), id, reachId),
      META_HOVER_DELAY_MS,
    );
  }
}

function applyGageMeta(promise, id, reachId) {
  promise
    .then((meta) => {
      if (hoveredGageId !== id) return;
      document.getElementById("gageTooltipName").textContent =
        meta.name || `wb-${reachId}`;
      renderGageMeta(meta, reachId);
    })
    .catch(() => {
      if (hoveredGageId !== id) return;
      document.getElementById("gageTooltipMeta").innerHTML =
        '<div class="tooltip-sub">No USGS metadata</div>';
      positionGageTooltip();
    });
}

function renderGageMeta(meta, reachId) {
  const rows = [["Reach", `wb-${reachId}`]];
  // Stream is the norm; anything else (reservoir, canal, tidal) changes how
  // comparable the observations are to routed flow, so call it out.
  if (meta.siteType && meta.siteType !== "Stream") rows.push(["Type", meta.siteType]);
  rows.push(
    meta.flow
      ? ["Discharge", prettyUnits(meta.flow.units)]
      : ["Discharge", "not continuous", "bad"],
  );
  if (meta.flow) {
    rows.push(["Record", `${fmtDay(meta.flow.beginMs)} → ${fmtDay(meta.flow.endMs)}`]);
  }
  const coverage = runCoverage(meta.flow);
  if (coverage) rows.push(["Run window", coverage.text, coverage.cls]);
  if (meta.drainageArea != null) {
    rows.push(["Drainage", `${fmtArea(meta.drainageArea)} mi²`]);
  }
  if (meta.altitude != null) {
    const datum = meta.verticalDatum ? ` ${meta.verticalDatum}` : "";
    rows.push(["Altitude", `${Math.round(meta.altitude)} ft${datum}`]);
  }
  const others = meta.series.filter((s) => s.code !== USGS_FLOW_PARAM);
  if (others.length) rows.push(["Also", otherParamsLabel(others)]);

  document
    .getElementById("gageTooltipMeta")
    .replaceChildren(
      ...rows.map(([label, value, cls]) =>
        labeledRow(label, value, { prefix: "tooltip", cls }),
      ),
    );
  positionGageTooltip();
}

// Does the gage's discharge record span the loaded run? Only the published
// start/end are known here, so this can't see gaps inside the record.
function runCoverage(flow) {
  const range = state.data ? dataTimeRangeMs() : null;
  if (!range) return null;
  if (!flow || flow.beginMs == null || flow.endMs == null) {
    return { text: "no discharge", cls: "bad" };
  }
  if (flow.beginMs <= range.start && flow.endMs >= range.end) {
    return { text: "in record", cls: "ok" };
  }
  if (flow.endMs < range.start || flow.beginMs > range.end) {
    return { text: "outside record", cls: "bad" };
  }
  return { text: "partial", cls: "warn" };
}

// Parameter names are of the form "Temperature, water" / "NO3+NO2,water,..";
// the head of the name is the part worth the tooltip's width.
function otherParamsLabel(series) {
  const names = series.map((s) => s.name.split(",")[0].trim());
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

const UNIT_LABELS = {
  "ft^3/s": "ft³/s",
  "m^3/s": "m³/s",
  degC: "°C",
  "mg/l": "mg/L",
  "uS/cm": "µS/cm",
};

function prettyUnits(units) {
  return UNIT_LABELS[units] ?? String(units || "").replace(/^_/, "");
}

function fmtArea(mi2) {
  return mi2.toLocaleString("en-US", {
    maximumFractionDigits: mi2 >= 100 ? 0 : 1,
  });
}

export function onGageClick(e) {
  if (!state.data || !e.features?.length) return;
  showGageInfo(e.features[0]);
}

// ---- Upstream highlight (divide click) -----------------------------

export function clearUpstreamHighlight() {
  state.lastClickedDivide = null;
  map.setFilter("selected-divides", HIDDEN_FILTER);
  map.setFilter("upstream-divides", HIDDEN_FILTER);
}

export function onDivideClick(e) {
  if (!e.features?.length || clickHitsGage(e)) return;
  const divide = e.features[0];
  const upstreamId = divide.properties.upstream_id;
  const numUpstreams = divide.properties.num_upstreams;

  // Clicking the already-selected catchment toggles the highlight off.
  if (
    state.lastClickedDivide &&
    state.lastClickedDivide.upstreamId === upstreamId
  ) {
    clearUpstreamHighlight();
    return;
  }

  state.lastClickedDivide = { upstreamId, numUpstreams, lngLat: e.lngLat };

  map.setFilter("selected-divides", ["==", "upstream_id", upstreamId]);
  map.setFilter("upstream-divides", [
    "all",
    [">", "upstream_id", upstreamId],
    ["<=", "upstream_id", upstreamId + numUpstreams],
    ["!=", "upstream_id", upstreamId],
  ]);

  if (!numUpstreams) {
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setHTML("No upstreams")
      .addTo(map);
  }
}

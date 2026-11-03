// ====================================================================
// Map feature interactions: flowpath hover tooltip, click info panel,
// catchment click -> forcing plot, upstream highlight.
// ====================================================================
import { state, map } from "../state.js";
import {
  HIDDEN_FILTER,
  GAGE_LAYER,
  NEXRAD_SITE_LAYER,
  GAGE_FEATURE,
  REACH_SETS,
  reachSetOf,
  reachSetForLayer,
  USGS_FLOW_PARAM,
  USGS_OBS_TYPES,
  USGS_SITES_SOURCE,
  USGS_SITES_LAYER,
  VARIABLES,
  isValid,
} from "../config.js";
import { valueAt, dataTimeRangeMs, hasVariable } from "../data/access.js";
import { fetchGageMeta, peekGageMeta } from "../data/usgs.js";
import { catalogMeta } from "../data/usgscatalog.js";
import { siteFromGageFeature } from "./gages.js";
import { iconButton, labeledRow, fmtDay } from "../ui/dom.js";
import { showFeatureInfo } from "../ui/infopanel.js";
import { showGageInfo, showSiteInfo } from "../ui/gagepanel.js";
import { openForcingPlot } from "../ui/forcingplot.js";
import { hasForcingSource } from "../forcing/loader.js";
import { invalidateResultsView } from "./paint.js";
import { initialLayer, noteLayer, saveLayer } from "./layerprefs.js";
// maplibregl is a global provided by the CDN <script> in index.html.


// Terrain + hillshade, grouped in one box: wraps MapLibre's TerrainControl
// and appends the hillshade toggle to its container. Both start from
// map/layerprefs.js and report to it.
export class TerrainControl {
  onAdd(map) {
    this._map = map;
    this._terrain = new maplibregl.TerrainControl({
      source: "terrainSource",
      exaggeration: 1,
    });
    this._container = this._terrain.onAdd(map);
    // MapLibre's own button: once the style is in, its click handler (added
    // first) has already toggled the terrain by the time this one runs.
    // Before that, its setTerrain throws, so the click is kept as what to
    // apply on load. The flood panel turns terrain on from code, which the
    // terrain event catches.
    this._terrainOn = initialLayer("terrain");
    let loaded = false;
    const terrainButton = this._container.firstElementChild;
    terrainButton.addEventListener("click", () => {
      this._terrainOn = loaded ? !!map.getTerrain() : !this._terrainOn;
      if (!loaded) {
        terrainButton.classList.toggle("maplibregl-ctrl-terrain", !this._terrainOn);
        terrainButton.classList.toggle("maplibregl-ctrl-terrain-enabled", this._terrainOn);
      }
      saveLayer("terrain", this._terrainOn);
    });
    map.on("terrain", () => noteLayer("terrain", !!map.getTerrain()));

    this._button = iconButton(
      "maplibregl-ctrl-hillshade",
      "Enable hillshade",
      "M9.4,13.61,13,21H4l3.6-7.39A1,1,0,0,1,9.4,13.61Zm5.48-2.09a1,1,0,0,0-1.76,0l-2.49,4.62L13,21h7ZM3,21H21M6,3A3,3,0,1,0,9,6,3,3,0,0,0,6,3Z",
      {
        pathStyle:
          "fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1px",
      },
    );
    this._hillshade = initialLayer("hillshade");
    this._syncHillshade();
    this._button.onclick = () => {
      this._setHillshade(!this._hillshade);
      saveLayer("hillshade", this._hillshade);
    };
    this._container.appendChild(this._button);

    // The terrain and hills sources/layers only exist once the style loads.
    map.once("load", () => {
      loaded = true;
      if (this._terrainOn) map.setTerrain(this._terrain.options);
      this._setHillshade(this._hillshade);
    });
    return this._container;
  }
  _setHillshade(on) {
    this._hillshade = on;
    if (this._map.getLayer("hills")) {
      this._map.setLayoutProperty("hills", "visibility", on ? "visible" : "none");
    }
    this._syncHillshade();
    noteLayer("hillshade", on);
  }
  _syncHillshade() {
    this._button.classList.toggle("active", this._hillshade);
    this._button.title = this._hillshade ? "Disable hillshade" : "Enable hillshade";
  }
  onRemove() {
    this._terrain.onRemove();
    this._map = undefined;
  }
}

// Flowpaths + catchments toggles, grouped in one box.
//
// Flowpaths are shown by default. Hiding them hides the hover overlay too, so
// a hidden reach can't be hovered or clicked.
//
// Catchments: the divide outlines plus the selected/upstream highlight
// layers, hidden by default. Choosing "Highlight upstream" from the context
// menu turns them on (setCatchmentsVisible), since the highlight is drawn by
// those layers. Both start from map/layerprefs.js; only a button click saves.
const FLOWPATH_LAYERS = ["flowpaths", "flowpaths-hover"];
const NWM_LAYERS = [REACH_SETS.nwm.layer, REACH_SETS.nwm.hoverLayer];
const CATCHMENT_LAYERS = ["divides", "selected-divides", "upstream-divides"];
let flowpathsVisible = initialLayer("flowpaths");
let nwmVisible = initialLayer("nwm");
let catchmentsVisible = initialLayer("catchments");
let flowpathButton = null;
let nwmButton = null;
let catchmentButton = null;

function setLayersVisible(layers, visible) {
  for (const layer of layers) {
    if (!map.getLayer(layer)) continue;
    map.setLayoutProperty(layer, "visibility", visible ? "visible" : "none");
  }
}

export function setFlowpathsVisible(visible) {
  flowpathsVisible = visible;
  setLayersVisible(FLOWPATH_LAYERS, visible);
  if (!visible) onFlowpathLeave(REACH_SETS.hydrofabric);
  // queryRenderedFeatures sees nothing while the layer is hidden, so the
  // painter's on-screen set is stale: requery once it's back.
  else if (state.data) invalidateResultsView();
  syncHydrofabricButtons();
  noteLayer("flowpaths", visible);
}

// The NWM flowlines (config.REACH_SETS.nwm), off by default.
export function setNwmVisible(visible) {
  nwmVisible = visible;
  setLayersVisible(NWM_LAYERS, visible);
  if (!visible) onFlowpathLeave(REACH_SETS.nwm);
  else if (state.data) invalidateResultsView();
  syncHydrofabricButtons();
  noteLayer("nwm", visible);
}

export function setCatchmentsVisible(visible) {
  catchmentsVisible = visible;
  setLayersVisible(CATCHMENT_LAYERS, visible);
  syncHydrofabricButtons();
  noteLayer("catchments", visible);
}

function syncHydrofabricButtons() {
  if (flowpathButton) {
    flowpathButton.classList.toggle("active", flowpathsVisible);
    flowpathButton.title = flowpathsVisible ? "Hide flowpaths" : "Show flowpaths";
  }
  if (nwmButton) {
    nwmButton.classList.toggle("active", nwmVisible);
    nwmButton.title = nwmVisible ? "Hide NWM flowlines" : "Show NWM flowlines";
  }
  if (catchmentButton) {
    catchmentButton.classList.toggle("active", catchmentsVisible);
    catchmentButton.title = catchmentsVisible ? "Hide catchments" : "Show catchments";
  }
}

export class HydrofabricControl {
  onAdd(map) {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    // Branching line: a river network.
    flowpathButton = iconButton(
      "maplibregl-ctrl-flowpaths",
      "Hide flowpaths",
      "M4,20C8,17,9,13,12,11s5-5,6-7M12,11c2,1,5,1,7,3M9,15C7,14,5,11,5,8",
    );
    flowpathButton.onclick = () => {
      setFlowpathsVisible(!flowpathsVisible);
      saveLayer("flowpaths", flowpathsVisible);
    };
    // "N" beside a river: the NWM channel network.
    nwmButton = iconButton(
      "maplibregl-ctrl-nwm",
      "Show NWM flowlines",
      "M3,18V6l7,12V6M14,19c2-2,2-5,4-7s2-4,3-6",
    );
    nwmButton.onclick = () => {
      setNwmVisible(!nwmVisible);
      saveLayer("nwm", nwmVisible);
    };
    // Irregular polygon: a catchment outline.
    catchmentButton = iconButton(
      "maplibregl-ctrl-catchments",
      "Show catchments",
      "M4,8,10,4l8,3,2,8-7,5L5,17Z",
    );
    catchmentButton.onclick = () => {
      setCatchmentsVisible(!catchmentsVisible);
      saveLayer("catchments", catchmentsVisible);
    };
    this._container.append(flowpathButton, nwmButton, catchmentButton);
    syncHydrofabricButtons();
    // The style's own visibility is the default; apply the starting state
    // once its layers exist.
    map.once("load", () => {
      setFlowpathsVisible(flowpathsVisible);
      setNwmVisible(nwmVisible);
      setCatchmentsVisible(catchmentsVisible);
    });
    return this._container;
  }
  onRemove() {
    this._container.remove();
    flowpathButton = null;
    nwmButton = null;
    catchmentButton = null;
  }
}

// ---- Hover tooltip -------------------------------------------------

// Reach drawn highlighted (map/flowpathstyle.js), with or without a run, so
// it's clear where one reach ends and the next begins. { set, id } or null.
let highlighted = null;

function highlightReach(set, id) {
  if (highlighted?.set === set && highlighted?.id === id) return;
  if (highlighted) {
    map.setFeatureState({ ...highlighted.set.feature, id: highlighted.id }, { hover: false });
  }
  highlighted = id == null ? null : { set, id };
  if (highlighted) map.setFeatureState({ ...set.feature, id }, { hover: true });
}

// The reach under the tooltip: { set, id, properties, withData }, or null.
let hoveredReach = null;

// Bound to each network's hover layer (map/init.js).
export function onFlowpathHover(e) {
  const feature = e.features?.[0];
  if (!feature) return;
  // A hovered gage owns the cursor: keep the reach tooltip out of its way.
  if (hovered) {
    onFlowpathLeave();
    return;
  }
  const set = reachSetForLayer(feature.layer.id);
  const active = reachSetOf(state.data);
  // Both networks on and overlapping: the loaded run's network wins, else
  // the NWM one (the only one with a tooltip of its own).
  const preferred = state.data ? active : REACH_SETS.nwm;
  if (set !== preferred && reachIn(preferred, e.point)) return;
  highlightReach(set, feature.id);

  // Values when the run is on this network; the NWM tiles' own attributes
  // are worth a tooltip without one. A bare hydrofabric reach isn't.
  const withData = !!state.data && set === active;
  if (!withData && set !== REACH_SETS.nwm) {
    hideTooltip();
    return;
  }
  hoveredReach = { set, id: feature.id, properties: feature.properties ?? {}, withData };
  state.hoveredId = withData ? feature.id : null;

  const tooltip = document.getElementById("tooltip");
  tooltip.classList.add("visible");
  tooltip.style.left = `${e.point.x + 15}px`;
  tooltip.style.top = `${e.point.y + 15}px`;
  updateTooltipContent();
}

function hideTooltip() {
  hoveredReach = null;
  state.hoveredId = null;
  document.getElementById("tooltip").classList.remove("visible");
}

// The cursor left `set`'s hover layer (or everything, with no set): only
// clears what that network put up, so leaving one of two overlapping
// networks doesn't blank the other's tooltip.
export function onFlowpathLeave(set) {
  if (set && highlighted && highlighted.set !== set) return;
  highlightReach(null, null);
  hideTooltip();
}

function updateTooltipContent() {
  const { set, id, properties, withData } = hoveredReach;
  document.getElementById("tooltipTitle").textContent = set.label(id);
  const rows = [];
  if (withData) {
    const row = state.data.index.get(id);
    // One row per variable the run has, so adding a variable to
    // config.VARIABLES is all it takes to show up here.
    for (const [key, { label, units }] of Object.entries(VARIABLES)) {
      if (!hasVariable(key)) continue;
      const v = row === undefined ? undefined : valueAt(key, row, state.timeIndex);
      const text = v !== undefined && isValid(v) ? `${v.toFixed(3)} ${units}` : "N/A";
      rows.push(labeledRow(label, text, { prefix: "tooltip" }));
    }
  }
  // NWM tiles omit `gages` when the reach has none (and below z7 carry only
  // the id and order).
  if (set === REACH_SETS.nwm) {
    if (properties.gages) rows.push(labeledRow("USGS gage", String(properties.gages), { prefix: "tooltip" }));
    if (properties.order != null) rows.push(labeledRow("Order", String(properties.order), { prefix: "tooltip" }));
  }
  document.getElementById("tooltipRows").replaceChildren(...rows);
}

export function refreshTooltip() {
  if (!hoveredReach?.withData || !state.data) return;
  const tooltip = document.getElementById("tooltip");
  if (!tooltip.classList.contains("visible")) return;
  updateTooltipContent();
}

// ---- Click info panel ----------------------------------------------

export function onFlowpathClick(e) {
  if (!state.data || !e.features?.length || clickHitsGage(e)) return;
  // Only the loaded run's network has a hydrograph to show.
  const feature = e.features[0];
  if (reachSetForLayer(feature.layer.id) !== reachSetOf(state.data)) return;
  showFeatureInfo(feature);
}

// ---- Gages: hover glow + tooltip, click -> hydrograph panel ---------

// MapLibre runs every layer's click handler for one click, so the gage
// handler can't stop the flowpath/divide ones; those layers bail out when a
// gage dot is under the cursor instead.
// Gages (the run's and the catalog's) and NEXRAD station dots own their clicks.
function clickHitsGage(e) {
  const layers = [GAGE_LAYER];
  if (map.getLayer(USGS_SITES_LAYER)) layers.push(USGS_SITES_LAYER);
  if (map.getLayer(NEXRAD_SITE_LAYER)) layers.push(NEXRAD_SITE_LAYER);
  return map.queryRenderedFeatures(e.point, { layers }).length > 0;
}

// The run's gage dot at a point. It's drawn over the catalog dots and owns
// the hover and click where they overlap.
function runGageAt(point) {
  return map.queryRenderedFeatures(point, { layers: [GAGE_LAYER] })[0] ?? null;
}

const USGS_SITE_FEATURE = { source: USGS_SITES_SOURCE };

let hovered = null; // { target: feature-state target, id }
let hoverToken = 0; // bumped per newly hovered gage, to drop late metadata
let hoveredGagePoint = null;
let metaTimer = null;

// Sweeping the cursor over a cluster of dots shouldn't fire a request per dot:
// an unknown gage's metadata lookup waits this long before going out.
const META_HOVER_DELAY_MS = 180;

export function onGageHover(e) {
  const feature = e.features?.[0];
  if (!feature) return;
  hoverGage(
    { target: GAGE_FEATURE, id: feature.id },
    `USGS-${siteFromGageFeature(feature)}`,
    feature.properties.id,
    e.point,
  );
}

export function onUsgsSiteHover(e) {
  const feature = e.features?.[0];
  if (!feature || runGageAt(e.point)) return;
  hoverGage({ target: USGS_SITE_FEATURE, id: feature.id }, feature.properties.id, null, e.point);
}

function hoverGage(next, locationId, reachId, point) {
  if (next.target !== hovered?.target || next.id !== hovered?.id) {
    setGageHover(hovered, false);
    setGageHover(next, true);
    hovered = next;
    showGageTooltip(locationId, reachId);
  }
  hoveredGagePoint = point;
  positionGageTooltip();
}

export function onGageLeave() {
  setGageHover(hovered, false);
  hovered = null;
  hoveredGagePoint = null;
  clearTimeout(metaTimer);
  document.getElementById("gageTooltip").classList.remove("visible");
  map.getCanvas().style.cursor = "";
}

// Leaving a catalog dot only ends a hover that's on one: the run's gage dot
// over it may have taken the hover over.
export function onUsgsSiteLeave() {
  if (hovered?.target === USGS_SITE_FEATURE) onGageLeave();
}

function setGageHover(h, hover) {
  if (h) map.setFeatureState({ ...h.target, id: h.id }, { hover });
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

// The site's catalog entry renders at once. A gage the catalog doesn't have
// (or before it loads) shows its id and reach immediately; the station name
// and USGS metadata fill in once the (cached) lookup resolves, provided this
// gage is still the hovered one. `reachId` is null for a catalog dot.
function showGageTooltip(locationId, reachId) {
  const tooltip = document.getElementById("gageTooltip");
  const reachText = reachId != null ? `wb-${reachId}` : "";
  document.getElementById("gageTooltipTitle").textContent = locationId;
  document.getElementById("gageTooltipName").textContent = reachText;
  tooltip.classList.add("visible");
  map.getCanvas().style.cursor = "pointer";

  const token = ++hoverToken;
  clearTimeout(metaTimer);
  const fromCatalog = catalogMeta(locationId);
  if (fromCatalog) {
    applyGageMeta(Promise.resolve(fromCatalog), token, reachId);
    return;
  }
  document.getElementById("gageTooltipMeta").innerHTML =
    '<div class="tooltip-loading"><span class="spinner"></span>Loading info…</div>';
  const site = locationId.replace(/^USGS-/, "");
  // A gage looked up earlier in the session renders without the debounce.
  const known = peekGageMeta(site);
  if (known) {
    applyGageMeta(known, token, reachId);
  } else {
    metaTimer = setTimeout(
      () => applyGageMeta(fetchGageMeta(site), token, reachId),
      META_HOVER_DELAY_MS,
    );
  }
}

function applyGageMeta(promise, token, reachId) {
  promise
    .then((meta) => {
      if (token !== hoverToken || !hovered) return;
      document.getElementById("gageTooltipName").textContent =
        meta.name || (reachId != null ? `wb-${reachId}` : "");
      renderGageMeta(meta, reachId);
    })
    .catch(() => {
      if (token !== hoverToken || !hovered) return;
      document.getElementById("gageTooltipMeta").innerHTML =
        '<div class="tooltip-sub">No USGS metadata</div>';
      positionGageTooltip();
    });
}

function renderGageMeta(meta, reachId) {
  const rows = [];
  if (reachId != null) rows.push(["Reach", `wb-${reachId}`]);
  // Stream is the norm; anything else (reservoir, canal, tidal) changes how
  // comparable the observations are to routed flow, so call it out.
  if (meta.siteType && meta.siteType !== "Stream") rows.push(["Type", meta.siteType]);
  if (meta.active === false) rows.push(["Status", "not reporting", "warn"]);
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
  // The catalog knows the observation types; a direct lookup only has the
  // parameter list.
  if (meta.types) {
    rows.push(["Observes", meta.types.map((i) => USGS_OBS_TYPES[i].label).join(", ")]);
  } else {
    const others = meta.series.filter((s) => s.code !== USGS_FLOW_PARAM);
    if (others.length) rows.push(["Also", otherParamsLabel(others)]);
  }

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

// A catalog dot: its station panel. The run's gage dot over it (if any)
// wins, as that one can open the hydrograph.
export function onUsgsSiteClick(e) {
  if (!e.features?.length || runGageAt(e.point)) return;
  showSiteInfo(e.features[0].properties.id);
}

// ---- Catchment click -> forcing plot ---------------------------------

// Left click on a catchment opens its forcings. A reach under the cursor
// (with a run loaded, so the reach click does something) or a gage keeps the
// click; the context menu offers the catchment's forcings there instead.
export function onCatchmentClick(e) {
  if (state.brushActive || !e.features?.length || clickHitsGage(e)) return;
  if (state.data && reachAt(e.point)) return;
  if (!hasForcingSource()) return;
  openForcingPlot(e.features[0].id, e.point);
}

// A network's reach at a point (its hover layer, when shown), or null.
function reachIn(set, point) {
  if (!map.getLayer(set.hoverLayer)) return null;
  if (map.getLayoutProperty(set.hoverLayer, "visibility") === "none") return null;
  return map.queryRenderedFeatures(point, { layers: [set.hoverLayer] })[0] ?? null;
}

// The loaded run's reach at a point, or null.
export function reachAt(point) {
  return reachIn(reachSetOf(state.data), point);
}

// ---- Upstream highlight ------------------------------------------------

export function clearUpstreamHighlight() {
  state.lastClickedDivide = null;
  map.setFilter("selected-divides", HIDDEN_FILTER);
  map.setFilter("upstream-divides", HIDDEN_FILTER);
}

export function isUpstreamHighlighted(divide) {
  return state.lastClickedDivide?.upstreamId === divide.properties.upstream_id;
}

// Highlight `divide` (a divides-source feature) and everything upstream of
// it; the same catchment again clears the highlight.
export function toggleUpstreamHighlight(divide, lngLat) {
  const upstreamId = divide.properties.upstream_id;
  const numUpstreams = divide.properties.num_upstreams;

  if (isUpstreamHighlighted(divide)) {
    clearUpstreamHighlight();
    return;
  }

  state.lastClickedDivide = { upstreamId, numUpstreams, lngLat };
  setCatchmentsVisible(true);

  map.setFilter("selected-divides", ["==", "upstream_id", upstreamId]);
  map.setFilter("upstream-divides", [
    "all",
    [">", "upstream_id", upstreamId],
    ["<=", "upstream_id", upstreamId + numUpstreams],
    ["!=", "upstream_id", upstreamId],
  ]);

  if (!numUpstreams) {
    new maplibregl.Popup()
      .setLngLat(lngLat)
      .setHTML("No upstreams")
      .addTo(map);
  }
}

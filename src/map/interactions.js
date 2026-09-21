// ====================================================================
// Map feature interactions: flowpath hover tooltip, click info panel,
// divide click -> upstream highlight.
// ====================================================================
import { state, map } from "../state.js";
import { HIDDEN_FILTER, GAGE_LAYER, GAGE_FEATURE } from "../config.js";
import { valueAt } from "../data/access.js";
import { fetchGageName } from "../data/usgs.js";
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
    this._button = document.createElement("button");
    this._button.className = "maplibregl-ctrl-hillshade";
    this._button.title = "Enable hillshade";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("id", "Line");
    svg.setAttribute("fill", "#000000");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("id", "primary");
    path.setAttribute("d", "M9.4,13.61,13,21H4l3.6-7.39A1,1,0,0,1,9.4,13.61Zm5.48-2.09a1,1,0,0,0-1.76,0l-2.49,4.62L13,21h7ZM3,21H21M6,3A3,3,0,1,0,9,6,3,3,0,0,0,6,3Z");
    path.setAttribute("style", "fill:none;stroke:#000000;stroke-linecap:round;stroke-linejoin:round;stroke-width:1px");
    svg.appendChild(path);
    this._icon = document.createElement("span");
    this._icon.className = "maplibregl-ctrl-icon";
    this._icon.setAttribute("aria-hidden", "true");
    this._icon.appendChild(svg);
    this._button.appendChild(this._icon);

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
  const fmt = (variable, units) => {
    if (row === undefined) return "N/A";
    const v = valueAt(variable, row, state.timeIndex);
    return v !== undefined && v > -9998 ? `${v.toFixed(3)} ${units}` : "N/A";
  };
  document.getElementById("tooltipTitle").textContent = `wb-${id}`;
  document.getElementById("tooltipFlow").textContent = fmt("flow", "m³/s");
  document.getElementById("tooltipVelocity").textContent = fmt(
    "velocity",
    "m/s",
  );
  document.getElementById("tooltipDepth").textContent = fmt("depth", "m");
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
  const tooltip = document.getElementById("gageTooltip");
  tooltip.style.left = `${e.point.x + 15}px`;
  tooltip.style.top = `${e.point.y + 15}px`;
}

export function onGageLeave() {
  setGageHover(hoveredGageId, false);
  hoveredGageId = null;
  document.getElementById("gageTooltip").classList.remove("visible");
  map.getCanvas().style.cursor = "";
}

function setGageHover(id, hover) {
  if (id == null) return;
  map.setFeatureState({ ...GAGE_FEATURE, id }, { hover });
}

// Site number shows immediately; the official station name fills in once
// the (cached) lookup resolves, provided this gage is still the hovered one.
function showGageTooltip(feature) {
  const site = String(feature.properties.hl_uri || "").replace(/^gages-/, "");
  const tooltip = document.getElementById("gageTooltip");
  document.getElementById("gageTooltipTitle").textContent = `USGS-${site}`;
  const nameEl = document.getElementById("gageTooltipName");
  nameEl.textContent = `wb-${feature.properties.id}`;
  tooltip.classList.add("visible");
  map.getCanvas().style.cursor = "pointer";

  const id = feature.id;
  fetchGageName(site)
    .then((name) => {
      if (name && hoveredGageId === id) nameEl.textContent = name;
    })
    .catch(() => {});
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

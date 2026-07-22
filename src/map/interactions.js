// ====================================================================
// Map feature interactions: flowpath hover tooltip, click info panel,
// divide click -> upstream highlight.
// ====================================================================
import { state, map } from "../state.js";
import { HIDDEN_FILTER } from "../config.js";
import { valueAt } from "../data/access.js";
import { showFeatureInfo } from "../ui/infopanel.js";
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
  if (!state.data || !e.features?.length) return;
  showFeatureInfo(e.features[0]);
}

// ---- Upstream highlight (divide click) -----------------------------

export function clearUpstreamHighlight() {
  state.lastClickedDivide = null;
  map.setFilter("selected-divides", HIDDEN_FILTER);
  map.setFilter("upstream-divides", HIDDEN_FILTER);
}

export function onDivideClick(e) {
  if (!e.features?.length) return;
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

// ====================================================================
// Map feature interactions: flowpath hover tooltip, click info panel,
// divide click -> upstream highlight.
// ====================================================================
import { state, map } from "../state.js";
import { HIDDEN_FILTER } from "../config.js";
import { valueAt } from "../data/access.js";
import { showFeatureInfo } from "../ui/infopanel.js";

// maplibregl is a global provided by the CDN <script> in index.html.

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

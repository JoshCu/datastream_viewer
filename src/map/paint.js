// ====================================================================
// Map painting: results paint expression + per-reach feature-state
// ====================================================================
import { state, map } from "../state.js";
import { FLOWPATH_FEATURE } from "../config.js";
import {
  resultColorExpression,
  resultWidthExpression,
} from "../color/expressions.js";
import { valueAt } from "../data/access.js";
import { refreshTooltip } from "./interactions.js";
import { createStatePainter } from "./statepainter.js";

// Feature-state for only the reaches on screen (see map/statepainter.js).
// Feature-state persists once set, so panning to a new area (or a tile
// streaming in) just paints the reaches not yet done for this timestep; a
// variable or timestep change forces a full repaint of the on-screen set.
const painter = createStatePainter({
  layer: "flowpaths",
  feature: FLOWPATH_FEATURE,
  lookup: () => {
    if (!state.data) return null;
    const variable = state.variable;
    const t = state.timeIndex;
    return {
      index: state.data.index,
      key: variable + ":" + t,
      value: (row) => valueAt(variable, row, t),
    };
  },
  // Called across the paint ↔ interactions cycle, so only ever inside a function.
  after: () => refreshTooltip(),
});

export const updateFeatureStates = painter.update;
export const scheduleFeatureStateUpdate = painter.schedule;

// Called from the sourcedata handler when a flowpaths tile finishes loading.
export const scheduleTilePaint = painter.tileLoaded;

// The camera moved: requery the on-screen reaches once it settles.
export function invalidateResultsView() {
  painter.markViewDirty();
  painter.schedule();
}

// Set once per variable; timestep changes only touch feature-state.
export function applyResultsPaint() {
  if (!state.data || !map.getLayer("flowpaths")) return;

  if (!state.originalPaint) {
    state.originalPaint = {
      "line-color": map.getPaintProperty("flowpaths", "line-color"),
      "line-width": map.getPaintProperty("flowpaths", "line-width"),
    };
  }

  map.setPaintProperty(
    "flowpaths",
    "line-color",
    resultColorExpression(state.data, state.variable, state.scale),
  );
  map.setPaintProperty(
    "flowpaths",
    "line-width",
    resultWidthExpression(state.data, state.variable),
  );
}

// Restore the flowpaths layer to its pre-data appearance and drop every
// painting cache, so a later load starts from a clean slate instead of
// skipping ids this run already thinks it painted.
export function clearResultsPaint() {
  if (state.originalPaint && map.getLayer("flowpaths")) {
    map.setPaintProperty("flowpaths", "line-color", state.originalPaint["line-color"]);
    map.setPaintProperty("flowpaths", "line-width", state.originalPaint["line-width"]);
  }
  painter.reset();
  zoomQueued = false;
}

// Reaction to the active run changing: repaint for the new data, or restore
// the pre-data appearance when it was cleared. Registered in map/init.js.
export function syncPaintToDataset({ data, fitView }) {
  if (!data) {
    clearResultsPaint();
    return;
  }
  applyResultsPaint();
  // Force a full-viewport requery for the first paint: the run may already be
  // in view, so we can't rely on zoomToLoadedData moving the camera.
  painter.markViewDirty();
  painter.schedule();
  if (fitView) zoomToLoadedData();
}

// Best-effort fit to the loaded reaches once tiles settle.
let zoomQueued = false;
export function zoomToLoadedData() {
  if (zoomQueued || !state.data) return;
  zoomQueued = true;
  map.once("idle", () => {
    zoomQueued = false;
    if (state.data) fitToData(state.data);
  });
}

// Zoom level to back out to before fitting: wide enough that the flowpath
// tiles in view cover any run's extent (the initial map view is zoom 4).
const FIT_OVERVIEW_ZOOM = 4;

// The sidebar overlays the left of the map, so fitBounds has to bias the
// camera right by half of whatever the sidebar currently covers. Measured
// rather than hardcoded: the width lives in CSS (--sidebar-w) and the sidebar
// can be hidden entirely.
export function sidebarFitOffset() {
  const sidebar = document.querySelector(".sidebar");
  const width = sidebar && sidebar.classList.contains("hide")
    ? 0
    : (sidebar?.getBoundingClientRect().width ?? 0);
  return [width / 2, 0];
}

// Move the camera to frame every flowpath that `data` covers. Only tiles
// already fetched can be inspected, so when zoomed in past the overview
// level we first jump out to it, wait for those tiles to land, and then
// measure — otherwise a close-up view would only ever fit to the handful of
// reaches it happens to have loaded.
export function fitToData(data) {
  if (map.getZoom() > FIT_OVERVIEW_ZOOM) {
    map.jumpTo({ zoom: FIT_OVERVIEW_ZOOM });
    map.once("idle", () => fitToLoadedTiles(data));
  } else {
    fitToLoadedTiles(data);
  }
}

function fitToLoadedTiles(data) {
  const features = map.querySourceFeatures("flowpaths", {
    sourceLayer: "flowpaths",
  });
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let found = false;
  for (const feature of features) {
    if (!data.index.has(feature.id)) continue;
    const coords = feature.geometry.coordinates;
    const lines =
      feature.geometry.type === "MultiLineString" ? coords : [coords];
    for (const line of lines) {
      for (const [x, y] of line) {
        found = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (found)
    map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY],
      ],
      { padding: 60, maxZoom: 10, offset: sidebarFitOffset() },
    );
}

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

// Reaches whose feature-state is already set for the current
// (variable, timeIndex); lets tile-load repaints skip work they've done.
let paintedKey = null;
let paintedIds = new Set();

// Set once per variable; timestep changes only touch feature-state.
export function applyResultsPaint() {
  if (!state.data || !map.getLayer("flowpaths")) return;
  const bounds = state.data.bounds[state.variable];

  if (!state.originalPaint) {
    state.originalPaint = {
      "line-color": map.getPaintProperty("flowpaths", "line-color"),
      "line-width": map.getPaintProperty("flowpaths", "line-width"),
    };
  }

  map.setPaintProperty("flowpaths", "line-color", resultColorExpression(bounds));
  map.setPaintProperty("flowpaths", "line-width", resultWidthExpression(bounds));
}

// Only set feature-state for the reaches actually on screen. Feature-state
// persists once set, so panning to a new area (or a tile streaming in) just
// paints the reaches not yet done for this timestep. paintedIds resets
// whenever the variable or timestep changes, forcing a full repaint.
export function updateFeatureStates() {
  if (!state.data || !map.getLayer("flowpaths")) return;
  const { index } = state.data;
  const variable = state.variable;
  const t = state.timeIndex;

  const key = variable + ":" + t;
  if (key !== paintedKey) {
    paintedKey = key;
    paintedIds = new Set();
  }

  const features = map.queryRenderedFeatures({ layers: ["flowpaths"] });
  for (const feature of features) {
    const id = feature.id;
    if (paintedIds.has(id)) continue;
    const row = index.get(id);
    if (row === undefined) continue;
    map.setFeatureState(
      { ...FLOWPATH_FEATURE, id },
      { value: valueAt(variable, row, t) },
    );
    paintedIds.add(id);
  }
  refreshTooltip();
}

let featureStateUpdateQueued = false;
export function scheduleFeatureStateUpdate() {
  if (featureStateUpdateQueued) return;
  featureStateUpdateQueued = true;
  requestAnimationFrame(() => {
    featureStateUpdateQueued = false;
    updateFeatureStates();
  });
}

// Best-effort fit to the loaded reaches once tiles settle.
let zoomQueued = false;
export function zoomToLoadedData() {
  if (zoomQueued || !state.data) return;
  zoomQueued = true;
  map.once("idle", () => {
    zoomQueued = false;
    if (!state.data) return;
    const features = map.querySourceFeatures("flowpaths", {
      sourceLayer: "flowpaths",
    });
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let found = false;
    for (const feature of features) {
      if (!state.data.index.has(feature.id)) continue;
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
        { padding: 60, maxZoom: 10 },
      );
  });
}

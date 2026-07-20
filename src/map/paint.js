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

// Ids of the flowpaths currently on screen. Refreshed by a full
// queryRenderedFeatures only when state.viewDirty says the camera moved (once,
// at idle); otherwise reused as-is so a bare timestep change doesn't pay for a
// query every playback frame.
let renderedIds = new Set();

// Tiles that finished loading since the last paint, keyed by z/x/y (+wrap) to
// dedupe the repeat sourcedata events a single tile emits. Each holds the
// tile's geographic bbox so we can query just that footprint instead of the
// whole viewport — a full-screen query per streamed-in tile is what made
// panning lag.
let pendingTileBBoxes = new Map();

// Convert web-mercator normalized y (0..1) to latitude in degrees.
function mercatorYToLat(yNorm) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180) / Math.PI;
}

// Geographic bbox of a MapLibre tile from its OverscaledTileID. Returns null
// if the internal shape isn't what we expect, so callers can fall back.
function tileGeoBBox(tileID) {
  const c = tileID && tileID.canonical;
  if (!c || c.z == null) return null;
  const n = 2 ** c.z;
  const wrap = (tileID.wrap || 0) * 360;
  return {
    key: `${tileID.wrap || 0}/${c.z}/${c.x}/${c.y}`,
    west: (c.x / n) * 360 - 180 + wrap,
    east: ((c.x + 1) / n) * 360 - 180 + wrap,
    north: mercatorYToLat(c.y / n),
    south: mercatorYToLat((c.y + 1) / n),
  };
}

// Called from the sourcedata handler when a flowpaths tile finishes loading.
// Queues just that tile's footprint for painting on the next frame; if we
// can't read the tile coords, fall back to a full-viewport requery.
export function scheduleTilePaint(tileID) {
  const bbox = tileGeoBBox(tileID);
  if (bbox) pendingTileBBoxes.set(bbox.key, bbox);
  else state.viewDirty = true;
  scheduleFeatureStateUpdate();
}

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

  // queryRenderedFeatures is the expensive part, so keep the cached id set and
  // only query when the rendered set actually changed:
  //   - camera moved (state.viewDirty): one full-viewport query, at idle.
  //   - tiles streamed in: query just each tile's footprint, not the screen.
  // A bare timestep change (every playback frame) hits neither branch and just
  // rewrites feature-state values for the ids already cached.
  if (state.viewDirty) {
    state.viewDirty = false;
    pendingTileBBoxes.clear();
    renderedIds = new Set();
    for (const feature of map.queryRenderedFeatures({ layers: ["flowpaths"] }))
      renderedIds.add(feature.id);
  } else if (pendingTileBBoxes.size) {
    const bboxes = [...pendingTileBBoxes.values()];
    pendingTileBBoxes.clear();
    for (const b of bboxes) {
      const nw = map.project([b.west, b.north]);
      const se = map.project([b.east, b.south]);
      const region = [
        [Math.min(nw.x, se.x), Math.min(nw.y, se.y)],
        [Math.max(nw.x, se.x), Math.max(nw.y, se.y)],
      ];
      for (const feature of map.queryRenderedFeatures(region, {
        layers: ["flowpaths"],
      }))
        renderedIds.add(feature.id);
    }
  }

  for (const id of renderedIds) {
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

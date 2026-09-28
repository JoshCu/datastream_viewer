// ====================================================================
// On-screen feature-state painter.
//
// Writes one feature-state `value` per feature for only the features
// currently rendered in `layer`, and reruns incrementally as tiles stream in
// or the camera moves. Shared by the flowpath results (map/paint.js) and the
// catchment forcings (forcing/paint.js); each owns one painter.
//
// `lookup()` describes what to paint right now, or null for nothing:
//   { index: Map<featureId, row>, key: string, value(row) -> number }
// `key` identifies the current (variable, timestep); a change of key forces a
// full repaint of the on-screen set. `after()` runs at the end of each pass.
// ====================================================================
import { map } from "../state.js";

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

export function createStatePainter({ layer, feature, lookup, after }) {
  // What has already been painted for the current key. `paintedAll` means
  // every id in renderedIds is up to date; `pendingIds` holds the ids added
  // since then by a tile query. On a bare timestep change — the case that
  // runs every playback frame — everything must be repainted anyway, so
  // tracking individual ids there would be a full-size Set rebuild whose
  // every lookup is a guaranteed miss.
  let paintedKey = null;
  let paintedAll = false;
  const pendingIds = new Set();

  // Ids of the features currently on screen. Refreshed by a full
  // queryRenderedFeatures only when the camera moved (viewDirty, once, at
  // idle); otherwise reused as-is so a bare timestep change doesn't pay for a
  // query every playback frame.
  let renderedIds = new Set();
  let viewDirty = false;

  // Tiles that finished loading since the last paint, keyed by z/x/y (+wrap)
  // to dedupe the repeat sourcedata events a single tile emits. Each holds
  // the tile's geographic bbox so we can query just that footprint instead of
  // the whole viewport — a full-screen query per streamed-in tile is what
  // made panning lag.
  let pendingTileBBoxes = new Map();

  let queued = false;

  function update() {
    if (!map.getLayer(layer)) return;
    const src = lookup();
    if (!src) return;
    const { index, key, value } = src;

    if (key !== paintedKey) {
      paintedKey = key;
      paintedAll = false;
      pendingIds.clear();
    }

    // queryRenderedFeatures is the expensive part, so keep the cached id set
    // and only query when the rendered set actually changed:
    //   - camera moved (viewDirty): one full-viewport query, at idle.
    //   - tiles streamed in: query just each tile's footprint.
    // A bare timestep change hits neither branch and just rewrites
    // feature-state values for the ids already cached.
    if (viewDirty) {
      viewDirty = false;
      pendingTileBBoxes.clear();
      pendingIds.clear();
      paintedAll = false;
      renderedIds = new Set();
      for (const f of map.queryRenderedFeatures({ layers: [layer] })) renderedIds.add(f.id);
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
        for (const f of map.queryRenderedFeatures(region, { layers: [layer] })) {
          // Only ids the viewport didn't already have need painting.
          if (!renderedIds.has(f.id)) {
            renderedIds.add(f.id);
            pendingIds.add(f.id);
          }
        }
      }
    }

    // One descriptor reused for every feature: MapLibre reads
    // source/sourceLayer/id synchronously and doesn't retain it, so a fresh
    // object per feature per frame was pure garbage.
    const target = { ...feature, id: 0 };
    const paint = (ids) => {
      for (const id of ids) {
        const row = index.get(id);
        if (row === undefined) continue;
        target.id = id;
        map.setFeatureState(target, { value: value(row) });
      }
    };

    if (!paintedAll) {
      paint(renderedIds);
      paintedAll = true;
      pendingIds.clear();
    } else if (pendingIds.size) {
      paint(pendingIds);
      pendingIds.clear();
    }
    after?.();
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  }

  return {
    update,
    schedule,
    // The rendered set may have changed (camera moved, or a first paint whose
    // data may already be in view): requery the whole viewport next pass.
    markViewDirty() {
      viewDirty = true;
    },
    // A tile of the layer's source finished loading: queue just its
    // footprint for painting on the next frame; if we can't read the tile
    // coords, fall back to a full-viewport requery.
    tileLoaded(tileID) {
      const bbox = tileGeoBBox(tileID);
      if (bbox) pendingTileBBoxes.set(bbox.key, bbox);
      else viewDirty = true;
      schedule();
    },
    // The values behind the current key changed (rows were added): repaint
    // everything on screen next pass.
    invalidate() {
      paintedKey = null;
    },
    // Drop every cache, so a later dataset starts from a clean slate instead
    // of skipping ids this one already thinks it painted.
    reset() {
      paintedKey = null;
      paintedAll = false;
      pendingIds.clear();
      renderedIds = new Set();
      pendingTileBBoxes = new Map();
      viewDirty = false;
    },
  };
}

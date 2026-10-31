// ====================================================================
// Terrain edits: elevation deltas from erosion and the terrain brushes,
// shown by the map's 3D terrain and hillshade and routed by the flow field.
//
// Edits are kept per DEM tile at the zoom they were made at (the flow
// field's), as metres to add (data/workers/flowterrain.js). Edits at other
// zooms are resampled and summed, so an area edited at z12 and again at z14
// shows both at either zoom.
//
// The map: at the first edit, the raster-dem sources (FLOW_EDIT_SOURCES)
// are switched to the `flowdem://<source>/{z}/{x}/{y}` protocol. A tile with
// no edits over it is the source's own bytes, fetched as MapLibre would;
// an edited one comes from terrain.worker.js (decoded, edited, re-encoded).
// After each batch of edits the tiles MapLibre has that they touch are
// reloaded (map.refreshTiles). That only reloads tiles in view, so tiles
// cached out of view are remembered with the edit version they were served
// at and refreshed when the map stops moving over them again.
//
// The field: flow/field.js sends deltasFor() its box with every build; the
// callers that edit ask it to rebuild (rebuildFlowField).
// ====================================================================
import { map } from "../state.js";
import { FLOW_EDIT_SOURCES } from "../config.js";
import { deltaOverlaps } from "../data/workers/flowterrain.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const PROTOCOL = "flowdem";
// Edits are batched into one tile refresh at most this often.
const REFRESH_MS = 150;

const tiles = new Map(); // "z/tx/ty" -> { key, scale, x0, y0, size, d, version, box }
let version = 0;
let originals = null; // sourceId -> { url, encoding, tileSize }, from the first edit on
let installed = false; // the sources are on the protocol
const served = new Map(); // "source/z/x/y" -> edit version it was served at
let worker = null;
let nextId = 0;
const requests = new Map(); // id -> { resolve, reject }
let dirtyBox = null; // Mercator box of edits not yet refreshed
let refreshTimer = null;
const listeners = new Set();

export function onTerrainChange(fn) {
  listeners.add(fn);
}

// { tiles, version }: how much is edited.
export function terrainEdits() {
  return { tiles: tiles.size, version };
}

// The source's own tile template, once the map has been switched to the
// protocol (so the flow worker keeps fetching the originals).
export function demTemplate(sourceId) {
  return installed ? originals[sourceId].url : null;
}

// The edits over [x0, x0+w) × [y0, y0+h) at world size `scale` (pixels).
export function deltasFor(scale, x0, y0, w, h) {
  const out = [];
  for (const t of tiles.values()) {
    if (deltaOverlaps(t, scale, x0, y0, w, h)) {
      out.push({ scale: t.scale, x0: t.x0, y0: t.y0, size: t.size, d: t.d });
    }
  }
  return out;
}

const tileBox = (z, x, y) => {
  const n = 2 ** z;
  return { x0: x / n, y0: y / n, x1: (x + 1) / n, y1: (y + 1) / n };
};
const boxesMeet = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const union = (a, b) =>
  a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : b;

// Add `grid` (metres, w × h global pixels from x0, y0 at zoom z, of
// tileSize tiles) to the edits. False if it was all zero.
export function addTerrainDelta(z, tileSize, x0, y0, w, h, grid) {
  const T = tileSize;
  const changed = [];
  const v = ++version;
  for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + h - 1) / T); ty++) {
    for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + w - 1) / T); tx++) {
      const ax = Math.max(x0, tx * T), bx = Math.min(x0 + w, (tx + 1) * T);
      const ay = Math.max(y0, ty * T), by = Math.min(y0 + h, (ty + 1) * T);
      const key = `${z}/${tx}/${ty}`;
      let t = tiles.get(key);
      let any = false;
      for (let Y = ay; Y < by && !any; Y++) {
        for (let o = (Y - y0) * w + ax - x0, e = o + bx - ax; o < e; o++) {
          if (grid[o]) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;
      if (!t) {
        t = { key, scale: T * 2 ** z, x0: tx * T, y0: ty * T, size: T, d: new Float32Array(T * T), box: tileBox(z, tx, ty) };
        tiles.set(key, t);
      }
      for (let Y = ay; Y < by; Y++) {
        const src = (Y - y0) * w - x0;
        const dst = (Y - ty * T) * T - tx * T;
        for (let X = ax; X < bx; X++) t.d[dst + X] += grid[src + X];
      }
      t.version = v;
      changed.push(t);
      dirtyBox = union(dirtyBox, t.box);
    }
  }
  if (!changed.length) return false;
  // Installing sends every edit and reloads every tile itself.
  if (installed) {
    sendDeltas(changed);
    if (!refreshTimer) refreshTimer = setTimeout(refreshDirty, REFRESH_MS);
  } else {
    install();
  }
  for (const fn of listeners) fn();
  return true;
}

// To the terrain worker; posting copies them, so the store keeps adding
// into its own.
function sendDeltas(list) {
  getWorker().postMessage({
    type: "deltas",
    deltas: list.map((t) => ({ key: t.key, scale: t.scale, x0: t.x0, y0: t.y0, size: t.size, d: t.d })),
  });
}

// Drop every edit and put the map back on the sources' own tiles.
export function resetTerrain() {
  tiles.clear();
  version++;
  dirtyBox = null;
  clearTimeout(refreshTimer);
  refreshTimer = null;
  worker?.postMessage({ type: "clear" });
  if (installed) {
    installed = false;
    for (const id of FLOW_EDIT_SOURCES) map.getSource(id)?.setTiles([originals[id].url]);
    served.clear();
  }
  for (const fn of listeners) fn();
}

// ---- The map's tiles ----------------------------------------------------

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./terrain.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    const r = requests.get(data.id);
    if (!r) return;
    requests.delete(data.id);
    if (data.data) r.resolve(data.data);
    else r.reject(httpError(data.status ?? 500, data.error ?? "Edited DEM tile failed"));
  };
  return worker;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// The edit version of the newest edit over tile z/x/y (0 for none).
function tileVersion(z, x, y) {
  const box = tileBox(z, x, y);
  let v = 0;
  for (const t of tiles.values()) if (t.version > v && boxesMeet(t.box, box)) v = t.version;
  return v;
}

async function loadTile(params, abort) {
  const m = /^flowdem:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  const [, id, zs, xs, ys] = m;
  const z = +zs, x = +xs, y = +ys;
  const src = originals[id];
  const url = src.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  served.set(`${id}/${z}/${x}/${y}`, version);
  if (!tileVersion(z, x, y)) {
    const res = await fetch(url, { signal: abort.signal });
    if (!res.ok) throw httpError(res.status, `DEM tile ${res.status}: ${url}`);
    return { data: await res.arrayBuffer() };
  }
  const rid = nextId++;
  const data = await new Promise((resolve, reject) => {
    requests.set(rid, { resolve, reject });
    getWorker().postMessage({ type: "tile", id: rid, url, encoding: src.encoding, z, x, y });
  });
  return { data };
}

// Switch the sources to the protocol (the first edit). False if their
// TileJSON hasn't loaded yet; the edits still count for the field.
function install() {
  if (installed) return true;
  const found = {};
  for (const id of FLOW_EDIT_SOURCES) {
    const src = map.getSource(id);
    if (!src?.tiles?.length) return false;
    found[id] = { url: src.tiles[0], encoding: src.encoding ?? "mapbox", tileSize: src.tileSize ?? 512 };
  }
  if (!originals) maplibregl.addProtocol(PROTOCOL, loadTile);
  originals = found;
  installed = true;
  served.clear();
  sendDeltas([...tiles.values()]);
  // setTiles reloads every tile, so there's nothing to refresh.
  for (const id of FLOW_EDIT_SOURCES) map.getSource(id).setTiles([`${PROTOCOL}://${id}/{z}/{x}/{y}`]);
  dirtyBox = null;
  return true;
}

// Reload the tiles MapLibre has that `test` picks, per source.
function refreshWhere(test) {
  const bySource = new Map();
  for (const [key, v] of served) {
    const [id, z, x, y] = key.split("/");
    if (!test(+z, +x, +y, v)) continue;
    if (!bySource.has(id)) bySource.set(id, []);
    bySource.get(id).push({ z: +z, x: +x, y: +y });
  }
  for (const [id, list] of bySource) {
    try {
      map.refreshTiles(id, list);
    } catch {
      // The style was swapped out from under us.
    }
  }
}

function refreshDirty() {
  refreshTimer = null;
  if (!installed || !dirtyBox) return;
  const box = dirtyBox;
  dirtyBox = null;
  refreshWhere((z, x, y) => boxesMeet(tileBox(z, x, y), box));
}

// Tiles served before their latest edit (cached out of view while it
// happened) are refreshed once the map settles over them.
export function setupTerrainEdits() {
  map.on("moveend", () => {
    if (installed && tiles.size) refreshWhere((z, x, y, v) => v < tileVersion(z, x, y));
  });
}

// ====================================================================
// The flow field: which piece of the DEM to route, at what zoom, and when.
//
// The field is one mosaic over the view (plus a margin), at a zoom tied to
// the map's (flowState.detail below it, so a field cell is ~2 css px by
// default), stepped down until it fits FLOW_MAX_CELLS. With the camera
// pitched, the far ground is clipped a few screen-widths out, since it's
// sub-pixel anyway. The worker (flow.worker.js) fetches, mosaics and routes.
//
// A new view first gets a coarse field (two zooms down: a sixteenth of the
// cells, mostly ancestor tiles that are already cached) when the current one
// doesn't cover it, so particles appear at once, then the full-resolution
// one. Each request carries an epoch; a newer view supersedes older ones.
//
// Terrain edits (flow/terrain.js) go with every request, and an edit asks
// for the field it's on to be rebuilt (rebuildFlowField), from the same
// (cached) tiles.
// ====================================================================
import { map, flowState } from "../state.js";
import { FLOW_DEM_SOURCE, FLOW_MAX_ZOOM, FLOW_MAX_CELLS } from "../config.js";
import { demTemplate, deltasFor } from "./terrain.js";
// maplibregl is a global provided by the CDN <script> in index.html.

// Field extent past the visible ground, as a fraction of its size per side.
const MARGIN = 0.15;
// With pitch, ground further than this many screen-sizes from the centre is
// left out of the field.
const FAR_SCREENS = 1.5;
// Screen points unprojected to find the visible ground.
const PROBE_GRID = 12;
const COARSE_STEP = 2;
const DEBOUNCE_MS = 300;

let worker = null;
let epoch = 0;
let nextId = 0;
let installedId = -1;
let timer = null;
const pending = new Map(); // id -> { plan, coarse }
const fieldListeners = new Set();
const statusListeners = new Set();

export function onFlowField(fn) {
  fieldListeners.add(fn);
}

// fn({ kind: "loading" | "loaded" | "error" | "idle", text })
export function onFlowStatus(fn) {
  statusListeners.add(fn);
}

function status(kind, text) {
  for (const fn of statusListeners) fn({ kind, text });
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./flow.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = onMessage;
  worker.onerror = (e) => status("error", e.message || "Flow worker failed");
  return worker;
}

// The DEM source's tiles: { url, encoding, tileSize, maxzoom }, or null
// until its TileJSON has loaded. `url` is the source's own template even
// once the map draws edited tiles.
export function demSource() {
  const src = map.getSource(FLOW_DEM_SOURCE);
  if (!src?.tiles?.length) return null;
  return {
    url: demTemplate(FLOW_DEM_SOURCE) ?? src.tiles[0],
    encoding: src.encoding ?? "mapbox",
    tileSize: src.tileSize ?? 512,
    maxzoom: Math.min(src.maxzoom ?? FLOW_MAX_ZOOM, FLOW_MAX_ZOOM),
  };
}

// The visible ground as boxes in Mercator [0, 1] units, clipped FAR_SCREENS
// from the centre when the camera is pitched: { inner } is what's on
// screen, { outer } that plus the MARGIN a new field is built with, so a
// small move stays inside the field it already has.
function visibleBox() {
  const canvas = map.getCanvas();
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  const merc = (x, y) => {
    const ll = map.unproject([x, y]);
    return ll && maplibregl.MercatorCoordinate.fromLngLat(ll);
  };
  const c = merc(W / 2, H / 2);
  const c2 = merc(W / 2 + 100, H / 2);
  const perPx = Math.hypot(c2.x - c.x, c2.y - c.y) / 100;
  const reach = perPx * Math.max(W, H) * FAR_SCREENS;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= PROBE_GRID; i++) {
    for (let j = 0; j <= PROBE_GRID; j++) {
      const m = merc((i / PROBE_GRID) * W, (j / PROBE_GRID) * H);
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      let { x, y } = m;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d > reach) {
        x = c.x + ((x - c.x) * reach) / d;
        y = c.y + ((y - c.y) * reach) / d;
      }
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  const mx = (x1 - x0) * MARGIN;
  const my = (y1 - y0) * MARGIN;
  return {
    inner: { x0, x1, y0: Math.max(0, y0), y1: Math.min(1, y1) },
    outer: {
      x0: x0 - mx,
      x1: x1 + mx,
      y0: Math.max(0, y0 - my),
      y1: Math.min(1, y1 + my),
    },
  };
}

// `box` in global pixels at zoom z: { z, x0, y0, w, h }.
function boxAt(box, z, tileSize) {
  const world = tileSize * 2 ** z;
  const x0 = Math.floor(box.x0 * world);
  const y0 = Math.floor(box.y0 * world);
  return { z, x0, y0, w: Math.ceil(box.x1 * world) - x0, h: Math.ceil(box.y1 * world) - y0 };
}

// The zoom a field for the current view starts at: the map's, less
// flowState.detail.
export function fieldZoom(dem) {
  const tilesPerMapTile = 512 / dem.tileSize;
  const z = Math.round(map.getZoom() + Math.log2(tilesPerMapTile)) + flowState.detail;
  return Math.max(0, Math.min(dem.maxzoom, z));
}

// The field to build for `box`: at fieldZoom(), stepped down until it fits
// FLOW_MAX_CELLS.
function plan(dem, box) {
  for (let z = fieldZoom(dem); ; z--) {
    const p = boxAt(box, z, dem.tileSize);
    if (p.w * p.h <= FLOW_MAX_CELLS || z === 0) return p;
  }
}

// Does `f` (a field or plan) cover plan `p`'s box at the same zoom?
function covers(f, p) {
  return (
    f && f.z === p.z &&
    f.x0 <= p.x0 && f.y0 <= p.y0 &&
    f.x0 + f.w >= p.x0 + p.w && f.y0 + f.h >= p.y0 + p.h
  );
}

// The fraction of plan p's area that field f covers (any zoom).
function overlap(f, p) {
  if (!f) return 0;
  const k = 2 ** (p.z - f.z);
  const ax = Math.max(f.x0 * k, p.x0), bx = Math.min((f.x0 + f.w) * k, p.x0 + p.w);
  const ay = Math.max(f.y0 * k, p.y0), by = Math.min((f.y0 + f.h) * k, p.y0 + p.h);
  return bx > ax && by > ay ? ((bx - ax) * (by - ay)) / (p.w * p.h) : 0;
}

// The full-resolution plan last sent, while it's still worth waiting for
// (cleared if it fails, so the next move retries).
let lastPlan = null;
let fieldSummary = ""; // the installed field's status line
// The terrain was edited after the requests in flight were sent: rebuild
// once they've landed.
let rebuildAfterPending = false;

function send(dem, p, coarse, rebuild = false) {
  const id = nextId++;
  pending.set(id, { plan: p, coarse, rebuild });
  rebuildAfterPending = false;
  getWorker().postMessage({
    type: "field", epoch, id, ...p,
    url: dem.url, encoding: dem.encoding, tileSize: dem.tileSize,
    speedModel: flowState.speedModel, colorBy: flowState.colorBy,
    deltas: deltasFor(dem.tileSize * 2 ** p.z, p.x0, p.y0, p.w, p.h),
  });
}

// The terrain under the field was edited: route the same box again.
export function rebuildFlowField() {
  const f = flowState.field;
  const dem = demSource();
  if (!f || !dem || !flowState.active) return;
  if (pending.size) {
    rebuildAfterPending = true;
    return;
  }
  status("loading", "Rerouting the edited terrain…");
  send(dem, { z: f.z, x0: f.x0, y0: f.y0, w: f.w, h: f.h }, false, true);
}

// Build a field for the current view if the one we have (or have asked for)
// doesn't cover it. `force` rebuilds regardless (a detail change).
export function refreshFlowField(force = false) {
  clearTimeout(timer);
  timer = null;
  if (!flowState.active) return;
  const dem = demSource();
  const boxes = dem && visibleBox();
  if (!boxes) {
    // The style or the DEM's TileJSON hasn't loaded yet.
    map.once("idle", () => refreshFlowField(force));
    return;
  }
  const p = plan(dem, boxes.outer);
  // What's on screen, at the zoom a new field would be built at: if the
  // field we have (complete, at that zoom) or the one on its way covers it,
  // there's nothing to do.
  const onScreen = boxAt(boxes.inner, p.z, dem.tileSize);
  const field = flowState.field;
  if (!force && field?.complete && covers(field, onScreen)) {
    // Back inside it after asking for somewhere else: that answer would now
    // be for the wrong view. (A rebuild for an edit is still wanted.)
    const reqs = [...pending.values()];
    if (reqs.some((r) => !r.rebuild)) {
      cancel(fieldSummary);
      if (reqs.some((r) => r.rebuild)) rebuildFlowField();
    }
    return;
  }
  if (!force && covers(lastPlan, onScreen)) return;
  lastPlan = p;
  cancel();
  status("loading", `Routing ${(p.w * p.h / 1e6).toFixed(1)}M cells at z${p.z}…`);
  if (p.z >= COARSE_STEP && overlap(flowState.field, p) < 0.9) {
    const k = 2 ** COARSE_STEP;
    const x0 = Math.floor(p.x0 / k), y0 = Math.floor(p.y0 / k);
    send(dem, {
      z: p.z - COARSE_STEP, x0, y0,
      w: Math.ceil((p.x0 + p.w) / k) - x0,
      h: Math.ceil((p.y0 + p.h) / k) - y0,
    }, true);
  }
  send(dem, p, false);
}

export function scheduleFlowField() {
  if (!flowState.active) return;
  clearTimeout(timer);
  timer = setTimeout(refreshFlowField, DEBOUNCE_MS);
}

// Drop every request in flight (the worker skips their routing too), and
// show `summary` as the status if given.
function cancel(summary) {
  epoch++;
  pending.clear();
  worker?.postMessage({ type: "cancel", epoch });
  if (summary) {
    lastPlan = null;
    status("loaded", summary);
  }
}

function onMessage({ data }) {
  const req = pending.get(data.id);
  if (data.epoch !== epoch || !req) return;
  pending.delete(data.id);
  if (rebuildAfterPending && !pending.size) queueMicrotask(rebuildFlowField);
  if (data.type === "error") {
    if (!req.coarse) lastPlan = null;
    status("error", data.error);
    return;
  }
  // The fine field can beat the coarse one (all its tiles cached).
  if (data.id < installedId || !flowState.active) return;
  installedId = data.id;
  const r = data.result;
  // A field missing tiles that failed to load is shown, but doesn't count as
  // covering its view, so the next move asks again.
  const complete = !req.coarse && !r.failed;
  if (!req.coarse && r.failed) lastPlan = null;
  const tileSize = demSource()?.tileSize ?? 512;
  flowState.field = { ...r, tileSize, scale: tileSize * 2 ** r.z, complete };
  for (const fn of fieldListeners) fn(flowState.field);
  if (req.coarse) {
    status("loading", `Coarse field ready, refining…`);
    return;
  }
  const notes = [
    r.fallback && `${r.fallback} from coarser tiles`,
    r.failed && `${r.failed} failed to load`,
  ].filter(Boolean);
  fieldSummary =
    `${r.w}×${r.h} cells at z${r.z} · ${r.tiles} tiles` +
    (notes.length ? ` (${notes.join(", ")})` : "") +
    ` · ${r.ms} ms`;
  status(r.failed ? "error" : "loaded", fieldSummary);
}

// Drop the field (the panel closed): nothing pending lands after this, and
// the worker goes, with its tile cache.
export function clearFlowField() {
  clearTimeout(timer);
  timer = null;
  epoch++;
  pending.clear();
  worker?.terminate();
  worker = null;
  lastPlan = null;
  flowState.field = null;
  status("idle", "Open to start");
}

// ====================================================================
// Flood inundation from a loaded run (report.md, Part 2): HAND over the
// view, computed in a flow worker, and per timestep a depth image
//   depth = stage[reach of cell] − HAND[cell]
// drawn on a canvas source (FIM_SOURCE), which drapes on the 3D terrain.
//
// - The field: the view plus a margin, in global pixels of the DEM source's
//   tiles at a zoom tied to the map's (FIM_MIN_ZOOM..FIM_MAX_ZOOM), stepped
//   down to fit FIM_MAX_CELLS. It's rebuilt after a move only if the view
//   has left it or the zoom it would be built at has changed.
// - The reaches burned in are every NWM flowline in the loaded tiles, so the
//   drainage is right even where the run has no data; only the run's reaches
//   get a stage (src/fim/stage.js, through the tiles' RouteLink channel).
//   Tiles thin short reaches below z12, so at lower map zooms a small
//   stream's cells drain to the next reach down.
// - An NWM run's stage is from flow / velocity. An ngen (hydrofabric) run's
//   reach is the outlet wb-N of each COMID (the NextGen ↔ NWM crosswalk,
//   data/nwm.js), and its stage is t-route's own depth where the run has it
//   (else flow / velocity), or flow / velocity by choice (setFimDepthFrom);
//   either way measured against the NWM channel.
// - The NWM tiles are read from an invisible layer (FIM_NWM_LOADER) on
//   their source, so they load whatever the NWM line layer's toggle says.
// - The worker is its own instance of flow/flow.worker.js (a "hand"
//   request), not the particle field's: that one comes and goes with the
//   flow panel. Its tiles are HTTP-cache hits once the map has drawn them.
// - The HAND field is computed once per view. Each timestep only computes
//   the per-reach stages and redraws the image, on the GPU when WebGL2 is
//   there (fim/gpupaint.js: HAND and reach numbers are textures, the stages
//   a small one), else in one CPU pass. The flooded area is counted once
//   the clock stops moving.
// ====================================================================
import { map, state } from "../state.js";
import {
  FIM_SOURCE,
  FIM_LAYER,
  FIM_MIN_ZOOM,
  FIM_MAX_ZOOM,
  FIM_MAX_CELLS,
  FIM_MAX_SIDE,
  FIM_NWM_LOADER,
  FLOOD_DEEP_M,
  FLOOD_SHALLOW_COLOR,
  FLOOD_DEEP_COLOR,
  FORCING_LAYER,
  REACH_SETS,
  isValid,
} from "../config.js";
import { valueAt, hasVariable } from "../data/access.js";
import { demSource, visibleBox, boxAt, newFlowWorker } from "../flow/field.js";
import { deltasFor } from "../flow/terrain.js";
import { onTimeChange } from "../ui/time.js";
import { onActiveDatasetChange } from "../data/sources.js";
import { ngenCrosswalk, outletWbOf } from "../data/nwm.js";
import { channelOf, stageFor, stageForDepth } from "./stage.js";
import { createGpuPainter } from "./gpupaint.js";

// Field extent past the view, as a fraction of its size per side. Small,
// because the flowlines are only read from tiles already loaded for the view.
const MARGIN = 0.1;
const DEBOUNCE_MS = 400;
const EARTH_CIRCUMFERENCE_M = 40075016.686;
// The flooded-area readout waits this long after the last repaint.
const AREA_DELAY_MS = 250;

let active = false;
let from = "bankfull"; // what the stage is measured from (stage.js)
// Where an ngen run's channel depth comes from: "troute" (its own `depth`)
// or "channel" (flow ÷ velocity through the NWM RouteLink channel, as for an
// NWM run).
let depthFrom = "troute";
let worker = null;
let epoch = 0;
let timer = null;
// The installed field: { z, x0, y0, w, h, tileSize, hand, reach, reaches,
// rows, rowsFor } — `reaches[k - 1]` is the reach burned in as number k:
// { comid, channel }; `rows` its row in `rowsFor` (the dataset), -1 if none.
let field = null;
let wanted = null; // the plan last sent, while it's in flight
let stage = null; // Float32Array(reaches + 1): this timestep's stage per reach number
let canvas = null; // the CPU painter's 2D canvas
let image = null; // the ImageData painted into canvas
let gpu; // fim/gpupaint.js painter, null when there's no WebGL2, undefined until tried
let gpuField = null; // the field gpu has as textures
let xwalk = null; // the NextGen crosswalk once loaded; a Promise while loading
let areaTimer = null;
let summary = "";
const statusListeners = new Set();

// fn({ kind: "loading" | "loaded" | "error" | "idle", text })
export function onFimStatus(fn) {
  statusListeners.add(fn);
}
function status(kind, text) {
  for (const fn of statusListeners) fn({ kind, text });
}

export function fimFrom() {
  return from;
}

// ---- Colour -----------------------------------------------------------

function parseRgba(css) {
  const [r, g, b, a = 1] = css.match(/[\d.]+/g).map(Number);
  return [r, g, b, a * 255];
}
// 256 depth steps from just under the surface to FLOOD_DEEP_M and beyond,
// packed for a little-endian Uint32 view of RGBA bytes.
const SHALLOW = parseRgba(FLOOD_SHALLOW_COLOR);
const DEEP = parseRgba(FLOOD_DEEP_COLOR);
const LUT = (() => {
  const a = SHALLOW;
  const b = DEEP;
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
    lut[i] = (c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  return lut;
})();

// ---- The field ---------------------------------------------------------

function getWorker() {
  if (worker) return worker;
  worker = newFlowWorker();
  worker.onmessage = onMessage;
  worker.onerror = (e) => status("error", e.message || "Flood worker failed");
  return worker;
}

// The box to build for the view, or { tooCoarse } when the map is zoomed
// out past FIM_MIN_ZOOM, or null before the DEM's TileJSON has loaded.
function plan(dem) {
  const boxes = visibleBox();
  if (!boxes) return null;
  const { inner } = boxes;
  const mx = (inner.x1 - inner.x0) * MARGIN;
  const my = (inner.y1 - inner.y0) * MARGIN;
  const outer = {
    x0: inner.x0 - mx,
    x1: inner.x1 + mx,
    y0: Math.max(0, inner.y0 - my),
    y1: Math.min(1, inner.y1 + my),
  };
  const top = Math.min(dem.maxzoom, FIM_MAX_ZOOM);
  const start = Math.min(top, Math.round(map.getZoom() + Math.log2(512 / dem.tileSize)));
  for (let z = start; z >= FIM_MIN_ZOOM; z--) {
    const p = boxAt(outer, z, dem.tileSize);
    if (p.w * p.h <= FIM_MAX_CELLS && p.w <= FIM_MAX_SIDE && p.h <= FIM_MAX_SIDE) {
      return { ...p, inner: boxAt(inner, z, dem.tileSize) };
    }
  }
  return { tooCoarse: true };
}

const covers = (f, p) =>
  f && f.z === p.z &&
  f.x0 <= p.inner.x0 && f.y0 <= p.inner.y0 &&
  f.x0 + f.w >= p.inner.x0 + p.inner.w && f.y0 + f.h >= p.inner.y0 + p.inner.h;

// Mercator [0, 1] → field cells.
function toCells(world, x0, y0) {
  return (lng, lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return [
      ((lng + 180) / 360) * world - x0,
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * world - y0,
    ];
  };
}

// Every NWM flowline in the loaded tiles, as burnLines() wants them, plus
// the reach table. A reach split across tiles is burned piece by piece
// under one number.
function collectLines(p, world) {
  const { feature } = REACH_SETS.nwm;
  const cell = toCells(world, p.x0, p.y0);
  const numberOf = new Map(); // comid -> reach number
  const reaches = [];
  const offsets = [0];
  const xy = [];
  const reach = [];
  const rank = [];
  for (const f of map.querySourceFeatures(feature.source, { sourceLayer: feature.sourceLayer })) {
    if (f.id == null) continue;
    let k = numberOf.get(f.id);
    if (k === undefined) {
      reaches.push({ comid: f.id, channel: channelOf(f.properties) });
      k = reaches.length;
      numberOf.set(f.id, k);
    } else if (!reaches[k - 1].channel) {
      reaches[k - 1].channel = channelOf(f.properties);
    }
    const g = f.geometry;
    const parts = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const part of parts) {
      if (!part.length) continue;
      for (const [lng, lat] of part) xy.push(...cell(lng, lat));
      offsets.push(xy.length / 2);
      reach.push(k);
      rank.push(+f.properties.order || 0);
    }
  }
  return {
    reaches,
    lines: {
      offsets: Int32Array.from(offsets),
      xy: Float32Array.from(xy),
      reach: Int32Array.from(reach),
      rank: Float32Array.from(rank),
    },
  };
}

// The invisible layer that keeps the NWM tiles loading while FIM is on.
function ensureLoader() {
  const { feature } = REACH_SETS.nwm;
  if (map.getLayer(FIM_NWM_LOADER) || !map.getSource(feature.source)) return false;
  map.addLayer({
    id: FIM_NWM_LOADER,
    type: "line",
    source: feature.source,
    "source-layer": feature.sourceLayer,
    minzoom: 7, // the channel attributes start at z7
    paint: { "line-opacity": 0 },
  });
  return true;
}

// Make sure the view's NWM tiles are loaded before reading them.
async function nwmTilesReady() {
  const { feature } = REACH_SETS.nwm;
  const added = ensureLoader();
  if (!added && map.isSourceLoaded(feature.source) && map.areTilesLoaded()) return;
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 30000);
    map.once("idle", () => {
      clearTimeout(t);
      resolve();
    });
    map.triggerRepaint();
  });
}

async function refresh(force = false) {
  clearTimeout(timer);
  timer = null;
  if (!active) return;
  const dem = demSource();
  const p = dem && plan(dem);
  if (!p) {
    map.once("idle", () => refresh(force));
    return;
  }
  if (p.tooCoarse) {
    status("idle", `Zoom in to map flooding (needs z${FIM_MIN_ZOOM - Math.log2(512 / dem.tileSize)}+)`);
    return;
  }
  if (!force && (covers(field, p) || covers(wanted, p))) return;
  wanted = p;
  const my = ++epoch;
  status("loading", "Loading NWM flowlines…");
  await nwmTilesReady();
  if (my !== epoch || !active) return;
  const world = dem.tileSize * 2 ** p.z;
  const { reaches, lines } = collectLines(p, world);
  if (!reaches.length) {
    wanted = null;
    status("error", "No NWM flowlines in view");
    return;
  }
  status("loading", `HAND for ${((p.w * p.h) / 1e6).toFixed(1)}M cells at z${p.z}, ${reaches.length.toLocaleString()} reaches…`);
  const { z, x0, y0, w, h } = p;
  getWorker().postMessage(
    {
      type: "hand", epoch: my, id: my, z, x0, y0, w, h,
      url: dem.url, encoding: dem.encoding, tileSize: dem.tileSize,
      deltas: deltasFor(world, x0, y0, w, h),
      lines,
    },
    [lines.offsets.buffer, lines.xy.buffer, lines.reach.buffer, lines.rank.buffer],
  );
  // Only the newest request is wanted; the worker drops the older ones.
  pendingReaches.clear();
  pendingReaches.set(my, { reaches, tileSize: dem.tileSize });
}
const pendingReaches = new Map(); // epoch -> { reaches, tileSize }

// A field arrives: a half-resolution preview first for a big one (the
// request stays pending), then the full one.
function onMessage({ data }) {
  const req = pendingReaches.get(data.id);
  const preview = data.type === "hand" && data.result?.preview;
  if (!preview) pendingReaches.delete(data.id);
  if (data.epoch !== epoch || !req || !active) return;
  if (data.type === "error") {
    wanted = null;
    status("error", data.error);
    return;
  }
  const r = data.result;
  // The preview doesn't count as covering the view; the full field will.
  if (!preview) wanted = null;
  field = { ...r, tileSize: req.tileSize, reaches: req.reaches, rows: null, rowsFor: null };
  summary =
    `${r.w}×${r.h} cells at z${r.z} · ${req.reaches.length.toLocaleString()} reaches · ${r.ms} ms` +
    (r.failed ? ` · ${r.failed} tiles failed` : "") +
    (preview ? " · refining…" : "");
  paint();
  if (preview) showArea();
}

export function scheduleFim() {
  if (!active) return;
  clearTimeout(timer);
  timer = setTimeout(refresh, DEBOUNCE_MS);
}

// ---- Painting ---------------------------------------------------------

// The NextGen crosswalk, or null while it loads (paint() reruns when it
// lands).
function crosswalk() {
  if (xwalk && !(xwalk instanceof Promise)) return xwalk;
  if (!xwalk) {
    status("loading", "Loading the NextGen ↔ NWM crosswalk (2.4 MB, once)…");
    xwalk = ngenCrosswalk().then(
      (table) => {
        xwalk = table;
        paint();
      },
      (err) => {
        xwalk = null;
        status("error", `Crosswalk: ${err.message ?? err}`);
      },
    );
  }
  return null;
}

// Each reach's row in the active run (-1 if it has none), rebuilt when the
// run changes; null while the crosswalk loads.
function rowsFor(data) {
  if (field.rowsFor === data) return field.rows;
  const rows = new Int32Array(field.reaches.length).fill(-1);
  const wbs = new Float64Array(field.reaches.length).fill(NaN);
  if (data.reaches === "nwm") {
    field.reaches.forEach((r, k) => {
      rows[k] = data.index.get(r.comid) ?? -1;
    });
  } else {
    const table = crosswalk();
    if (!table) return null;
    field.reaches.forEach((r, k) => {
      const wb = outletWbOf(table, r.comid);
      if (wb === undefined) return;
      wbs[k] = wb;
      rows[k] = data.index.get(wb) ?? -1;
    });
  }
  field.rows = rows;
  field.wbs = wbs;
  field.rowsFor = data;
  return rows;
}

// How the active run gives a stage ("depth" or "flowvel"), or { problem }
// if it can't.
function runMode(data) {
  if (!data) return { problem: "Load a run (NWM Forecast panel, or an ngen output) to map its flooding" };
  if (data.isDiff) return { problem: "A diff has no stage to map" };
  if (data.reaches === "grid") return { problem: "A gridded run has no reaches to map" };
  const flowVel = hasVariable("flow", data) && hasVariable("velocity", data);
  if (data.reaches === "nwm") {
    return flowVel ? { mode: "flowvel" } : { problem: "The run needs flow and velocity" };
  }
  if (depthFrom === "channel") {
    return flowVel ? { mode: "flowvel" } : { problem: "The run needs flow and velocity for a channel stage" };
  }
  if (hasVariable("depth", data)) return { mode: "depth" };
  return flowVel ? { mode: "flowvel" } : { problem: "The run needs depth, or flow and velocity" };
}

// This timestep's stage per reach number (NaN where there's none), or null
// with the reason.
function computeStage(data) {
  const n = field.reaches.length;
  const out = new Float32Array(n + 1).fill(NaN);
  const { mode, problem } = runMode(data);
  if (problem) return { stage: out, problem };
  const rows = rowsFor(data);
  if (!rows) return { stage: out, problem: "Loading the NextGen ↔ NWM crosswalk…", loading: true };
  const t = state.timeIndex;
  for (let k = 0; k < n; k++) {
    const row = rows[k];
    if (row < 0) continue;
    const ch = field.reaches[k].channel;
    if (mode === "depth") {
      const d = valueAt("depth", row, t, data);
      if (isValid(d)) out[k + 1] = stageForDepth(ch, d, from);
    } else {
      const q = valueAt("flow", row, t, data);
      const v = valueAt("velocity", row, t, data);
      if (isValid(q) && isValid(v)) out[k + 1] = stageFor(ch, q, v, from);
    }
  }
  return { stage: out, problem: null };
}

// The corners of the field as [lng, lat], clockwise from top left.
function corners(f) {
  const world = f.tileSize * 2 ** f.z;
  const ll = (gx, gy) => [
    (gx / world) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / world))) * 180) / Math.PI,
  ];
  return [
    ll(f.x0, f.y0),
    ll(f.x0 + f.w, f.y0),
    ll(f.x0 + f.w, f.y0 + f.h),
    ll(f.x0, f.y0 + f.h),
  ];
}

// The GPU painter, tried once.
function gpuPainter() {
  if (gpu === undefined) {
    gpu = createGpuPainter({ shallow: SHALLOW, deep: DEEP, deepM: FLOOD_DEEP_M, maxSide: FIM_MAX_SIDE });
  }
  return gpu;
}

// The source and layer, (re)added as needed (a basemap switch drops them).
// The source is made with whichever painter's canvas is in use.
function ensureLayer(el) {
  const coordinates = corners(field);
  const src = map.getSource(FIM_SOURCE);
  if (!src) {
    map.addSource(FIM_SOURCE, { type: "canvas", canvas: el, coordinates, animate: false });
  } else {
    src.setCoordinates(coordinates);
  }
  if (!map.getLayer(FIM_LAYER)) {
    map.addLayer(
      {
        id: FIM_LAYER,
        type: "raster",
        source: FIM_SOURCE,
        paint: { "raster-fade-duration": 0, "raster-resampling": "linear" },
      },
      // Under the rivers and catchment colours, like the flat flood layer.
      map.getLayer(FORCING_LAYER) ? FORCING_LAYER : undefined,
    );
  }
  map.setLayoutProperty(FIM_LAYER, "visibility", "visible");
  return map.getSource(FIM_SOURCE);
}

function hideLayer() {
  if (map.getLayer(FIM_LAYER)) map.setLayoutProperty(FIM_LAYER, "visibility", "none");
}

// The CPU fallback: one pass over the cells into a 2D canvas.
function paintCpu() {
  canvas ??= document.createElement("canvas");
  if (canvas.width !== field.w || canvas.height !== field.h) {
    canvas.width = field.w;
    canvas.height = field.h;
  }
  const ctx = canvas.getContext("2d");
  // Reused across timesteps (it's 4 bytes a cell).
  if (image?.width !== field.w || image?.height !== field.h) {
    image = ctx.createImageData(field.w, field.h);
  }
  const px = new Uint32Array(image.data.buffer);
  px.fill(0);
  const { hand, reach } = field;
  const scale = 255 / FLOOD_DEEP_M;
  for (let i = 0; i < hand.length; i++) {
    const d = stage[reach[i]] - hand[i]; // NaN for no reach / no stage
    if (d > 0) px[i] = LUT[d >= FLOOD_DEEP_M ? 255 : (d * scale) | 0];
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

// Redraw the depth image for the current timestep.
export function paint() {
  if (!active || !field) return;
  const { stage: next, problem, loading } = computeStage(state.data);
  stage = next;

  const painter = gpuPainter();
  let el;
  if (painter) {
    if (gpuField !== field) {
      painter.setField(field.w, field.h, field.hand, field.reach);
      gpuField = field;
    }
    painter.draw(stage);
    el = painter.canvas;
  } else {
    el = paintCpu();
  }
  const src = ensureLayer(el);
  // A non-animated canvas source uploads its texture in prepare(), which
  // pause() runs once.
  src.play();
  src.pause();
  map.triggerRepaint();

  clearTimeout(areaTimer);
  if (problem) {
    status(loading ? "loading" : "idle", problem);
    return;
  }
  areaTimer = setTimeout(showArea, AREA_DELAY_MS);
}

// The flooded area (from the field's middle row's cell size; Mercator's
// scale varies along it a little, and this is a readout, not a
// measurement) in the status, once the clock has stopped moving.
function showArea() {
  if (!active || !field || !stage) return;
  const { hand, reach } = field;
  let wet = 0;
  for (let i = 0; i < hand.length; i++) if (stage[reach[i]] - hand[i] > 0) wet++;
  const world = field.tileSize * 2 ** field.z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (field.y0 + field.h / 2)) / world)));
  const cellM = (EARTH_CIRCUMFERENCE_M * Math.cos(lat)) / world;
  const km2 = (wet * cellM * cellM) / 1e6;
  const how = gpu ? "GPU" : "CPU";
  status("loaded", `${km2 < 10 ? km2.toFixed(2) : Math.round(km2).toLocaleString()} km² flooded · ${summary} · ${how}`);
}

// ---- Hover readout ----------------------------------------------------

// What the field says at a point: { comid, wb, hand, stage, depth } (`wb`
// the ngen run's outlet flowpath, else NaN; stage and depth NaN without a
// run value), or null off the field / off any reach.
export function fimAt(lngLat) {
  if (!active || !field) return null;
  const world = field.tileSize * 2 ** field.z;
  const [cx, cy] = toCells(world, field.x0, field.y0)(lngLat.lng, lngLat.lat);
  const x = Math.floor(cx);
  const y = Math.floor(cy);
  if (x < 0 || y < 0 || x >= field.w || y >= field.h) return null;
  const i = y * field.w + x;
  const k = field.reach[i];
  if (!k) return null;
  const s = stage ? stage[k] : NaN;
  return {
    comid: field.reaches[k - 1].comid,
    wb: field.rowsFor === state.data && field.wbs ? field.wbs[k - 1] : NaN,
    hand: field.hand[i],
    stage: s,
    depth: s - field.hand[i],
  };
}

// ---- On / off ---------------------------------------------------------

export function setFimActive(on) {
  if (on === active) return;
  active = on;
  if (on) {
    refresh();
    if (field) paint();
    return;
  }
  clearTimeout(timer);
  timer = null;
  epoch++;
  wanted = null;
  pendingReaches.clear();
  worker?.terminate(); // and its tile cache
  worker = null;
  field = null;
  gpuField = null;
  stage = null;
  image = null;
  clearTimeout(areaTimer);
  hideLayer();
  if (map.getLayer(FIM_NWM_LOADER)) map.removeLayer(FIM_NWM_LOADER);
  status("idle", "Off");
}

// Called once at startup (ui/floodpanel.js).
export function setupFim() {
  onTimeChange(() => paint());
  onActiveDatasetChange(() => paint());
  map.on("moveend", scheduleFim);
  // A basemap switch drops the runtime source; put the image back.
  map.on("style.load", () => paint());
}

export function setFimFrom(value) {
  from = value;
  paint();
}

// "troute" or "channel": how an ngen run's channel depth is found (an NWM
// run always uses its channel).
export function setFimDepthFrom(value) {
  depthFrom = value;
  paint();
}

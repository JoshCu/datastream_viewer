// ====================================================================
// Live Muskingum-Cunge routing over the reaches loaded on screen.
//
// Owns the wasm instance (src/vendor/mc_route, built from wasm/mc_route), the
// Network built from the flowpath tiles, the per-frame step loop, and the
// sidebar's Live Routing panel. See WASM_ROUTING.md for the design.
//
// Painting follows map/paint.js's rule: the line paint expression is set once
// (here, a fixed log domain, since a live sim has no bounds to derive one
// from), and each frame only writes feature-state, for just the reaches whose
// flow changed (the wasm-side dirty list). The live sim is its own mode: it
// clears any loaded run on start and stops when one is loaded.
// ====================================================================
import init, { Network } from "../vendor/mc_route/mc_route.js";
import { state, map } from "../state.js";
import {
  FLOWPATH_FEATURE,
  PALETTE,
  RESULT_VALUE,
  SIM_DT,
  SIM_QLAT_DECAY,
  SIM_WET_Q,
  SIM_DIRTY_EPS,
  SIM_Q_DOMAIN,
  SIM_FRAME_BUDGET_MS,
  SIM_DRY_COLOR,
  SIM_S0,
  SIM_CHANNEL_BY_ORDER,
} from "../config.js";
import { resultColorStops } from "../color/expressions.js";
import { clearData } from "../data/loader.js";
import { setStatus } from "../ui/panels.js";

let wasm = null; // the instance's exports (for wasm.memory)
let wasmPromise = null;
let net = null;
// Zero-copy views onto the network's columns, plus wb id -> local index.
// Rebuilt after every Network.build(): growing wasm memory detaches them.
let views = null;
let running = false;
let rafId = null;
let stepsPerFrame = 4;
let simSeconds = 0;
let lastStepMs = 0;
let lastStatsAt = 0;
let originalPaint = null;
let rebuildTimer = null;

// One descriptor reused for every setFeatureState call (see map/paint.js).
const target = { ...FLOWPATH_FEATURE, id: 0 };

// Wait this long after the camera or tiles settle before rebuilding, so a
// burst of moveend/sourcedata events rebuilds once.
const REBUILD_DEBOUNCE_MS = 250;
// How often the panel's readouts refresh while running.
const STATS_INTERVAL_MS = 250;

function loadWasm() {
  wasmPromise ??= init().then((exports) => {
    wasm = exports;
  });
  return wasmPromise;
}

// ---- Building the network from the loaded tiles --------------------

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

function lineLengthM(geometry) {
  const lines =
    geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
  let total = 0;
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const [x0, y0] = line[k - 1];
      const [x1, y1] = line[k];
      const dLat = (y1 - y0) * RAD;
      const dLon = (x1 - x0) * RAD;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(y0 * RAD) * Math.cos(y1 * RAD) * Math.sin(dLon / 2) ** 2;
      total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
    }
  }
  return total;
}

// toid is the downstream wb number; tolerate a "wb-"/"nex-" style prefix.
function wbNumber(v) {
  if (typeof v === "number") return v;
  const n = parseInt(String(v ?? "").replace(/^\D+/, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

// One entry per reach from every loaded flowpaths tile (not just the rendered
// ones, which gives a free buffer around the viewport). A reach crossing tile
// boundaries comes back once per tile, each carrying the clipped piece of its
// geometry, so the pieces' lengths add up to the reach length.
function collectReaches() {
  const byId = new Map();
  const features = map.querySourceFeatures(FLOWPATH_FEATURE.source, {
    sourceLayer: FLOWPATH_FEATURE.sourceLayer,
  });
  for (const f of features) {
    if (f.id == null) continue;
    const len = lineLengthM(f.geometry);
    const reach = byId.get(f.id);
    if (reach) {
      reach.dx += len;
      continue;
    }
    const p = f.properties;
    byId.set(f.id, {
      toid: wbNumber(p.toid),
      up: Number(p.upstream_id) || 0,
      order: Number(p.order) || 1,
      dx: len,
    });
  }
  return byId;
}

function rebuild() {
  if (!state.simActive) return;
  const reaches = collectReaches();
  const n = reaches.size;
  const ids = new Uint32Array(n);
  const toids = new Uint32Array(n);
  const ups = new Uint32Array(n);
  const cols = ["dx", "n", "ncc", "s0", "bw", "tw", "twcc", "cs"];
  const c = Object.fromEntries(cols.map((k) => [k, new Float32Array(n)]));
  let i = 0;
  for (const [id, r] of reaches) {
    const ch =
      SIM_CHANNEL_BY_ORDER[Math.min(Math.max(r.order, 1), SIM_CHANNEL_BY_ORDER.length) - 1];
    ids[i] = id;
    toids[i] = r.toid;
    ups[i] = r.up;
    c.dx[i] = r.dx;
    c.n[i] = ch.n;
    c.ncc[i] = ch.n * 2;
    c.s0[i] = SIM_S0;
    c.bw[i] = ch.bw;
    c.tw[i] = ch.tw;
    c.twcc[i] = ch.tw * 3;
    c.cs[i] = ch.cs;
    i++;
  }

  // build() consumes the previous network (carrying its water over by id).
  net = Network.build(
    ids, toids, ups, c.dx, c.n, c.ncc, c.s0, c.bw, c.tw, c.twcc, c.cs, SIM_DT, net,
  );
  net.set_qlat_decay(SIM_QLAT_DECAY);
  // Reaches the old network had painted wet but this one dropped: clear them,
  // so if they re-enter later (as fresh, dry reaches) they don't show stale water.
  for (const id of net.take_orphans()) {
    target.id = id;
    map.removeFeatureState(target);
  }
  refreshViews();
  paintDirty();
  updateStats();
}

function refreshViews() {
  const len = net.len();
  const buf = wasm.memory.buffer;
  const ids = new Uint32Array(buf, net.ids_ptr(), len);
  const index = new Map();
  for (let i = 0; i < len; i++) index.set(ids[i], i);
  views = {
    ids,
    index,
    q: new Float32Array(buf, net.q_ptr(), len),
    velocity: new Float32Array(buf, net.velocity_ptr(), len),
    depth: new Float32Array(buf, net.depth_ptr(), len),
    qlat: new Float32Array(buf, net.qlat_ptr(), len),
  };
}

// Views onto wasm memory, recreated if memory grew since they were made.
function liveViews() {
  if (views && views.q.buffer !== wasm.memory.buffer) refreshViews();
  return views;
}

export function scheduleSimRebuild() {
  if (!state.simActive) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(function settle() {
    // Rebuild once the flowpath tiles have landed, rather than from half a set.
    if (!map.isSourceLoaded(FLOWPATH_FEATURE.source)) {
      rebuildTimer = setTimeout(settle, REBUILD_DEBOUNCE_MS);
      return;
    }
    rebuild();
  }, REBUILD_DEBOUNCE_MS);
}

// ---- Painting ------------------------------------------------------

const SIM_IS_WET = [">=", RESULT_VALUE, SIM_WET_Q];

function applySimPaint() {
  originalPaint = {
    "line-color": map.getPaintProperty("flowpaths", "line-color"),
    "line-width": map.getPaintProperty("flowpaths", "line-width"),
  };
  // resultColorStops only reads bounds (and isDiff) for a transform scale, so
  // a bounds-only stand-in gives the same log ramp as a loaded run's.
  const stops = resultColorStops({ bounds: { flow: SIM_Q_DOMAIN } }, "flow", "log");
  const lo = Math.log10(SIM_Q_DOMAIN.min);
  const hi = Math.log10(SIM_Q_DOMAIN.max);
  map.setPaintProperty("flowpaths", "line-color", ["case", SIM_IS_WET, stops, SIM_DRY_COLOR]);
  // Dry reaches keep the basemap's order-based width (it has no zoom
  // dependence, so it can nest inside a feature-state case).
  map.setPaintProperty("flowpaths", "line-width", [
    "case",
    SIM_IS_WET,
    ["interpolate", ["linear"], ["log10", ["max", RESULT_VALUE, SIM_Q_DOMAIN.min]], lo, 2, hi, 8],
    originalPaint["line-width"],
  ]);
}

function restorePaint() {
  if (!originalPaint || !map.getLayer("flowpaths")) return;
  map.setPaintProperty("flowpaths", "line-color", originalPaint["line-color"]);
  map.setPaintProperty("flowpaths", "line-width", originalPaint["line-width"]);
  originalPaint = null;
}

// Write feature-state for just the reaches whose flow moved since last paint.
function paintDirty() {
  const count = net.collect_dirty(SIM_DIRTY_EPS);
  if (!count) return;
  const { ids, q } = liveViews();
  const dirty = new Uint32Array(wasm.memory.buffer, net.dirty_ptr(), count);
  for (let k = 0; k < count; k++) {
    const i = dirty[k];
    target.id = ids[i];
    map.setFeatureState(target, { value: q[i] });
  }
}

// ---- The step loop -------------------------------------------------

function frame(now) {
  rafId = requestAnimationFrame(frame);
  const t0 = performance.now();
  let steps = 0;
  // Stop early once the frame budget is spent: a big wet network slows the
  // sim down instead of stalling the map.
  while (steps < stepsPerFrame) {
    net.step(1);
    steps++;
    if (performance.now() - t0 > SIM_FRAME_BUDGET_MS) break;
  }
  lastStepMs = (performance.now() - t0) / steps;
  simSeconds += steps * SIM_DT;
  paintDirty();
  if (now - lastStatsAt > STATS_INTERVAL_MS) updateStats();
}

function play() {
  if (running || !net) return;
  running = true;
  rafId = requestAnimationFrame(frame);
  syncControls();
}

function pause() {
  running = false;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  syncControls();
}

// ---- Public API (used by sim/brush.js) -----------------------------

// Called on start, stop, and every readout refresh (a few times a second while
// running), so the brush can drop out when the sim stops and keep its
// hovered-reach readout current without importing back into this module.
const updateListeners = new Set();
export function onSimUpdate(fn) {
  updateListeners.add(fn);
}

// Hold lateral inflow on the given reaches at (at least) `qlat` m³/s. Reaches
// not in the network (tiles that arrived since the last rebuild) are skipped.
export function depositQlat(reachIds, qlat) {
  if (!net) return;
  const v = liveViews();
  for (const id of reachIds) {
    const i = v.index.get(id);
    if (i !== undefined && v.qlat[i] < qlat) v.qlat[i] = qlat;
  }
}

// { q, velocity, depth, qlat } for one reach, or null if it isn't routed.
export function reachState(id) {
  if (!net) return null;
  const v = liveViews();
  const i = v.index.get(id);
  if (i === undefined) return null;
  return { q: v.q[i], velocity: v.velocity[i], depth: v.depth[i], qlat: v.qlat[i] };
}

// ---- Mode switching -------------------------------------------------

export async function startSim() {
  if (state.simActive) return;
  const btn = document.getElementById("simStartBtn");
  btn.disabled = true;
  setStatus("loading", "Loading routing kernel…", "sim");
  try {
    await loadWasm();
  } catch (err) {
    console.error("mc_route wasm failed to load:", err);
    setStatus("error", "Routing kernel failed to load", "sim");
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  if (!map.getLayer("flowpaths")) {
    setStatus("error", "Map is still loading", "sim");
    return;
  }

  // The sim owns the flowpaths paint and feature-state while it runs.
  clearData();
  map.removeFeatureState(FLOWPATH_FEATURE);
  applySimPaint();
  state.simActive = true;
  simSeconds = 0;
  rebuild();
  // Tiles may still be streaming in; pick them up once they land.
  scheduleSimRebuild();
  setStatus("success", "Running", "sim");
  play();
}

export function stopSim() {
  if (!state.simActive) return;
  pause();
  clearTimeout(rebuildTimer);
  state.simActive = false;
  net?.free();
  net = null;
  views = null;
  map.removeFeatureState(FLOWPATH_FEATURE);
  restorePaint();
  setStatus("idle", "Stopped", "sim");
  updateStats();
  syncControls();
}

// Reaction to the active run changing: loading a run ends the live sim, since
// both paint the same feature-state. Registered in map/init.js *before*
// syncPaintToDataset, so the sim restores the basemap paint first and the run's
// paint (and its saved original) is applied on top of that.
export function stopSimForDataset({ data }) {
  if (data) stopSim();
}

function resetWater() {
  if (!net) return;
  net.reset();
  simSeconds = 0;
  paintDirty();
  updateStats();
}

// ---- Panel ----------------------------------------------------------

function syncControls() {
  const active = state.simActive;
  document.getElementById("simStartBtn").textContent = active
    ? "Stop simulation"
    : "Start simulation";
  document.getElementById("simControls").style.display = active ? "" : "none";
  const pauseBtn = document.getElementById("simPauseBtn");
  pauseBtn.textContent = running ? "Pause" : "Resume";
  pauseBtn.classList.toggle("active", running);
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function updateStats() {
  lastStatsAt = performance.now();
  for (const fn of updateListeners) fn();
  const set = (id, text) => (document.getElementById(id).textContent = text);
  if (!net || !state.simActive) {
    for (const id of ["simReaches", "simWet", "simMaxQ", "simStepMs", "simTime"]) set(id, "-");
    return;
  }
  const { q } = liveViews();
  let wet = 0;
  let outflowMax = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] >= SIM_WET_Q) wet++;
    if (q[i] > outflowMax) outflowMax = q[i];
  }
  set("simReaches", net.len().toLocaleString());
  set("simWet", wet.toLocaleString());
  set("simStepMs", running ? lastStepMs.toFixed(2) : "-");
  set("simTime", `+${fmtDuration(simSeconds)}`);
  set("simMaxQ", outflowMax ? `${outflowMax.toFixed(2)} m³/s` : "-");
}

export function setupSimPanel() {
  document.getElementById("simStartBtn").addEventListener("click", () => {
    if (state.simActive) stopSim();
    else startSim();
  });
  document.getElementById("simPauseBtn").addEventListener("click", () => {
    if (running) pause();
    else play();
  });
  document.getElementById("simResetBtn").addEventListener("click", resetWater);

  const speed = document.getElementById("simSpeed");
  const speedValue = document.getElementById("simSpeedValue");
  const applySpeed = () => {
    stepsPerFrame = parseInt(speed.value, 10);
    speedValue.textContent = `${stepsPerFrame}×`;
  };
  speed.addEventListener("input", applySpeed);
  applySpeed();

  document.getElementById("simLegendGradient").style.background =
    `linear-gradient(to right, ${PALETTE.join(", ")})`;
  document.getElementById("simLegendMin").textContent = SIM_Q_DOMAIN.min;
  document.getElementById("simLegendMax").textContent = SIM_Q_DOMAIN.max;
  document.getElementById("simStepNote").textContent =
    `${SIM_DT / 60} min routing steps; each frame runs up to this many.`;
  syncControls();
}

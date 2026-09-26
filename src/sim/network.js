// ====================================================================
// Live Muskingum-Cunge routing over the reaches loaded on screen.
//
// Collects the reaches from the flowpath tiles, drives the per-frame step
// loop, paints the results, and owns the sidebar's Live Routing panel. The
// wasm Network itself (src/vendor/mc_route, built from wasm/mc_route) lives in
// sim.worker.js, so stepping runs off the main thread: each animation frame
// asks the worker for one batch of steps, with at most one batch in flight.
// See WASM_ROUTING.md for the design.
//
// Painting follows map/paint.js's rule: the line paint expression is set once
// (here, a fixed log domain, since a live sim has no bounds to derive one
// from), and each batch only writes feature-state, for just the reaches whose
// flow changed (the wasm-side dirty list, which the worker sends back). The
// live sim is its own mode: it clears any loaded run on start and stops when
// one is loaded.
// ====================================================================
import { state, map } from "../state.js";
import {
  FLOWPATH_FEATURE,
  PALETTE,
  RESULT_VALUE,
  SIM_DT,
  SIM_WET_Q,
  SIM_Q_DOMAIN,
  SIM_DRY_COLOR,
  SIM_S0,
  SIM_CHANNEL_BY_ORDER,
} from "../config.js";
import { resultColorStops } from "../color/expressions.js";
import { clearData } from "../data/loader.js";
import { setStatus } from "../ui/panels.js";

let worker = null;
let workerPromise = null;
// Bumped on every start and stop; the worker echoes it, so replies meant for a
// sim that has since stopped are dropped.
let epoch = 0;
let inFlight = false; // a step batch is out at the worker
// A step reply waiting for the next frame: its feature-state is written from
// the animation-frame callback, alongside MapLibre's render, because writing
// it from the message task costs the map ~30% of its frame rate.
let pendingReply = null;
let reachCount = 0;
let latestStats = null; // { wet, maxQ } from the worker's last report
// The hovered reach: its id, and { id, state } as last reported by the worker.
let hoverId = null;
let hover = null;
let probing = null; // id of an outstanding probe, so pointermoves don't spam
let running = false;
let rafId = null;
let stepsPerFrame = 4;
let simSeconds = 0;
let lastStepMs = 0;
// Steps counted over a rolling window for the steps/s readout; rate stays
// null until the first window closes after play().
let rateSteps = 0;
let rateWindowStart = 0;
let stepsPerSec = null;
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
// Window the steps/s readout averages over.
const RATE_WINDOW_MS = 1000;

function loadWorker() {
  workerPromise ??= new Promise((resolve, reject) => {
    const w = new Worker(new URL("./sim.worker.js", import.meta.url), { type: "module" });
    w.onmessage = ({ data }) => {
      if (data.type === "ready") {
        w.onmessage = onWorkerMessage;
        worker = w;
        resolve(w);
      } else if (data.type === "error") {
        reject(new Error(data.error));
      }
    };
    w.onerror = (e) => reject(new Error(e.message || "sim worker failed to start"));
  });
  return workerPromise;
}

function post(msg, transfer = []) {
  worker.postMessage({ ...msg, epoch }, transfer);
}

function onWorkerMessage({ data }) {
  if (data.epoch !== epoch || !state.simActive) return;
  if (data.type === "probe") {
    setHover(data.hover);
    notifyUpdate();
    return;
  }
  if (data.kind === "step") inFlight = false;
  if (data.kind === "step" && running) {
    pendingReply = data;
    return;
  }
  // Keep replies in order, so a rebuild's orphan clears land after the step
  // reply before it rather than being repainted by it.
  flushReply();
  applyReply(data);
}

function flushReply() {
  if (!pendingReply) return;
  const r = pendingReply;
  pendingReply = null;
  applyReply(r);
}

function applyReply(data) {
  if (data.kind === "step") {
    const now = performance.now();
    lastStepMs = data.stepMs;
    simSeconds += data.steps * SIM_DT;
    rateSteps += data.steps;
    if (now - rateWindowStart >= RATE_WINDOW_MS) {
      stepsPerSec = (rateSteps * 1000) / (now - rateWindowStart);
      rateSteps = 0;
      rateWindowStart = now;
    }
  }
  // Reaches the old network had painted wet but a rebuild dropped: clear them,
  // so if they re-enter later (as fresh, dry reaches) they don't show stale water.
  if (data.orphans) {
    for (const id of data.orphans) {
      target.id = id;
      map.removeFeatureState(target);
    }
  }
  paintDirty(data.ids, data.q);
  reachCount = data.len;
  setHover(data.hover);
  if (data.stats) {
    latestStats = data.stats;
    updateStats();
  }
}

function setHover(h) {
  if (h?.id === probing) probing = null;
  if (h) hover = h;
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

  // The worker's reply paints the result and clears orphaned feature-state.
  post({ type: "build", ids, toids, ups, cols: c, hover: hoverId }, [
    ids.buffer,
    toids.buffer,
    ups.buffer,
    ...Object.values(c).map((a) => a.buffer),
  ]);
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

// Write feature-state for just the reaches whose flow moved since last paint
// (parallel wb-id / q arrays from the worker).
function paintDirty(ids, q) {
  for (let k = 0; k < ids.length; k++) {
    target.id = ids[k];
    map.setFeatureState(target, { value: q[k] });
  }
}

// ---- The step loop -------------------------------------------------

// Each frame paints the last batch's reply and sends the next batch, which the
// worker steps while the map renders. Never more than one batch is out: if the
// worker is still busy, the sim slows down but the map doesn't. The worker
// caps a batch at SIM_FRAME_BUDGET_MS.
function frame() {
  rafId = requestAnimationFrame(frame);
  flushReply();
  if (inFlight) return;
  inFlight = true;
  post({
    type: "step",
    steps: stepsPerFrame,
    stats: performance.now() - lastStatsAt > STATS_INTERVAL_MS,
    hover: hoverId,
  });
}

function play() {
  if (running || !state.simActive) return;
  running = true;
  rateSteps = 0;
  rateWindowStart = performance.now();
  stepsPerSec = null;
  rafId = requestAnimationFrame(frame);
  syncControls();
}

function pause() {
  running = false;
  flushReply();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  syncControls();
}

// ---- Public API (used by sim/brush.js) -----------------------------

// Called on start, stop, every readout refresh (a few times a second while
// running), and when a hovered-reach probe answers, so the brush can drop out when the sim stops and keep its
// hovered-reach readout current without importing back into this module.
const updateListeners = new Set();
export function onSimUpdate(fn) {
  updateListeners.add(fn);
}

function notifyUpdate() {
  for (const fn of updateListeners) fn();
}

// Hold lateral inflow on the given reaches at (at least) `qlat` m³/s. Reaches
// not in the network (tiles that arrived since the last rebuild) are skipped.
export function depositQlat(reachIds, qlat) {
  if (!state.simActive) return;
  const ids = Uint32Array.from(reachIds);
  post({ type: "deposit", ids, qlat }, [ids.buffer]);
}

// { q, velocity, depth, qlat } for one reach, or null if it isn't routed.
// The state lives in the worker, so a reach not hovered before returns
// undefined while it's fetched; onSimUpdate fires once the answer is in.
// While running, every step batch refreshes the hovered reach's state.
export function reachState(id) {
  if (!state.simActive) return null;
  hoverId = id;
  if (hover?.id === id) return hover.state;
  if (probing !== id) {
    probing = id;
    post({ type: "probe", hover: id });
  }
  return undefined;
}

// ---- Mode switching -------------------------------------------------

export async function startSim() {
  if (state.simActive) return;
  const btn = document.getElementById("simStartBtn");
  btn.disabled = true;
  setStatus("loading", "Loading routing kernel…", "sim");
  try {
    await loadWorker();
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
  resetSession();
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
  post({ type: "free" });
  resetSession();
  map.removeFeatureState(FLOWPATH_FEATURE);
  restorePaint();
  setStatus("idle", "Stopped", "sim");
  updateStats();
  syncControls();
}

// Forget everything tied to the previous start, and orphan its in-flight replies.
function resetSession() {
  epoch++;
  inFlight = false;
  pendingReply = null;
  reachCount = 0;
  latestStats = null;
  hoverId = hover = probing = null;
}

// Reaction to the active run changing: loading a run ends the live sim, since
// both paint the same feature-state. Registered in map/init.js *before*
// syncPaintToDataset, so the sim restores the basemap paint first and the run's
// paint (and its saved original) is applied on top of that.
export function stopSimForDataset({ data }) {
  if (data) stopSim();
}

function resetWater() {
  if (!state.simActive) return;
  simSeconds = 0;
  post({ type: "reset", hover: hoverId }); // the reply repaints and updates stats
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
  // Lit while paused: the button is a call to resume.
  pauseBtn.classList.toggle("active", !running);
  // The map-bottom twins of these buttons (mobile, sidebar hidden).
  document.getElementById("simMapControls").classList.toggle("visible", active);
  const mapPlay = document.getElementById("simMapPlayBtn");
  mapPlay.classList.toggle("paused", !running);
  mapPlay.classList.toggle("active", !running);
  mapPlay.title = running ? "Pause simulation" : "Resume simulation";
}

function togglePlay() {
  if (running) pause();
  else play();
}

function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function updateStats() {
  lastStatsAt = performance.now();
  notifyUpdate();
  const set = (id, text) => (document.getElementById(id).textContent = text);
  if (!latestStats || !state.simActive) {
    for (const id of ["simReaches", "simWet", "simMaxQ", "simStepMs", "simStepsPerSec", "simTime"]) set(id, "-");
    return;
  }
  const { wet, maxQ: outflowMax } = latestStats;
  set("simReaches", reachCount.toLocaleString());
  set("simWet", wet.toLocaleString());
  set("simStepMs", running ? lastStepMs.toFixed(2) : "-");
  set("simStepsPerSec", running && stepsPerSec !== null ? Math.round(stepsPerSec).toLocaleString() : "-");
  set("simTime", `+${fmtDuration(simSeconds)}`);
  set("simMaxQ", outflowMax ? `${outflowMax.toFixed(2)} m³/s` : "-");
}

export function setupSimPanel() {
  document.getElementById("simStartBtn").addEventListener("click", () => {
    if (state.simActive) stopSim();
    else startSim();
  });
  for (const id of ["simPauseBtn", "simMapPlayBtn"]) {
    document.getElementById(id).addEventListener("click", togglePlay);
  }
  for (const id of ["simResetBtn", "simMapResetBtn"]) {
    document.getElementById(id).addEventListener("click", resetWater);
  }

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

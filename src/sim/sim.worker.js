// ====================================================================
// Live-routing worker (module worker).
//
// Owns the wasm instance and the Network, so stepping never competes with
// MapLibre for the main thread. sim/network.js collects the reaches from the
// tiles (that needs the map), ships their columns here, and drives the step
// loop one batch per animation frame; each reply carries just the reaches
// whose flow changed, as parallel wb-id / q arrays for feature-state.
//
// Protocol (every message carries the sender's `epoch`, echoed back so the
// main thread can drop replies meant for a sim it has since stopped):
//   in  { type: "build", ids, toids, ups, cols, hover }   columns transferred
//   in  { type: "step", steps, stats, hover }
//   in  { type: "deposit", ids, qlat }
//   in  { type: "reset", hover }
//   in  { type: "probe", hover }
//   in  { type: "forcing", ids, qlat, nTimes, dt, restart }   or ids: null to stop
//   in  { type: "free" }
//   out { type: "ready" } | { type: "error", error }   once, after wasm loads
//   out { type: "result", kind, epoch, steps, stepMs, ids, q, orphans,
//         len, stats, hover }   for build / step / reset
//   out { type: "probe", epoch, hover }
// `hover` in is a wb id (or null); out it is { id, state } with state
// { q, velocity, depth, qlat }, or null when the reach isn't routed.
// `stats` out is { wet, maxQ }, or null when not asked for.
// `forcing` out (on every result) is { index, loop } — the forcing interval
// the last step used and how many times the series has wrapped — or null.
// ====================================================================
import init, { Network } from "../vendor/mc_route/mc_route.js";
import {
  SIM_DT,
  SIM_QLAT_DECAY,
  SIM_WET_Q,
  SIM_DIRTY_EPS,
  SIM_FRAME_BUDGET_MS,
} from "../config.js";

let wasm = null;
let net = null;
// Zero-copy views onto the network's columns, plus wb id -> local index.
// Rebuilt after every Network.build(): growing wasm memory detaches them.
let views = null;
// Sim seconds since the start (or the last reset), advanced per step here so
// the forcing clock never depends on main-thread timing.
let clock = 0;
// Rain from forcings (sim/rain.js): per-reach lateral inflow (m³/s), one row
// of nTimes intervals of `dt` seconds per wb id, held as a floor on the
// reach's qlat before every step — the same "at least" rule as a brush
// deposit, so the brush still adds on top and qlat decays once rain stops.
// The series loops from `start` (a clock value). `local` maps the network's
// local index to its table row (or -1), rebuilt with every network.
let forcing = null;

const ready = init().then(
  (exports) => {
    wasm = exports;
    postMessage({ type: "ready" });
  },
  (err) => postMessage({ type: "error", error: String(err?.message ?? err) }),
);

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

function build({ ids, toids, ups, cols: c }) {
  // build() consumes the previous network (carrying its water over by id).
  net = Network.build(
    ids, toids, ups, c.dx, c.n, c.ncc, c.s0, c.bw, c.tw, c.twcc, c.cs, SIM_DT, net,
  );
  net.set_qlat_decay(SIM_QLAT_DECAY);
  refreshViews();
  mapForcing();
  return new Uint32Array(net.take_orphans());
}

// Run up to `steps` steps, stopping early once the budget is spent so a big
// wet network slows the sim down instead of delaying the next paint.
function step(steps) {
  const t0 = performance.now();
  let done = 0;
  while (done < steps) {
    applyForcing();
    net.step(1);
    clock += SIM_DT;
    done++;
    if (performance.now() - t0 > SIM_FRAME_BUDGET_MS) break;
  }
  return { steps: done, stepMs: (performance.now() - t0) / done };
}

function setForcing({ ids, qlat, nTimes, dt, restart }) {
  if (!ids) {
    forcing = null;
    return;
  }
  const rowOf = new Map();
  for (let r = 0; r < ids.length; r++) rowOf.set(ids[r], r);
  const start = restart || !forcing ? clock : forcing.start;
  forcing = { rowOf, qlat, nTimes, dt, start, local: null };
  mapForcing();
}

function mapForcing() {
  if (!forcing || !net) return;
  const { ids } = liveViews();
  const local = new Int32Array(ids.length);
  for (let i = 0; i < ids.length; i++) local[i] = forcing.rowOf.get(ids[i]) ?? -1;
  forcing.local = local;
}

// Which forcing interval the next step falls in, and how many loops so far.
function forcingPosition() {
  if (!forcing) return null;
  const k = Math.floor((clock - forcing.start) / forcing.dt);
  return { index: k % forcing.nTimes, loop: Math.floor(k / forcing.nTimes) };
}

function applyForcing() {
  if (!forcing?.local) return;
  const { index } = forcingPosition();
  const { local, nTimes, qlat: table } = forcing;
  const { qlat } = liveViews();
  for (let i = 0; i < local.length; i++) {
    const r = local[i];
    if (r < 0) continue;
    const v = table[r * nTimes + index];
    if (qlat[i] < v) qlat[i] = v;
  }
}

function deposit(ids, qlat) {
  const v = liveViews();
  for (const id of ids) {
    const i = v.index.get(id);
    if (i !== undefined && v.qlat[i] < qlat) v.qlat[i] = qlat;
  }
}

function stats() {
  const { q } = liveViews();
  let wet = 0;
  let maxQ = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] >= SIM_WET_Q) wet++;
    if (q[i] > maxQ) maxQ = q[i];
  }
  return { wet, maxQ };
}

function hoverState(id) {
  if (id == null) return null;
  const v = liveViews();
  const i = v.index.get(id);
  const state =
    i === undefined
      ? null
      : { q: v.q[i], velocity: v.velocity[i], depth: v.depth[i], qlat: v.qlat[i] };
  return { id, state };
}

// The reaches whose flow moved since they were last painted, copied out of
// wasm memory into buffers that can be transferred.
function dirty() {
  const count = net.collect_dirty(SIM_DIRTY_EPS);
  const { ids, q } = liveViews();
  const local = new Uint32Array(wasm.memory.buffer, net.dirty_ptr(), count);
  const outIds = new Uint32Array(count);
  const outQ = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const i = local[k];
    outIds[k] = ids[i];
    outQ[k] = q[i];
  }
  return { ids: outIds, q: outQ };
}

function reply(msg, { steps = 0, stepMs = 0, orphans = null, withStats = true } = {}) {
  const d = dirty();
  const transfer = [d.ids.buffer, d.q.buffer];
  if (orphans) transfer.push(orphans.buffer);
  postMessage(
    {
      type: "result",
      kind: msg.type,
      epoch: msg.epoch,
      steps,
      stepMs,
      ids: d.ids,
      q: d.q,
      orphans,
      len: net.len(),
      stats: withStats ? stats() : null,
      hover: hoverState(msg.hover),
      forcing: forcingPosition(),
    },
    transfer,
  );
}

onmessage = async ({ data: msg }) => {
  // Messages that land before the wasm is up wait here; they resume in
  // arrival order because they all await the same promise.
  await ready;
  if (!wasm) return;
  switch (msg.type) {
    case "build":
      reply(msg, { orphans: build(msg) });
      break;
    case "step":
      if (net) reply(msg, { ...step(msg.steps), withStats: msg.stats });
      break;
    case "deposit":
      if (net) deposit(msg.ids, msg.qlat);
      break;
    case "reset":
      clock = 0;
      if (forcing) forcing.start = 0;
      if (net) {
        net.reset();
        reply(msg);
      }
      break;
    case "probe":
      if (net) {
        postMessage({ type: "probe", epoch: msg.epoch, hover: hoverState(msg.hover) });
      }
      break;
    case "forcing":
      setForcing(msg);
      break;
    case "free":
      net?.free();
      net = null;
      views = null;
      forcing = null;
      clock = 0;
      break;
  }
};

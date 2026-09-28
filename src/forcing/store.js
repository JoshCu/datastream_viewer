// ====================================================================
// The loaded forcing run: a sparse, growable catchment store.
//
// Rows arrive in batches as the user loads a viewport, a VPU or a single
// clicked catchment, so unlike a t-route dataset the feature set isn't known
// up front — and preallocating every catchment of every file would cost
// hundreds of MB for a medium-range cycle. Catchments get a slot as they
// load, and the matrices grow by doubling.
//
// The run keeps the t-route dataset shape where it overlaps
// ({ matrices, nTimes, time, timeAbsolute, index, bounds, isDiff }), with
// matrix[slot * nTimes + t] and `index` mapping the numeric catchment id
// (cat-N → N, the divides tiles' feature id) to its slot. So valueAt,
// seriesAt, derived() and every color/* function work on it unchanged.
// Unloaded cells are FILL_VALUE, so isValid() already skips them.
// ====================================================================
import { FILL_VALUE } from "../config.js";
import { computeBounds } from "../data/workers/merge.js";

const MIN_CAPACITY = 1024;

// `variables`: the forcing variable names (Time excluded); `timeSeconds`: the
// shared clock, epoch seconds.
export function createForcingRun({ label, variables, timeSeconds }) {
  return {
    kind: "forcing",
    label,
    variables,
    nTimes: timeSeconds.length,
    time: Array.from(timeSeconds, (t) => t * 1000),
    timeAbsolute: true,
    index: new Map(),
    count: 0,
    capacity: 0,
    matrices: Object.fromEntries(variables.map((v) => [v, new Float32Array(0)])),
    bounds: {},
    isDiff: false,
  };
}

// Can rows from a file with these variables / steps join this run?
export function checkCompatible(run, variables, nTimes) {
  if (nTimes !== run.nTimes) {
    throw new Error(`File has ${nTimes} time steps; the loaded forcings have ${run.nTimes}`);
  }
  const missing = run.variables.filter((v) => !variables.includes(v));
  if (missing.length) throw new Error(`File is missing ${missing.join(", ")}`);
}

function ensureCapacity(run, need) {
  if (need <= run.capacity) return;
  let cap = Math.max(MIN_CAPACITY, run.capacity * 2);
  while (cap < need) cap *= 2;
  for (const v of run.variables) {
    const grown = new Float32Array(cap * run.nTimes);
    grown.fill(FILL_VALUE);
    grown.set(run.matrices[v]);
    run.matrices[v] = grown;
  }
  run.capacity = cap;
}

// Add rows: `catIds[k]` is the catchment of row k of every `blocks[v]`
// (Float32Array, k * nTimes + t). A catchment already present is overwritten.
export function addRows(run, catIds, blocks) {
  ensureCapacity(run, run.count + catIds.length);
  const n = run.nTimes;
  for (let k = 0; k < catIds.length; k++) {
    const id = catIds[k];
    let slot = run.index.get(id);
    if (slot === undefined) {
      slot = run.count++;
      run.index.set(id, slot);
    }
    for (const v of run.variables) {
      run.matrices[v].set(blocks[v].subarray(k * n, (k + 1) * n), slot * n);
    }
  }
  refreshBounds(run);
}

// Bounds and every derived() value depend on which rows are loaded, so both
// are recomputed after each batch (loads are user-triggered, never per frame).
function refreshBounds(run) {
  const used = run.count * run.nTimes;
  for (const v of run.variables) {
    run.bounds[v] = computeBounds(run.matrices[v].subarray(0, used));
  }
  if (run._derived) run._derived = new Map();
}

// ---- Change notifications --------------------------------------------
//
// { kind: "sources" } — the forcing files on offer changed (and any run was
//                       dropped with them)
// { kind: "run" }     — the run was created or cleared
// { kind: "rows" }    — rows were added to the run
// { kind: "time" }    — the forcing timestep changed
const listeners = new Set();

export function onForcingChange(fn) {
  listeners.add(fn);
}

export function emitForcingChange(kind) {
  for (const fn of listeners) fn({ kind });
}

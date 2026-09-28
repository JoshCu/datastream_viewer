// ====================================================================
// Forcing load orchestration.
//
// Forcing sources are files, one per VPU: an S3 cycle folder (fetched with
// Range requests) or dropped local files (read with Blob.slice). Nothing is
// fetched until asked for — "load viewport", "load VPU", or a clicked
// catchment — and every row is fetched at most once; the run caches it.
//
// DOM-free: callers own status reporting. Changes are announced through
// onForcingChange (forcing/store.js); the panel, plot and paint subscribe.
// ====================================================================
import { forcingState } from "../state.js";
import { FORCING_TIME_VAR, FORCING_VARIABLES, FORCING_WHOLE_FILE_FRACTION } from "../config.js";
import { runTask } from "../data/loader.js";
import { planRuns } from "../data/workers/forcing.js";
import { ensureLayout } from "./layout.js";
import { addRows, checkCompatible, createForcingRun, emitForcingChange } from "./store.js";
import { catchmentsInView, vpusInView, vpusNear } from "./viewport.js";
import { applyForcingPaint, clearForcingPaint } from "./paint.js";

const NOT_LOADED = 0;
const IN_FLIGHT = 1;
const LOADED = 2;

// VPU id from a forcing file name (…forcing.f001_f018.VPU_03N.nc → "03N").
export function vpuFromName(name) {
  return /VPU_(\d{2}[A-Z]?)\.nc/i.exec(name)?.[1]?.toUpperCase() ?? null;
}

// ---- Sources -----------------------------------------------------------

function replaceSources(entries, label) {
  dropRun();
  forcingState.files = new Map(entries.map((e) => [e.key, e]));
  forcingState.sourceLabel = label;
  emitForcingChange("sources");
}

// An S3 forcing cycle: `urls` are its VPU files. Nothing is fetched yet.
export function setForcingCycle(label, urls) {
  const entries = [];
  for (const url of urls) {
    const name = url.split("/").pop();
    const vpu = vpuFromName(name);
    if (vpu) entries.push({ key: vpu, vpu, label: name, source: { url } });
  }
  replaceSources(entries, label);
  return entries.length;
}

// Dropped local forcing files. Their layouts are read straight away (a
// local read), so the viewport loader knows which catchments each covers.
export async function setForcingFiles(files) {
  const entries = [...files].map((file, i) => ({
    key: `local:${i}:${file.name}`,
    vpu: vpuFromName(file.name),
    label: file.name,
    source: { file },
  }));
  replaceSources(entries, entries.map((e) => e.label).join(", "));
  await Promise.all(entries.map(ensureLayout));
}

export function clearForcings() {
  replaceSources([], null);
}

function dropRun() {
  if (!forcingState.run) return;
  forcingState.run = null;
  forcingState.timeIndex = 0;
  clearForcingPaint();
  emitForcingChange("run");
}

export function hasForcingSource() {
  return forcingState.files.size > 0;
}

// Files that may hold catchments in `vpus`: S3 files by VPU id, and every
// local file (a dropped file's name needn't say which VPU it is).
function candidates(vpus) {
  return [...forcingState.files.values()].filter((e) => e.source.file || vpus.has(e.vpu));
}

// ---- Loading rows ------------------------------------------------------

function forcingVariables(layout) {
  const names = Object.keys(layout.variables).filter((v) => v !== FORCING_TIME_VAR);
  // Known variables in panel order, then anything else in file order.
  const known = Object.keys(FORCING_VARIABLES).filter((v) => names.includes(v));
  return [...known, ...names.filter((v) => !known.includes(v))];
}

const unloaded = (entry, r) => entry.loaded[r] === NOT_LOADED && entry.catIds[r] >= 0;

// What fetching `rows` of `entry` (file rows) would take: the rows still to
// load, and the bytes / requests to get them (the worker makes the same
// merge decisions, data/workers/forcing.js planRuns). When the scattered rows
// would cost most of what fetching every remaining row would, the plan takes
// them all — that becomes a few whole contiguous variable blocks.
function planFile(entry, rows) {
  const todo = [...new Set(rows)].filter((r) => unloaded(entry, r)).sort((a, b) => a - b);
  if (!todo.length) return null;
  const variables = forcingVariables(entry.layout);
  const v0 = entry.layout.variables[variables[0]];
  const rowBytes = v0.shape[1] * Number(v0.dtype.slice(2));
  let plan = { todo, ...planRuns(Int32Array.from(todo), rowBytes) };

  const rest = [];
  for (let r = 0; r < entry.catIds.length; r++) if (unloaded(entry, r)) rest.push(r);
  if (rest.length > todo.length) {
    const whole = planRuns(Int32Array.from(rest), rowBytes);
    if (plan.bytes >= FORCING_WHOLE_FILE_FRACTION * whole.bytes) plan = { todo: rest, ...whole };
  }
  return {
    entry,
    todo: plan.todo,
    bytes: plan.bytes * variables.length,
    requests: plan.runs.length * variables.length,
  };
}

// Fetch a planned batch and add it to the run, creating the run from the
// first batch. Rows that got loaded since planning (a click in the meantime)
// are dropped rather than fetched twice. Resolves with the request stats.
function executePlan({ entry, todo: planned }) {
  const todo = planned.filter((r) => unloaded(entry, r));
  if (!todo.length) return Promise.resolve({ rows: 0, requests: 0, bytes: 0 });
  const variables = forcingVariables(entry.layout);
  const nTimes = entry.layout.variables[variables[0]].shape[1];
  if (forcingState.run) checkCompatible(forcingState.run, variables, nTimes);
  for (const r of todo) entry.loaded[r] = IN_FLIGHT;

  // Registered so a clicked catchment whose row is already on its way can
  // wait for this rather than fetch it again.
  const op = fetchAndAdd(entry, todo, variables).finally(() => entry.inflight.delete(op));
  entry.inflight ??= new Set();
  entry.inflight.add(op);
  return op;
}

function loadRows(entry, rows) {
  const plan = planFile(entry, rows);
  return plan ? executePlan(plan) : Promise.resolve({ rows: 0, requests: 0, bytes: 0 });
}

async function fetchAndAdd(entry, todo, variables) {
  try {
    const result = await runTask({
      type: "forcingRows",
      source: entry.source,
      variables: entry.layout.variables,
      rows: Int32Array.from(todo),
      withTime: !forcingState.run,
    });
    // The sources were swapped while this was in flight: drop it.
    if (forcingState.files.get(entry.key) !== entry) return { rows: 0, requests: 0, bytes: 0 };

    let created = false;
    if (!forcingState.run) {
      if (!result.time) throw new Error(`${entry.label} has no ${FORCING_TIME_VAR} variable`);
      forcingState.run = createForcingRun({
        label: forcingState.sourceLabel,
        variables,
        timeSeconds: result.time,
      });
      forcingState.timeIndex = 0;
      if (!variables.includes(forcingState.variable)) forcingState.variable = variables[0];
      created = true;
    } else {
      checkCompatible(forcingState.run, variables, result.nTimes);
    }
    const catIds = Array.from(result.rows, (r) => entry.catIds[r]);
    addRows(forcingState.run, catIds, result.blocks);
    for (const r of result.rows) entry.loaded[r] = LOADED;

    applyForcingPaint();
    if (created) emitForcingChange("run");
    emitForcingChange("rows");
    return { rows: todo.length, ...result.stats };
  } catch (err) {
    for (const r of todo) if (entry.loaded[r] === IN_FLIGHT) entry.loaded[r] = NOT_LOADED;
    throw err;
  }
}

function sumStats(list) {
  return list.reduce(
    (a, s) => ({ rows: a.rows + s.rows, requests: a.requests + s.requests, bytes: a.bytes + s.bytes }),
    { rows: 0, requests: 0, bytes: 0 },
  );
}

function noFileError(vpus) {
  return new Error(`No forcing file for ${vpus.size ? `VPU ${[...vpus].join(", ")}` : "this view"}`);
}

// A load, planned but not started, so the caller can check its size first:
//   { plans, bytes, requests, files, unmatched }
function summarise(plans, extra = {}) {
  plans = plans.filter(Boolean);
  return {
    plans,
    bytes: plans.reduce((a, p) => a + p.bytes, 0),
    requests: plans.reduce((a, p) => a + p.requests, 0),
    files: plans.length,
    ...extra,
  };
}

// Plan fetching every catchment rendered in the viewport, from whichever
// files hold them.
export async function planViewportLoad() {
  const cats = catchmentsInView();
  if (!cats.size) throw new Error("No catchments in view — zoom in closer");
  const vpus = vpusInView();
  const entries = candidates(vpus);
  if (!entries.length) throw noFileError(vpus);
  await Promise.all(entries.map(ensureLayout));

  const matched = new Set();
  const plans = entries.map((e) => {
    const rows = [];
    for (const id of cats) {
      const r = e.rowOf.get(id);
      if (r !== undefined) {
        rows.push(r);
        matched.add(id);
      }
    }
    return planFile(e, rows);
  });
  return summarise(plans, { unmatched: cats.size - matched.size });
}

// Plan fetching the whole forcing file of every VPU in view.
export async function planVpuLoad() {
  const vpus = vpusInView();
  const entries = candidates(vpus);
  if (!entries.length) throw noFileError(vpus);
  await Promise.all(entries.map(ensureLayout));
  return summarise(
    entries.map((e) => planFile(e, Array.from({ length: e.catIds.length }, (_, r) => r))),
  );
}

export async function runLoadPlan({ plans, unmatched = 0 }) {
  const stats = await Promise.all(plans.map(executePlan));
  return { ...sumStats(stats), files: plans.length, unmatched };
}

// Make sure catchment `id` is loaded, fetching just its row if not.
// `point` (screen px) narrows which VPU files could hold it. Resolves true
// when the catchment is in the run, false when no file has it.
export async function ensureCatchment(id, point) {
  if (forcingState.run?.index.has(id)) return true;
  let entries = candidates(point ? vpusNear(point) : vpusInView());
  if (!entries.length) entries = [...forcingState.files.values()];
  await Promise.all(entries.map(ensureLayout));
  const entry = entries.find((e) => e.rowOf.has(id));
  if (!entry) return false;
  const row = entry.rowOf.get(id);
  // Part of a load already under way: its result lands in the run.
  if (entry.loaded[row] === IN_FLIGHT) await Promise.allSettled(entry.inflight ?? []);
  if (entry.loaded[row] !== LOADED) await loadRows(entry, [row]);
  return !!forcingState.run?.index.has(id);
}

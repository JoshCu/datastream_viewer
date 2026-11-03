// ====================================================================
// NWM operational output: which files make up a run, what loading them
// costs, and the load itself. DOM-free; ui/nwmpanel.js drives it.
//
// A run is one file per valid hour on noaa-nwm-pds (CORS *, Range). Each
// file covers every CONUS reach, so the worker reads only the chunks the
// requested reaches fall in and returns those rows (data/workers/nwm.js).
// The rows come from the COMID list, which is the same in every file: it is
// read once (~0.7 MB) and cached in IndexedDB, keyed by its compressed size
// as a fingerprint that each hour's read re-checks.
//
// The result is an ordinary dataset on the NWM reach network
// (`reaches: "nwm"`) with flow and, optionally, velocity — no depth.
// ====================================================================
import {
  NWM_BASE,
  NWM_CONFIGS,
  NWM_VARIABLES,
  NWM_FETCH_CONCURRENCY,
} from "../config.js";
import { runTask, showAssembled } from "./loader.js";
import { computeBounds } from "./workers/merge.js";

const HOUR_MS = 3600 * 1000;
// Per-file metadata reads (superblock, headers, B-tree nodes), measured.
const META_BYTES = 115 * 1024;

// ---- File names ---------------------------------------------------------

const pad = (n, w) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;

function stepsOf(cfg, member) {
  return typeof cfg.steps === "function" ? cfg.steps(member) : cfg.steps;
}

// URL of one file. `cycle` is a Date at the cycle hour (UTC); `step` is the
// forecast hour, or null for an analysis tm00.
export function nwmFileUrl(configKey, cycle, member, step) {
  const cfg = NWM_CONFIGS[configKey];
  const m = String(member ?? 1);
  const folder = cfg.folder.replace("{m}", m);
  const file = cfg.file.replace("{m}", m);
  const suffix = step == null ? "tm00" : `f${pad(step, 3)}`;
  return (
    `${NWM_BASE}/nwm.${ymd(cycle)}/${folder}/` +
    `nwm.t${pad(cycle.getUTCHours(), 2)}z.${cfg.product}.${file}.${suffix}.conus.nc`
  );
}

// The run's files in time order: [{ url, validMs }]. Forecasts list every
// `stride`-th step of the cycle (always keeping the last); an analysis lists
// the tm00 file of each of the `hours` cycles ending at `cycle`.
export function nwmFiles({ config, cycle, member = 1, stride = 1, hours }) {
  const cfg = NWM_CONFIGS[config];
  const files = [];
  if (cfg.analysis) {
    const n = hours ?? cfg.hours;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (i % stride && i !== 0) continue;
      const c = new Date(cycle.getTime() - i * HOUR_MS);
      files.push({ url: nwmFileUrl(config, c, member, null), validMs: c.getTime() });
    }
    return files;
  }
  const { first, last, by } = stepsOf(cfg, member);
  for (let s = first, k = 0; s <= last; s += by, k++) {
    if (k % stride && s !== last) continue;
    files.push({ url: nwmFileUrl(config, cycle, member, s), validMs: cycle.getTime() + s * HOUR_MS });
  }
  return files;
}

async function exists(url) {
  try {
    return (await fetch(url, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

// The newest cycle whose last file is published, searching back from now
// (or from `before`). A cycle's files land over ~1–3 h, so checking the
// last one means the whole run is there. Null if none in `maxBack` cycles.
export async function latestNwmCycle(config, member = 1, { before = new Date(), maxBack = 8 } = {}) {
  const cfg = NWM_CONFIGS[config];
  const every = cfg.every * HOUR_MS;
  let t = Math.floor(before.getTime() / every) * every;
  for (let i = 0; i < maxBack; i++, t -= every) {
    const cycle = new Date(t);
    const files = nwmFiles({ config, cycle, member, stride: 1, hours: 1 });
    if (await exists(files.at(-1).url)) return cycle;
  }
  return null;
}

// ---- COMID → file row ---------------------------------------------------

const DB_NAME = "datastream-viewer-nwm";
const STORE = "tables";
const IDS_KEY = "conus-feature-id";

function openDb() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function dbGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function dbPut(key, value) {
  const db = await openDb();
  if (!db) return;
  db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
}

let idTable = null; // Promise<{ ids: Float64Array, fingerprint }>

// The sorted COMIDs of every CONUS channel_rt file, read from `url` the
// first time (then IndexedDB).
export function nwmFeatureIds(url) {
  if (!idTable) {
    idTable = (async () => {
      const cached = await dbGet(IDS_KEY);
      if (cached?.ids?.length) return cached;
      const { ids, fingerprint } = await runTask({ type: "nwmIds", url });
      dbPut(IDS_KEY, { ids, fingerprint, savedAt: Date.now() });
      return { ids, fingerprint };
    })();
    idTable.catch(() => {
      idTable = null;
    });
  }
  return idTable;
}

// Forget the cached table (an hour's read found a different reach list).
async function dropFeatureIds() {
  idTable = null;
  await dbPut(IDS_KEY, null);
}

// The table without a file in hand (the retrospective uses the same
// order): read it, if it isn't cached, from a short-range file six hours
// back, which is always published by then.
export function nwmFeatureTable() {
  const cycle = new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 6 * HOUR_MS);
  return nwmFeatureIds(nwmFileUrl("short_range", cycle, 1, 1));
}

// A COMID's row in the table, or -1.
export function nwmRowOf(ids, comid) {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ids[mid] < comid) lo = mid + 1;
    else hi = mid;
  }
  return ids[lo] === comid ? lo : -1;
}

// ---- NextGen crosswalk ----------------------------------------------------

const CROSSWALK_KEY = "ngen-nwm-crosswalk";
let crosswalk = null; // Promise<{ comids, wbs }>

// Each COMID's outlet hydrofabric flowpath (data/workers/crosswalk.js):
// { comids: Float64Array (ascending), wbs: Float64Array }. 2.4 MB the first
// time, then IndexedDB.
export function ngenCrosswalk() {
  if (!crosswalk) {
    crosswalk = (async () => {
      const cached = await dbGet(CROSSWALK_KEY);
      if (cached?.comids?.length) return cached;
      const table = await runTask({ type: "crosswalk" });
      dbPut(CROSSWALK_KEY, { ...table, savedAt: Date.now() });
      return table;
    })();
    crosswalk.catch(() => {
      crosswalk = null;
    });
  }
  return crosswalk;
}

// The N of the wb-N at a COMID's outlet, or undefined.
export function outletWbOf(table, comid) {
  const i = nwmRowOf(table.comids, comid);
  return i < 0 ? undefined : table.wbs[i];
}

// ---- Plan and load ------------------------------------------------------

const fileVariables = (variables) =>
  Object.fromEntries(variables.map((v) => [v, NWM_VARIABLES[v]]));

// What loading `comids` (null = every reach) over `files` will cost, before
// anything big is fetched: one file's metadata for the variables' sizes,
// plus the id table. { files, rows, comids, bytes, memoryBytes, fingerprint }.
// Chunks are 925,578 reaches each and the reaches of a view are scattered
// through them, so a subset rarely saves download, only memory.
export async function planNwmLoad({ files, variables, comids }) {
  if (!files.length) throw new Error("No files in this run");
  const { ids, fingerprint } = await nwmFeatureIds(files[0].url);
  let rows = null;
  let kept = null;
  if (comids) {
    const pairs = [];
    for (const c of new Set(comids)) {
      const r = nwmRowOf(ids, c);
      if (r >= 0) pairs.push(r);
    }
    pairs.sort((a, b) => a - b);
    rows = Int32Array.from(pairs);
    kept = Float64Array.from(rows, (r) => ids[r]);
  }
  const { sizes } = await runTask({
    type: "nwmSizes",
    url: files[0].url,
    variables: fileVariables(variables),
  });
  const perFile = META_BYTES + variables.reduce((n, v) => n + (sizes[v] ?? 0), 0);
  const nRows = rows ? rows.length : ids.length;
  return {
    files,
    variables,
    rows,
    comids: kept ?? ids,
    fingerprint,
    bytes: perFile * files.length,
    memoryBytes: nRows * files.length * 4 * variables.length,
  };
}

// Run a plan: every file across the worker pool (NWM_FETCH_CONCURRENCY at a
// time), assembled into feature-major matrices and promoted as the active
// run. Missing files (an incomplete cycle) are dropped from the time axis.
// `onProgress(done, total, bytes)` after each file. `fitView` frames the
// run (off by default: a view load is already framed).
export async function loadNwmRun(plan, { label, sourceKey = "nwm", onProgress, fitView = false } = {}) {
  const { files, variables, rows, comids, fingerprint } = plan;
  const nRows = comids.length;
  const results = new Array(files.length);
  let next = 0;
  let done = 0;
  let bytes = 0;
  let mismatch = false;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        const r = await runTask({
          type: "nwmHour",
          url: files[i].url,
          variables: fileVariables(variables),
          rows,
          fingerprint,
        });
        results[i] = r;
        bytes += r.stats.bytes;
      } catch (err) {
        if (/different reach list/.test(err.message)) mismatch = true;
        console.warn("NWM file skipped:", files[i].url, err);
      }
      onProgress?.(++done, files.length, bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(NWM_FETCH_CONCURRENCY, files.length) }, worker));
  if (mismatch) await dropFeatureIds();

  const hours = results
    .map((r, i) => r && { ...r, time: r.time ?? files[i].validMs })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
  if (!hours.length) {
    throw new Error(mismatch ? "The files' reach list changed; try again" : "None of the run's files could be read");
  }

  const nTimes = hours.length;
  const matrices = {};
  for (const v of variables) {
    if (!hours[0].values[v]) continue;
    const m = new Float32Array(nRows * nTimes);
    for (let t = 0; t < nTimes; t++) {
      const col = hours[t].values[v];
      for (let r = 0; r < nRows; r++) m[r * nTimes + t] = col[r];
    }
    matrices[v] = m;
  }
  const bounds = Object.fromEntries(Object.entries(matrices).map(([v, m]) => [v, computeBounds(m)]));
  const refMs = hours[0].refTime;
  const dataset = {
    time: hours.map((h) => h.time),
    timeAbsolute: true,
    nTimes,
    featureIds: comids,
    matrices,
    refTime: refMs != null ? new Date(refMs).toISOString() : undefined,
    reaches: "nwm",
  };
  showAssembled(sourceKey, label, dataset, bounds, { fitView });
  return { nTimes, nRows, bytes, missing: files.length - nTimes };
}

// ====================================================================
// Data load orchestration.
//
// Owns a pool of parse/merge workers, turns their output into the live
// in-memory model (state.data), and drives the initial paint. The parsed
// matrices are transferred out of the worker, so the main thread owns them
// from here on (feature-state painting reads them synchronously per frame).
// ====================================================================
import { state, s3State } from "../state.js";
import { VARIABLE_KEYS } from "../config.js";
import { listTrouteFileUrls } from "../s3/client.js";
import { stopPlayback } from "../ui/playback.js";
import { setStatus } from "../ui/panels.js";
import { registerSource, emitActiveDatasetChange } from "./sources.js";

// ---- Worker pool ---------------------------------------------------

// Bounded so we don't spawn one module worker per CONUS file.
const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 21);

let workers = [];
const idle = [];
const queue = [];
const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

// The parquet-wasm binary is 6.5MB. Rather than have every pooled worker fetch
// and compile it independently, compile it once here and hand the resulting
// WebAssembly.Module to each worker (structured-cloned across threads, with the
// compiled code shared — no re-download, no re-compile per worker). Kicked off
// eagerly at page load via preloadParquetWasm() so it overlaps with browsing.
const PARQUET_WASM_URL =
  "https://cdn.jsdelivr.net/npm/parquet-wasm@0.7.2/esm/parquet_wasm_bg.wasm";
let wasmModulePromise = null;

export function preloadParquetWasm() {
  if (!wasmModulePromise) {
    wasmModulePromise = WebAssembly.compileStreaming(
      fetch(PARQUET_WASM_URL),
    ).catch((err) => {
      // Non-fatal: workers fall back to fetching the binary themselves.
      console.warn("parquet-wasm preload failed; workers will self-load:", err);
      return null;
    });
  }
  return wasmModulePromise;
}

// Grow the pool to `want` workers (never past POOL_SIZE). A single-file load is
// one task and used to spin up every core's worth of workers, each paying the
// module-graph and wasm-handoff cost for nothing; CONUS still fans out fully
// because it queues every VPU file before pumping.
function ensurePool(want) {
  const target = Math.min(POOL_SIZE, Math.max(1, want));
  for (let i = workers.length; i < target; i++) {
    const w = new Worker(new URL("./workers/parse.worker.js", import.meta.url), {
      type: "module",
    });
    w.onmessage = (e) => onWorkerDone(w, e.data);
    w.onerror = (err) => onWorkerError(w, err);
    w._current = null;
    workers.push(w);
    idle.push(w);
    // Deliver the shared compiled module once ready. Message order per worker
    // is FIFO, and loadParquetWasm() awaits it, so a parse task dispatched
    // before this resolves still waits for the module rather than downloading.
    preloadParquetWasm().then((module) =>
      w.postMessage({ type: "initWasm", module }),
    );
  }
}

function pump() {
  ensurePool(queue.length + workers.length - idle.length);
  while (idle.length && queue.length) {
    const w = idle.pop();
    const task = queue.shift();
    w._current = task.message.id;
    w.postMessage(task.message, task.transfer);
  }
}

function settle(w, id, fn) {
  const p = pending.get(id);
  pending.delete(id);
  w._current = null;
  idle.push(w);
  pump();
  if (p) fn(p);
}

function onWorkerDone(w, data) {
  settle(w, data.id, (p) => {
    if (data.ok) p.resolve({ dataset: data.dataset, bounds: data.bounds });
    else p.reject(new Error(data.error));
  });
}

function onWorkerError(w, err) {
  if (w._current != null) {
    settle(w, w._current, (p) =>
      p.reject(new Error(err.message || "Worker error")),
    );
  }
}

// Run one worker task. `message` is cloned with an id attached; `transfer`
// lists ArrayBuffers to hand off.
function runTask(message, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    queue.push({ message: { ...message, id }, transfer });
    pump();
  });
}

// Which parser a name will go to, for status text. The extension is the only
// thing that decides it (see parse.worker.js), so this stays next to that rule.
export function formatLabel(name) {
  return name.toLowerCase().endsWith(".parquet") ? "Parquet" : "NetCDF";
}

// ---- Model promotion ----------------------------------------------

// Promote an already-normalized dataset (same shape as state.data: index,
// featureIds, matrices, bounds, ...) to the live in-memory model and paint
// it. Shared by freshly parsed files and by a computed diff between two
// already-loaded sources (data/diff.js), since both produce this shape.
// `fitView` controls whether the camera moves to frame the data; callers
// that swap datasets in place (the upload panel after its first load) pass
// false so the user's current view is left alone.
function promote(data, { fitView = true } = {}) {
  state.data = data;
  state.timeIndex = 0;
  // A diff's signed, symmetric-around-zero values don't suit the
  // magnitude-oriented transform scales, so it only permits linear. That's a
  // property of the dataset; the scale picker's own module enforces it.
  if (data.isDiff) state.scale = "linear";
  emitActiveDatasetChange({ data, fitView });
  return data;
}

// Normalize a freshly parsed worker dataset + precomputed bounds into the
// live-model shape and promote it.
function finalizeData(dataset, bounds, options) {
  const featureIds = Float64Array.from(dataset.featureIds);
  const index = new Map();
  for (let i = 0; i < featureIds.length; i++) index.set(featureIds[i], i);

  return promote(
    {
      isDiff: false,
      time: dataset.time,
      timeAbsolute: dataset.timeAbsolute,
      nTimes: dataset.nTimes,
      featureIds,
      index,
      matrices: dataset.matrices,
      bounds,
      refTime: dataset.refTime,
    },
    options,
  );
}

// Promote a dataset already computed by data/diff.js.
export function showDiff(diffData, options) {
  return promote(diffData, options);
}

// Drop the active dataset and restore the map to its pre-data appearance.
// Called when the file backing the currently displayed data is removed from
// the upload list.
export function clearData() {
  if (!state.data) return;
  stopPlayback();
  state.data = null;
  state.timeIndex = 0;
  emitActiveDatasetChange({ data: null, fitView: false });
}

// ---- Public entry points ------------------------------------------

// S3 loads share one hydrograph source slot: each replaces the last, just as
// it replaces the run on the map (uploaded files are kept individually).
const S3_SOURCE = "s3";

// Short hydrograph label for an S3 key or prefix: the run's
// "ngen.<date>/<range>/<cycle>/<VPU>" folders when present, else the last
// path segment.
function s3Label(path) {
  const segs = decodeURIComponent(path).split("/").filter(Boolean);
  const i = segs.findIndex((s) => /^ngen\.\d{8}$/.test(s));
  return i >= 0 ? segs.slice(i, i + 4).join("/") : segs.at(-1) || path;
}

// Load a single selected file.
export async function loadFile(url) {
  const btn = document.getElementById("loadBtn");

  btn.disabled = true;
  setStatus("loading", `Loading ${formatLabel(url)}...`);

  try {
    const { dataset, bounds } = await runTask({ type: "parse", url });
    registerSource(S3_SOURCE, s3Label(new URL(url).pathname), finalizeData(dataset, bounds));
    setStatus(
      "success",
      `Loaded ${state.data.featureIds.length} features × ${state.data.nTimes} steps`,
    );
  } catch (error) {
    setStatus("error", `Error: ${error.message}`);
    console.error("Load error:", error);
  } finally {
    btn.disabled = false;
  }
}

// Load a single local file (drag-drop or file-picker upload). The file is
// read into an ArrayBuffer on the main thread, then transferred into the
// worker pool for parsing — same finalizeData() path as an S3 load. DOM-free
// (unlike loadFile()/loadConus()) so the upload panel can manage status for
// several queued files at once; callers own reporting progress and errors.
export async function loadLocalFile(file, options) {
  const buffer = await file.arrayBuffer();
  const { dataset, bounds } = await runTask(
    { type: "parseLocal", buffer, filename: file.name },
    [buffer],
  );
  return finalizeData(dataset, bounds, options);
}

// Recursively load every VPU under the current cycle folder and merge.
export async function loadConus() {
  const conusBtn = document.getElementById("conusBtn");
  const loadBtn = document.getElementById("loadBtn");

  const vpuFolders = s3State.vpuFolders.slice();
  if (vpuFolders.length === 0) return;

  conusBtn.disabled = true;
  loadBtn.disabled = true;
  setStatus("loading", "Starting CONUS load...");

  try {
    // Resolve every VPU's t-route file urls.
    setStatus("loading", `Listing files across ${vpuFolders.length} VPUs...`);
    const urlLists = await Promise.all(
      vpuFolders.map((f) => listTrouteFileUrls(f.path).catch(() => [])),
    );
    const fileUrls = urlLists.flat();
    if (fileUrls.length === 0)
      throw new Error("No t-route output files found under any VPU");

    // Dispatch every file to the pool at once; the pool bounds concurrency.
    // Failed files are skipped rather than aborting the whole load.
    let done = 0;
    const results = await Promise.all(
      fileUrls.map((url) =>
        runTask({ type: "parse", url })
          .catch((error) => {
            console.warn("Skipping file (parse failed):", url, error);
            return null;
          })
          .finally(() => {
            setStatus("loading", `Loading VPU files ${++done} / ${fileUrls.length}...`);
          }),
      ),
    );
    const datasets = results.filter(Boolean).map((r) => r.dataset);
    if (datasets.length === 0) throw new Error("Failed to parse any VPU files");

    setStatus("loading", `Merging ${datasets.length} VPUs...`);
    const transfer = datasets.flatMap((d) =>
      VARIABLE_KEYS.map((v) => d.matrices[v]?.buffer).filter(Boolean),
    );
    const { dataset, bounds } = await runTask(
      { type: "merge", datasets },
      transfer,
    );
    registerSource(
      S3_SOURCE,
      `CONUS · ${s3Label(s3State.currentPath)}`,
      finalizeData(dataset, bounds),
    );

    setStatus(
      "success",
      `Loaded CONUS: ${state.data.featureIds.length} features × ${state.data.nTimes} steps (${datasets.length} VPUs)`,
    );
  } catch (error) {
    setStatus("error", `Error: ${error.message}`);
    console.error("CONUS load error:", error);
  } finally {
    conusBtn.disabled = false;
    loadBtn.disabled = !s3State.selectedFile;
  }
}

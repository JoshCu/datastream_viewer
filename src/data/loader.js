// ====================================================================
// Data load orchestration.
//
// Owns a pool of parse/merge workers, turns their output into the live
// in-memory model (state.data), and drives the initial paint. The parsed
// matrices are transferred out of the worker, so the main thread owns them
// from here on (feature-state painting reads them synchronously per frame).
// ====================================================================
import { state, s3State } from "../state.js";
import { listTrouteFileUrls } from "../s3/client.js";
import {
  applyResultsPaint,
  scheduleFeatureStateUpdate,
  zoomToLoadedData,
} from "../map/paint.js";
import { showDataPanels, updateDataInfo, updateLegend } from "../ui/panels.js";
import { updateTimeDisplay } from "../ui/time.js";

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

function ensurePool() {
  if (workers.length) return;
  for (let i = 0; i < POOL_SIZE; i++) {
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
  ensurePool();
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    queue.push({ message: { ...message, id }, transfer });
    pump();
  });
}

// ---- Model promotion ----------------------------------------------

// Promote a parsed dataset + precomputed bounds to the live in-memory model
// and paint it.
function finalizeData(dataset, bounds) {
  const nTimes = dataset.nTimes;
  const featureIds = Float64Array.from(dataset.featureIds);
  const index = new Map();
  for (let i = 0; i < featureIds.length; i++) index.set(featureIds[i], i);

  state.data = {
    isParquet: dataset.isParquet,
    time: dataset.time,
    nTimes,
    featureIds,
    index,
    matrices: {
      flow: dataset.flow,
      velocity: dataset.velocity,
      depth: dataset.depth,
    },
    bounds,
    refTime: dataset.refTime,
    totals: {},
  };
  state.timeIndex = 0;

  const slider = document.getElementById("timeSlider");
  slider.max = Math.max(0, nTimes - 1);
  slider.value = 0;

  updateDataInfo();
  showDataPanels();
  updateLegend();
  applyResultsPaint();
  // Force a full-viewport requery for the first paint: the run may already be
  // in view, so we can't rely on zoomToLoadedData moving the camera.
  state.viewDirty = true;
  scheduleFeatureStateUpdate();
  updateTimeDisplay();
  zoomToLoadedData();
}

// ---- Public entry points ------------------------------------------

// Load a single selected file.
export async function loadFile(url) {
  const btn = document.getElementById("loadBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  btn.disabled = true;
  statusDot.className = "status-dot loading";
  statusText.textContent =
    "Loading " + (url.endsWith(".parquet") ? "Parquet" : "NetCDF") + "...";

  try {
    const { dataset, bounds } = await runTask({ type: "parse", url });
    finalizeData(dataset, bounds);
    statusDot.className = "status-dot success";
    statusText.textContent = `Loaded ${state.data.featureIds.length} features × ${state.data.nTimes} steps`;
  } catch (error) {
    statusDot.className = "status-dot error";
    statusText.textContent = `Error: ${error.message}`;
    console.error("Load error:", error);
  } finally {
    btn.disabled = false;
  }
}

// Recursively load every VPU under the current cycle folder and merge.
export async function loadConus() {
  const conusBtn = document.getElementById("conusBtn");
  const loadBtn = document.getElementById("loadBtn");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");

  const vpuFolders = s3State.vpuFolders.slice();
  if (vpuFolders.length === 0) return;

  conusBtn.disabled = true;
  loadBtn.disabled = true;
  statusDot.className = "status-dot loading";

  try {
    // Resolve every VPU's t-route file urls.
    statusText.textContent = `Listing files across ${vpuFolders.length} VPUs...`;
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
            statusText.textContent = `Loading VPU files ${++done} / ${fileUrls.length}...`;
          }),
      ),
    );
    const datasets = results.filter(Boolean).map((r) => r.dataset);
    if (datasets.length === 0) throw new Error("Failed to parse any VPU files");

    statusText.textContent = `Merging ${datasets.length} VPUs...`;
    const transfer = datasets.flatMap((d) => [
      d.flow.buffer,
      d.velocity.buffer,
      d.depth.buffer,
    ]);
    const { dataset, bounds } = await runTask(
      { type: "merge", datasets },
      transfer,
    );
    finalizeData(dataset, bounds);

    statusDot.className = "status-dot success";
    statusText.textContent = `Loaded CONUS: ${state.data.featureIds.length} features × ${state.data.nTimes} steps (${datasets.length} VPUs)`;
  } catch (error) {
    statusDot.className = "status-dot error";
    statusText.textContent = `Error: ${error.message}`;
    console.error("CONUS load error:", error);
  } finally {
    conusBtn.disabled = false;
    loadBtn.disabled = !s3State.selectedFile;
  }
}

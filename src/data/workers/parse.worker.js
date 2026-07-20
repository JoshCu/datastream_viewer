// ====================================================================
// Parse/merge worker (module worker).
//
// Keeps NetCDF/Parquet decoding and the CONUS merge off the main thread.
// Heavy CDN libs are imported lazily on first use so a parquet-only session
// never pays for jsfive (and vice versa).
//
// Protocol (each message carries a correlation `id`):
//   in  { id, type: "parse", url }
//   in  { id, type: "merge", datasets }
//   out { id, ok: true,  dataset, bounds }
//   out { id, ok: false, error }
// Matrix buffers (flow/velocity/depth) are transferred, not copied.
// ====================================================================
import { parseNetCDF } from "./parsers/netcdf.js";
import { parseParquet } from "./parsers/parquet.js";
import { mergeDatasets, computeAllBounds } from "./merge.js";

let hdf5Promise = null;
let parquetWasmPromise = null;

// The main thread compiles the 6.5MB parquet-wasm binary once and ships the
// resulting WebAssembly.Module to every worker (structured-clone shares the
// compiled code across threads — no per-worker download). This promise resolves
// with that shared module, or null if preloading failed (fall back to a
// per-worker fetch via __wbg_init).
let resolveWasmModule;
const wasmModulePromise = new Promise((r) => {
  resolveWasmModule = r;
});

function loadHdf5() {
  if (!hdf5Promise) {
    hdf5Promise = import(
      "https://cdn.jsdelivr.net/npm/jsfive@0.3.10/+esm"
    ).then((mod) => mod.default ?? mod);
  }
  return hdf5Promise;
}

// parquet-wasm reads Parquet into an Arrow table in WASM memory; apache-arrow
// parses the transferred IPC stream on the JS side. The ESM build must have its
// WebAssembly module initialized before any API is called — here from the
// shared, precompiled module rather than a fresh download.
function loadParquetWasm() {
  if (!parquetWasmPromise) {
    parquetWasmPromise = Promise.all([
      import(
        "https://cdn.jsdelivr.net/npm/parquet-wasm@0.7.2/esm/parquet_wasm.js"
      ),
      import("https://cdn.jsdelivr.net/npm/apache-arrow@18.1.0/+esm"),
    ]).then(async ([pq, arrow]) => {
      const module = await wasmModulePromise;
      if (module) pq.initSync({ module });
      else await pq.default(); // preload failed: download per worker.
      return { readParquet: pq.readParquet, tableFromIPC: arrow.tableFromIPC };
    });
  }
  return parquetWasmPromise;
}

async function parse(url) {
  if (url.endsWith(".parquet")) {
    return parseParquet(url, await loadParquetWasm());
  }
  return parseNetCDF(url, await loadHdf5());
}

// Buffers to hand off when returning a dataset (avoids a structured-clone copy).
function transferListOf(dataset) {
  return ["flow", "velocity", "depth"]
    .map((v) => dataset[v]?.buffer)
    .filter(Boolean);
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  // One-shot handoff of the shared compiled wasm module; no reply expected.
  if (type === "initWasm") {
    resolveWasmModule(e.data.module ?? null);
    return;
  }
  try {
    let dataset;
    if (type === "parse") {
      dataset = await parse(e.data.url);
    } else if (type === "merge") {
      dataset = mergeDatasets(e.data.datasets);
    } else {
      throw new Error(`Unknown worker message type: ${type}`);
    }
    const bounds = computeAllBounds(dataset);
    self.postMessage({ id, ok: true, dataset, bounds }, transferListOf(dataset));
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message });
  }
};

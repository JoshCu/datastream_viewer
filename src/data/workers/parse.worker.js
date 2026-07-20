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
let hyparquetPromise = null;

function loadHdf5() {
  if (!hdf5Promise) {
    hdf5Promise = import(
      "https://cdn.jsdelivr.net/npm/jsfive@0.3.10/+esm"
    ).then((mod) => mod.default ?? mod);
  }
  return hdf5Promise;
}

function loadHyparquet() {
  if (!hyparquetPromise) {
    hyparquetPromise = Promise.all([
      import("https://cdn.jsdelivr.net/npm/hyparquet@1.6.3/src/hyparquet.js"),
      import("https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm"),
    ]).then(([hp, comp]) => ({
      parquetReadObjects: hp.parquetReadObjects,
      asyncBufferFromUrl: hp.asyncBufferFromUrl,
      compressors: comp.compressors,
    }));
  }
  return hyparquetPromise;
}

async function parse(url) {
  if (url.endsWith(".parquet")) {
    return parseParquet(url, await loadHyparquet());
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

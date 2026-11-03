// ====================================================================
// NetCDF4 / HDF5 parser (worker-side, pure).
//
// `hdf5` is the jsfive module, injected by the worker so this file has no
// direct CDN dependency and stays easy to reason about.
// ====================================================================
import { VARIABLE_KEYS, refTimeMillis } from "../../../config.js";
import { isGridFile, parseGridFile } from "./grid.js";

// Canonical dataset shape returned by every parser and consumed by
// mergeDatasets() and finalizeData():
//   { time:[...], timeAbsolute, nTimes, featureIds:[num...],
//     matrices: { <variable>: Float32Array },  // feature-major, nF*nTimes
//     refTime }
//
// `time` is absolute epoch milliseconds whenever the run's reference time is
// parseable (timeAbsolute: true). t-route's NetCDF clock is seconds since that
// reference, so the conversion belongs here, where refTime is in hand — every
// consumer then reads one unit instead of re-deriving it from the file format.
export async function parseNetCDF(url, hdf5) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  return parseNetCDFBuffer(arrayBuffer, hdf5, url);
}

// Same as parseNetCDF(), but for a buffer already in hand (e.g. a local file
// upload) rather than one that needs to be fetched. A qkrig grid (no
// feature_id; see grid.js) goes to its own parser; `filename` is its fallback
// for the hour.
export function parseNetCDFBuffer(arrayBuffer, hdf5, filename) {
  const file = new hdf5.File(arrayBuffer);
  if (isGridFile(file)) return parseGridFile(file, filename);

  const raw = Array.from(file.get("time")?.value || []);
  const featureIds = Array.from(file.get("feature_id")?.value || []).map(
    Number,
  );
  const toF32 = (v) =>
    v instanceof Float32Array ? v : Float32Array.from(v || []);

  // Without a parseable reference time there is no absolute clock; leave the
  // raw seconds in place and say so, rather than inventing an epoch.
  const refTime = file.attrs?.file_reference_time;
  const ref = refTimeMillis(refTime);
  const timeAbsolute = ref !== undefined;
  const time = timeAbsolute ? raw.map((t) => ref + t * 1000) : raw;

  return {
    time,
    timeAbsolute,
    nTimes: time.length,
    featureIds,
    // A variable the file doesn't have is left out, not an empty matrix.
    matrices: Object.fromEntries(
      VARIABLE_KEYS.flatMap((v) => {
        const value = file.get(v)?.value;
        return value ? [[v, toF32(value)]] : [];
      }),
    ),
    refTime,
  };
}

// ====================================================================
// NetCDF4 / HDF5 parser (worker-side, pure).
//
// `hdf5` is the jsfive module, injected by the worker so this file has no
// direct CDN dependency and stays easy to reason about.
// ====================================================================

// Canonical dataset shape returned by every parser and consumed by
// mergeDatasets() and finalizeData():
//   { isParquet, time:[...], nTimes, featureIds:[num...],
//     flow, velocity, depth  // Float32Array, feature-major, len == nF*nTimes
//     refTime }
export async function parseNetCDF(url, hdf5) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const arrayBuffer = await response.arrayBuffer();
  const file = new hdf5.File(arrayBuffer);

  const time = Array.from(file.get("time")?.value || []);
  const featureIds = Array.from(file.get("feature_id")?.value || []).map(
    Number,
  );
  const toF32 = (v) =>
    v instanceof Float32Array ? v : Float32Array.from(v || []);

  return {
    isParquet: false,
    time,
    nTimes: time.length,
    featureIds,
    flow: toF32(file.get("flow")?.value),
    velocity: toF32(file.get("velocity")?.value),
    depth: toF32(file.get("depth")?.value),
    refTime: file.attrs?.file_reference_time,
  };
}

// ====================================================================
// Parquet parser (worker-side, pure).
//
// `hyparquet` is { parquetReadObjects, asyncBufferFromUrl, compressors },
// injected by the worker.
// ====================================================================
import { FILL_VALUE } from "../../../config.js";

export async function parseParquet(url, hyparquet) {
  const { parquetReadObjects, asyncBufferFromUrl, compressors } = hyparquet;
  const asyncBuffer = await asyncBufferFromUrl({ url });
  const rows = await parquetReadObjects({ file: asyncBuffer, compressors });

  const timeSet = new Set();
  const featureSet = new Set();
  rows.forEach((r) => {
    const t = r.time instanceof Date ? r.time.getTime() : Number(r.time);
    timeSet.add(t);
    featureSet.add(Number(r.feature_id));
  });

  const sortedTimes = Array.from(timeSet).sort((a, b) => a - b);
  const sortedFeatureIds = Array.from(featureSet).sort((a, b) => a - b);
  const numTimes = sortedTimes.length;
  const numFeatures = sortedFeatureIds.length;

  const timeIndexMap = new Map(sortedTimes.map((t, i) => [t, i]));
  const featureIndexMap = new Map(sortedFeatureIds.map((id, i) => [id, i]));

  const alloc = () => {
    const a = new Float32Array(numFeatures * numTimes);
    a.fill(FILL_VALUE);
    return a;
  };
  const flow = alloc();
  const velocity = alloc();
  const depth = alloc();

  rows.forEach((r) => {
    const fi = featureIndexMap.get(Number(r.feature_id));
    const t = r.time instanceof Date ? r.time.getTime() : Number(r.time);
    const ti = timeIndexMap.get(t);
    if (fi === undefined || ti === undefined) return;
    const offset = fi * numTimes + ti;
    if (r.flow != null) flow[offset] = r.flow;
    if (r.velocity != null) velocity[offset] = r.velocity;
    if (r.depth != null) depth[offset] = r.depth;
  });

  return {
    isParquet: true,
    time: sortedTimes,
    nTimes: numTimes,
    featureIds: sortedFeatureIds,
    flow,
    velocity,
    depth,
  };
}

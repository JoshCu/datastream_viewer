// ====================================================================
// Parquet parser (worker-side, pure).
//
// `parquetWasm` is { readParquet, tableFromIPC }, injected by the worker.
// parquet-wasm decodes the file into an Arrow table living in WASM memory;
// `intoIPCStream()` hands it to apache-arrow's `tableFromIPC` as a JS-side
// columnar table we read column-at-a-time below.
// ====================================================================
import { FILL_VALUE } from "../../../config.js";

// apache-arrow's Timestamp vector getter already normalizes every unit
// (second / micro / nanosecond) to epoch milliseconds — get() returns a JS
// number in ms (or a Date), NOT the column's raw unit. So we must not re-scale
// by the declared unit; doing so collapsed every timestep onto ~the same
// instant, freezing the time readout. A plain numeric column is assumed ms.
function toMillis(v) {
  if (v instanceof Date) return v.getTime();
  return typeof v === "bigint" ? Number(v) : Number(v);
}

export async function parseParquet(url, parquetWasm) {
  const { readParquet, tableFromIPC } = parquetWasm;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const table = tableFromIPC(readParquet(bytes).intoIPCStream());

  const timeVec = table.getChild("time");
  const featureVec = table.getChild("feature_id");
  const flowVec = table.getChild("flow");
  const velocityVec = table.getChild("velocity");
  const depthVec = table.getChild("depth");

  const timeUnit = timeVec?.type?.unit;
  const numRows = table.numRows;

  // Column values reused across both passes.
  const times = new Array(numRows);
  const features = new Array(numRows);
  const timeSet = new Set();
  const featureSet = new Set();
  for (let i = 0; i < numRows; i++) {
    const t = toMillis(timeVec.get(i), timeUnit);
    const f = Number(featureVec.get(i));
    times[i] = t;
    features[i] = f;
    timeSet.add(t);
    featureSet.add(f);
  }

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

  for (let i = 0; i < numRows; i++) {
    const fi = featureIndexMap.get(features[i]);
    const ti = timeIndexMap.get(times[i]);
    if (fi === undefined || ti === undefined) continue;
    const offset = fi * numTimes + ti;
    const fv = flowVec?.get(i);
    const vv = velocityVec?.get(i);
    const dv = depthVec?.get(i);
    if (fv != null) flow[offset] = fv;
    if (vv != null) velocity[offset] = vv;
    if (dv != null) depth[offset] = dv;
  }

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

// ====================================================================
// Parquet parser (worker-side, pure).
//
// `parquetWasm` is { readParquet, tableFromIPC }, injected by the worker.
// parquet-wasm decodes the file into an Arrow table living in WASM memory;
// `intoIPCStream()` hands it to apache-arrow's `tableFromIPC` as a JS-side
// columnar table we read column-at-a-time below.
// ====================================================================
import { FILL_VALUE, VARIABLE_KEYS } from "../../../config.js";

// apache-arrow's Timestamp vector getter already normalizes every unit
// (second / micro / nanosecond) to epoch milliseconds — get() returns a JS
// number in ms (or a Date), NOT the column's raw unit. So we must not re-scale
// by the declared unit; doing so collapsed every timestep onto ~the same
// instant, freezing the time readout. A plain numeric column is assumed ms.
function toMillis(v) {
  return v instanceof Date ? v.getTime() : Number(v);
}

export async function parseParquet(url, parquetWasm) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseParquetBuffer(bytes, parquetWasm);
}

// Same as parseParquet(), but for bytes already in hand (e.g. a local file
// upload) rather than ones that need to be fetched.
export function parseParquetBuffer(bytes, parquetWasm) {
  const { readParquet, tableFromIPC } = parquetWasm;
  const table = tableFromIPC(readParquet(bytes).intoIPCStream());

  const timeVec = table.getChild("time");
  const featureVec = table.getChild("feature_id");
  const vectors = VARIABLE_KEYS.map((v) => [v, table.getChild(v)]);

  const numRows = table.numRows;

  // Column values reused across both passes.
  const times = new Array(numRows);
  const features = new Array(numRows);
  const timeSet = new Set();
  const featureSet = new Set();
  for (let i = 0; i < numRows; i++) {
    const t = toMillis(timeVec.get(i));
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

  const matrices = Object.fromEntries(
    VARIABLE_KEYS.map((v) => {
      const a = new Float32Array(numFeatures * numTimes);
      a.fill(FILL_VALUE);
      return [v, a];
    }),
  );

  for (let i = 0; i < numRows; i++) {
    const fi = featureIndexMap.get(features[i]);
    const ti = timeIndexMap.get(times[i]);
    if (fi === undefined || ti === undefined) continue;
    const offset = fi * numTimes + ti;
    for (const [name, vec] of vectors) {
      const value = vec?.get(i);
      if (value != null) matrices[name][offset] = value;
    }
  }

  // Parquet runs already carry epoch milliseconds (see toMillis above), so the
  // clock is absolute without needing a reference time.
  return {
    time: sortedTimes,
    timeAbsolute: true,
    nTimes: numTimes,
    featureIds: sortedFeatureIds,
    matrices,
  };
}

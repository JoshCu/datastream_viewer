// ====================================================================
// Parquet parser (worker-side, pure).
//
// `parquetWasm` is { readParquet, ParquetFile, tableFromIPC, DataType },
// injected by the worker. The files are long format: one row per (feature,
// time) with a `feature_id`, a `time` and one column per variable.
//
// A file is read one row group at a time (parquet-wasm decodes it into an
// Arrow table in WASM memory, `intoIPCStream()` hands it to apache-arrow),
// in two passes: the first collects the feature ids and times, the second
// writes the values straight into the feature-major matrices. Columns are
// read as whole typed arrays, never per row through `get()`, and nothing
// row-sized outlives its row group — a qkrig day is ~20M rows (830k
// catchments × 24 h), which a per-row, whole-file read can't hold.
// ====================================================================
import { FILL_VALUE, VARIABLE_KEYS, PARQUET_COLUMN_ALIASES } from "../../../config.js";

// Rows per Arrow record batch (parquet-wasm's default is 1024).
const BATCH_ROWS = 1 << 16;

export async function parseParquet(url, parquetWasm) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return parseParquetBuffer(bytes, parquetWasm);
}

// Milliseconds per unit of an Arrow Timestamp (TimeUnit: s, ms, µs, ns).
const TIMESTAMP_TO_MS = [1000, 1, 1e-3, 1e-6];

// Every value of one column as numbers in `out` (null → NaN), timestamps as
// epoch ms. A plain numeric time column is taken to be ms already.
function readColumn(vec, DataType, out = new Float64Array(vec.length)) {
  let k = 0;
  for (const d of vec.data) {
    const scale = DataType.isTimestamp(d.type) ? TIMESTAMP_TO_MS[d.type.unit] : 1;
    const vals = d.values;
    const off = d.offset;
    const bitmap = d.nullCount > 0 ? d.nullBitmap : null;
    // 64-bit integers are read as (low, high) 32-bit words: Number(bigint)
    // per value was most of a large file's parse time. Exact up to 2^53;
    // nanosecond timestamps are past that, but only by ~100 ns.
    const big = vals instanceof BigInt64Array || vals instanceof BigUint64Array;
    const words = big ? new Int32Array(vals.buffer, vals.byteOffset, vals.length * 2) : null;
    const hiSigned = vals instanceof BigInt64Array;
    for (let i = 0; i < d.length; i++, k++) {
      const j = off + i;
      if (bitmap && !((bitmap[j >> 3] >> (j & 7)) & 1)) {
        out[k] = NaN;
        continue;
      }
      let v;
      if (words) {
        const hi = words[2 * j + 1];
        v = (hiSigned ? hi : hi >>> 0) * 4294967296 + (words[2 * j] >>> 0);
      } else {
        v = vals[j];
      }
      out[k] = scale === 1 ? v : Math.round(v * scale);
    }
  }
  return out;
}

// The variables the file has: { key → column name, info }, each a
// config.VARIABLES key under its own name or a PARQUET_COLUMN_ALIASES column.
function variableColumns(names) {
  const out = [];
  for (const key of VARIABLE_KEYS) {
    if (names.includes(key)) {
      out.push({ key, column: key });
      continue;
    }
    const alias = names.find((n) => PARQUET_COLUMN_ALIASES[n]?.variable === key);
    if (alias) out.push({ key, column: alias, info: PARQUET_COLUMN_ALIASES[alias] });
  }
  return out;
}

// Same as parseParquet(), but for bytes already in hand (e.g. a local file
// upload) rather than ones that need to be fetched.
export async function parseParquetBuffer(bytes, parquetWasm) {
  const { readParquet, ParquetFile, tableFromIPC, DataType } = parquetWasm;

  // Asking readParquet for a row group past the end panics the wasm, so the
  // count comes from the footer.
  const handle = await ParquetFile.fromFile(new Blob([bytes]));
  let nGroups;
  try {
    nGroups = handle.metadata().numRowGroups();
  } finally {
    handle.free();
  }
  const group = (g) =>
    tableFromIPC(readParquet(bytes, { rowGroups: [g], batchSize: BATCH_ROWS }).intoIPCStream());

  // Pass 1: the feature ids and times. Rows usually run feature by feature,
  // so the previous row's id skips most feature lookups, and the times
  // repeat in one cycle: each row's time is checked against the one that
  // followed last time (`hint`) before falling back to the map. Without
  // that, a time lookup per row was most of a qkrig day's parse.
  const featureSet = new Set();
  const tList = []; // distinct times, in first-seen order
  const tIndex = new Map(); // time → its index in tList
  let hint = 0;
  const timeSlot = (t) => {
    let j = hint < tList.length && tList[hint] === t ? hint : tIndex.get(t);
    if (j === undefined) {
      j = tList.length;
      tList.push(t);
      tIndex.set(t, j);
    }
    hint = j + 1;
    return j;
  };
  let variables = null;
  let ids = new Float64Array(0);
  let ts = new Float64Array(0);
  for (let g = 0; g < nGroups; g++) {
    const table = group(g);
    if (!variables) variables = variableColumns(table.schema.fields.map((f) => f.name));
    const n = table.numRows;
    if (ids.length < n) {
      ids = new Float64Array(n);
      ts = new Float64Array(n);
    }
    readColumn(table.getChild("feature_id"), DataType, ids);
    readColumn(table.getChild("time"), DataType, ts);
    let lastF = NaN;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(ids[i]) || Number.isNaN(ts[i])) continue; // a row without id or time
      if (ids[i] !== lastF) featureSet.add((lastF = ids[i]));
      timeSlot(ts[i]);
    }
  }
  variables ??= [];

  const time = tList.slice().sort((a, b) => a - b);
  const featureIds = Array.from(featureSet).sort((a, b) => a - b);
  const nTimes = time.length;
  // tList slot → matrix column.
  const colOf = Int32Array.from(tList, (t) => time.indexOf(t));
  const featureRow = new Map(featureIds.map((id, i) => [id, i]));
  const matrices = Object.fromEntries(
    variables.map(({ key }) => [key, new Float32Array(featureIds.length * nTimes).fill(FILL_VALUE)]),
  );

  // Pass 2: the values, into place.
  let vals = new Float64Array(0);
  for (let g = 0; g < nGroups && variables.length; g++) {
    const table = group(g);
    const n = table.numRows;
    if (ids.length < n) {
      ids = new Float64Array(n);
      ts = new Float64Array(n);
    }
    if (vals.length < n) vals = new Float64Array(n);
    readColumn(table.getChild("feature_id"), DataType, ids);
    readColumn(table.getChild("time"), DataType, ts);
    // One offset per row, shared by every variable.
    const offsets = new Int32Array(n);
    let lastF = NaN;
    let base = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(ids[i]) || Number.isNaN(ts[i])) {
        offsets[i] = -1;
        continue;
      }
      if (ids[i] !== lastF) base = featureRow.get((lastF = ids[i])) * nTimes;
      offsets[i] = base + colOf[timeSlot(ts[i])];
    }
    for (const { key, column } of variables) {
      readColumn(table.getChild(column), DataType, vals);
      const m = matrices[key];
      for (let i = 0; i < n; i++) {
        if (offsets[i] >= 0 && !Number.isNaN(vals[i])) m[offsets[i]] = vals[i];
      }
    }
  }

  // Labels/units for variables read from an alias column (a qkrig day's
  // `qkrig_mm_hr` is streamflow in mm/h, not m³/s).
  const relabelled = variables.filter((v) => v.info);
  return {
    time,
    // Parquet runs carry real timestamps, so the clock is absolute without
    // needing a reference time.
    timeAbsolute: true,
    nTimes,
    featureIds,
    matrices,
    ...(relabelled.length && {
      variableInfo: Object.fromEntries(
        relabelled.map(({ key, info }) => [key, { label: info.label, units: info.units }]),
      ),
    }),
  };
}

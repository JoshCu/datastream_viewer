// ====================================================================
// NWM channel_rt files over byte ranges (worker-side, pure).
//
// Each file holds one valid hour for all 2,776,734 CONUS reaches, every
// variable a 1-D int32 array in three deflate + shuffle chunks of 925,578
// reaches (see report.md). `feature_id` is the same sorted COMID list in
// every file, so the main thread reads it once (readNwmFeatureIds) and asks
// for hours by file row (readNwmHour).
// ====================================================================
import { NWM_FILL, NWM_SCALE, FILL_VALUE } from "../../config.js";
import { rangeFetcher } from "./forcing.js";
import {
  createBlockReader,
  readRootDatasets,
  chunkList,
  decodeChunk,
  typedElements,
} from "./hdf5layout.js";

// Object headers, the time values and the feature_id B-tree all sit in the
// first ~44 kB; the variables' B-tree nodes in one 32 kB block near 240 kB.
const PRIME_BYTES = 48 * 1024;
// Chunks closer than this are fetched in one request (e.g. streamflow's
// three, or nudge between streamflow and velocity).
const MERGE_GAP_BYTES = 160 * 1024;

async function open(url) {
  const reader = createBlockReader(rangeFetcher({ url }));
  await reader.prime(0, PRIME_BYTES);
  const { ctx, datasets } = await readRootDatasets(reader.read);
  return { reader, ctx, datasets };
}

// Fetch `chunks` (sorted by address) in as few requests as gaps allow, and
// return each chunk's raw bytes in the same order.
async function fetchChunks(reader, chunks) {
  const groups = [];
  for (const c of chunks) {
    const g = groups.at(-1);
    if (g && c.addr - g.end <= MERGE_GAP_BYTES) {
      g.items.push(c);
      g.end = Math.max(g.end, c.addr + c.size);
    } else {
      groups.push({ start: c.addr, end: c.addr + c.size, items: [c] });
    }
  }
  const out = new Map();
  await Promise.all(
    groups.map(async (g) => {
      const bytes = await reader.read(g.start, g.end - g.start);
      for (const c of g.items) out.set(c, bytes.subarray(c.addr - g.start, c.addr - g.start + c.size));
    }),
  );
  return chunks.map((c) => out.get(c));
}

async function readScalar(reader, ctx, ds) {
  const [c] = await chunkList(reader.read, ctx, ds);
  const [raw] = await fetchChunks(reader, [c]);
  return typedElements(await decodeChunk(raw, ds, c.mask), ds.dtype)[0];
}

// Total compressed size of feature_id: identical in every CONUS file, so it
// doubles as a check that a file's rows are in the cached order.
function idFingerprint(chunks) {
  return chunks.reduce((n, c) => n + c.size, 0);
}

// Every COMID of a file, in row order, plus its fingerprint.
export async function readNwmFeatureIds(url) {
  const { reader, ctx, datasets } = await open(url);
  const ds = datasets.feature_id;
  if (!ds) throw new Error("NWM file has no feature_id");
  const chunks = await chunkList(reader.read, ctx, ds);
  const raws = await fetchChunks(reader, chunks);
  const ids = new Float64Array(ds.shape[0]);
  for (let i = 0; i < chunks.length; i++) {
    const v = typedElements(await decodeChunk(raws[i], ds, chunks[i].mask), ds.dtype);
    ids.set(v.subarray(0, Math.min(v.length, ids.length - chunks[i].start[0])), chunks[i].start[0]);
  }
  return { ids, fingerprint: idFingerprint(chunks), stats: reader.stats() };
}

// Compressed bytes per variable, for a download estimate without fetching
// any data.
export async function readNwmSizes(url, variables) {
  const { reader, ctx, datasets } = await open(url);
  const sizes = {};
  for (const [key, name] of Object.entries(variables)) {
    const ds = datasets[name];
    if (ds) sizes[key] = idFingerprint(await chunkList(reader.read, ctx, ds));
  }
  return { sizes, stats: reader.stats() };
}

// One valid hour: `variables` maps our key → the file's name (absent ones
// are skipped), `rows` is a sorted Int32Array of file rows (null = all).
// Returns { time (epoch ms), refTime (epoch ms), values: { key: Float32Array
// in `rows` order }, stats }. Throws if the file's ids aren't the cached ones.
export async function readNwmHour({ url, variables, rows, fingerprint }) {
  const { reader, ctx, datasets } = await open(url);
  if (fingerprint != null && datasets.feature_id) {
    const got = idFingerprint(await chunkList(reader.read, ctx, datasets.feature_id));
    if (got !== fingerprint) throw new Error("NWM file has a different reach list than expected");
  }
  const minutes = (name) => (datasets[name] ? readScalar(reader, ctx, datasets[name]) : null);
  const [time, refTime] = await Promise.all([minutes("time"), minutes("reference_time")]);

  const plan = [];
  for (const [key, name] of Object.entries(variables)) {
    const ds = datasets[name];
    if (!ds?.chunked) continue;
    const n = ds.shape[0];
    const size = ds.chunked.chunk[0];
    const chunks = (await chunkList(reader.read, ctx, ds)).filter((c) => {
      if (!rows) return true;
      // Any wanted row inside [start, start + size)? rows is sorted.
      const lo = lowerBound(rows, c.start[0]);
      return lo < rows.length && rows[lo] < c.start[0] + size;
    });
    plan.push({ key, ds, n, chunks });
  }
  const all = plan.flatMap((p) => p.chunks).sort((a, b) => a.addr - b.addr);
  const raws = new Map();
  (await fetchChunks(reader, all)).forEach((bytes, i) => raws.set(all[i], bytes));

  const values = {};
  for (const { key, ds, n, chunks } of plan) {
    const out = new Float32Array(rows ? rows.length : n).fill(FILL_VALUE);
    for (const c of chunks) {
      const v = typedElements(await decodeChunk(raws.get(c), ds, c.mask), ds.dtype);
      const start = c.start[0];
      const end = Math.min(start + v.length, n);
      if (!rows) {
        for (let r = start; r < end; r++) out[r] = unpack(v[r - start]);
        continue;
      }
      for (let i = lowerBound(rows, start); i < rows.length && rows[i] < end; i++) {
        out[i] = unpack(v[rows[i] - start]);
      }
    }
    values[key] = out;
  }
  return {
    time: time == null ? null : time * 60000,
    refTime: refTime == null ? null : refTime * 60000,
    values,
    stats: reader.stats(),
  };
}

function unpack(x) {
  return x === NWM_FILL ? FILL_VALUE : x * NWM_SCALE;
}

function lowerBound(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

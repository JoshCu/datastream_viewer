// ====================================================================
// Forcing file access over byte ranges (worker-side, pure).
//
// A forcing file's variables are contiguous (catchment × time) matrices, so
// once the layout is known (hdf5layout.js) any set of catchment rows is a
// handful of HTTP Range requests: sort the rows, merge near neighbours into
// one request, fetch every (variable, run) concurrently and decode straight
// out of the response bytes.
//
// A source is { url } (fetched with Range requests; anything but a 206 is an
// error) or { file } (a dropped File, read with Blob.slice), so a local file
// goes through exactly the same path as one on S3.
// ====================================================================
import {
  FILL_VALUE,
  FORCING_REQUEST_COST_BYTES,
  FORCING_FETCH_CONCURRENCY,
  FORCING_TIME_VAR,
} from "../../config.js";
import { createBlockReader, readForcingLayout } from "./hdf5layout.js";

// Big runs are split so one variable block doesn't arrive as a single huge
// response: more parallelism over HTTP/2, and less held in flight.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const RETRIES = 3;

function rangeFetcher(source) {
  if (source.file) {
    return (start, end) => source.file.slice(start, end + 1).arrayBuffer();
  }
  return async (start, end) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(source.url, { headers: { Range: `bytes=${start}-${end}` } });
        if (res.status !== 206) {
          throw new Error(`expected HTTP 206 for a range request, got ${res.status}`);
        }
        return await res.arrayBuffer();
      } catch (err) {
        // A non-206 won't get better with retrying; a dropped connection might.
        if (attempt >= RETRIES - 1 || /expected HTTP 206/.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      }
    }
  };
}

// Layout of a forcing file: ordered ids plus each variable's offset, shape
// and dtype. See hdf5layout.js.
// The forcing writer puts the superblock, group structure, id pointers and
// id strings ahead of the first variable (about 60 bytes per catchment), so
// one opening read covers most of the scan for a typical VPU.
const PRIME_BYTES = 1024 * 1024;

export async function scanForcingLayout(source) {
  const reader = createBlockReader(rangeFetcher(source));
  await reader.prime(0, PRIME_BYTES);
  const layout = await readForcingLayout(reader.read, { prime: reader.prime });
  return { ...layout, stats: reader.stats() };
}

// Group sorted rows into runs [first, last]; rows separated by less than
// maxGapBytes are merged so a few unneeded bytes replace a round trip.
export function groupRows(rows, rowBytes, maxGapBytes) {
  const runs = [];
  let start = rows[0];
  let prev = rows[0];
  const maxRun = Math.max(1, Math.floor(MAX_REQUEST_BYTES / rowBytes));
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r - prev - 1) * rowBytes <= maxGapBytes && r - start < maxRun) {
      prev = r;
    } else {
      runs.push([start, prev]);
      start = prev = r;
    }
  }
  runs.push([start, prev]);
  return runs;
}

// Row order in these files has little to do with geography, so the rows of
// one viewport are scattered: a small merge gap means thousands of requests,
// a large one hundreds of MB of unwanted rows, and the balance shifts with
// the view and the forecast length. So the gap is chosen per request, as the
// candidate minimising requests × FORCING_REQUEST_COST_BYTES + bytes.
const GAP_CANDIDATES = [0, 4, 16, 64, 256, 1024].map((kb) => kb * 1024);

export function planRuns(rows, rowBytes) {
  let best = null;
  for (const gap of GAP_CANDIDATES) {
    const runs = groupRows(rows, rowBytes, gap);
    let bytes = 0;
    for (const [r0, r1] of runs) bytes += (r1 - r0 + 1) * rowBytes;
    const cost = runs.length * FORCING_REQUEST_COST_BYTES + bytes;
    if (!best || cost < best.cost) best = { runs, bytes, cost };
  }
  return best;
}

function itemReader(dtype) {
  const m = /^([<>])([fiu])(\d)$/.exec(dtype);
  if (!m) throw new Error(`Unsupported forcing dtype ${dtype}`);
  const little = m[1] === "<";
  const size = Number(m[3]);
  const kind = m[2] + size;
  const get = {
    f8: (dv, o) => dv.getFloat64(o, little),
    f4: (dv, o) => dv.getFloat32(o, little),
    i4: (dv, o) => dv.getInt32(o, little),
    i2: (dv, o) => dv.getInt16(o, little),
    u4: (dv, o) => dv.getUint32(o, little),
    u2: (dv, o) => dv.getUint16(o, little),
  }[kind];
  if (!get) throw new Error(`Unsupported forcing dtype ${dtype}`);
  return { size, get };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(lanes);
}

// Fetch `rows` (sorted, unique Int32Array of file rows) of every variable in
// `variables` ({ name: { offset, shape, dtype } }). Returns
//   { rows, nTimes, blocks: { name: Float32Array(rows.length * nTimes) },
//     time: Float64Array | null, stats }
// blocks are row-major in `rows` order, with NaN mapped to the fill value.
// With `withTime`, `time` is the first requested row's Time series (epoch
// seconds, kept in float64 — float32 would round it to minutes).
export async function fetchForcingRows({ source, variables, rows, withTime }) {
  const fetchRange = rangeFetcher(source);
  const names = Object.keys(variables).filter((n) => n !== FORCING_TIME_VAR);
  const nTimes = variables[names[0]].shape[1];
  const n = rows.length;
  let requests = 0;
  let bytes = 0;

  const blocks = {};
  const jobs = [];
  for (const name of names) {
    const v = variables[name];
    if (v.shape[1] !== nTimes) throw new Error(`${name} has ${v.shape[1]} steps, expected ${nTimes}`);
    const item = itemReader(v.dtype);
    const rowBytes = nTimes * item.size;
    blocks[name] = new Float32Array(n * nTimes);
    // Index into `rows` of each run's first row, so decoding can walk the
    // requested rows inside the run without searching.
    let k = 0;
    for (const [r0, r1] of planRuns(rows, rowBytes).runs) {
      jobs.push({ name, v, item, rowBytes, r0, r1, k });
      while (k < n && rows[k] <= r1) k++;
    }
  }

  await mapLimit(jobs, FORCING_FETCH_CONCURRENCY, async (job) => {
    const { name, v, item, rowBytes, r0, r1 } = job;
    const start = v.offset + r0 * rowBytes;
    const buf = await fetchRange(start, v.offset + (r1 + 1) * rowBytes - 1);
    requests++;
    bytes += buf.byteLength;
    if (buf.byteLength !== (r1 - r0 + 1) * rowBytes) {
      throw new Error(`${name}: short read (${buf.byteLength} of ${(r1 - r0 + 1) * rowBytes} bytes)`);
    }
    const dv = new DataView(buf);
    const out = blocks[name];
    for (let k = job.k; k < n && rows[k] <= r1; k++) {
      const src = (rows[k] - r0) * rowBytes;
      const dst = k * nTimes;
      for (let t = 0; t < nTimes; t++) {
        const x = item.get(dv, src + t * item.size);
        out[dst + t] = Number.isNaN(x) ? FILL_VALUE : x;
      }
    }
  });

  let time = null;
  const tv = variables[FORCING_TIME_VAR];
  if (withTime && tv) {
    const item = itemReader(tv.dtype);
    const rowBytes = tv.shape[1] * item.size;
    const start = tv.offset + rows[0] * rowBytes;
    const dv = new DataView(await fetchRange(start, start + rowBytes - 1));
    requests++;
    bytes += rowBytes;
    time = new Float64Array(tv.shape[1]);
    for (let t = 0; t < time.length; t++) time[t] = item.get(dv, t * item.size);
  }

  return { rows, nTimes, blocks, time, stats: { requests, bytes } };
}

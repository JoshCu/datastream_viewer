// ====================================================================
// Gridded rainfall from dynamical.org (main-thread side): find the store,
// measure a load from its shard indexes, read it across the worker pool. The
// reads are in data/workers/rain.js. DOM-free.
//
// Two kinds of read over the same tiles: a box of the map (sampled to fit
// memory) for rain/rain.js, and one cell's series for the hydrograph.
// ====================================================================
import {
  RAIN_FETCH_CONCURRENCY,
  RAIN_MAX_CELLS,
  RAIN_MAX_MEMORY_BYTES,
  RAIN_PRODUCTS,
  RAIN_STAC_BASE,
} from "../config.js";
import { runTask } from "./loader.js";

const metas = new Map(); // "product/variable" -> Promise<meta>

async function storeHref(product) {
  const res = await fetch(`${RAIN_STAC_BASE}/${RAIN_PRODUCTS[product].stac}/collection.json`);
  if (!res.ok) throw new Error(`STAC collection: HTTP ${res.status}`);
  const href = (await res.json()).assets?.["icechunk-https"]?.href;
  if (!href) throw new Error("The STAC collection lists no Icechunk store");
  return href;
}

export function rainMeta(product, variable) {
  const key = `${product}/${variable}`;
  if (!metas.has(key)) {
    const p = (async () => {
      const href = await storeHref(product);
      return { href, variable, ...(await runTask({ type: "rainMeta", href, variable })) };
    })();
    p.catch(() => metas.delete(key));
    metas.set(key, p);
  }
  return metas.get(key);
}

// The record's span [first, last] (epoch ms).
const rainRecord = (meta) => [meta.t0Ms, meta.t0Ms + (meta.nTimes - 1) * meta.stepMs];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Time indexes [t0, t1) inside [fromMs, toMs]. Throws, naming the record's
// span (not known until the store is open), if that misses it.
function timeRange(meta, fromMs, toMs) {
  const t0 = Math.max(0, Math.ceil((fromMs - meta.t0Ms) / meta.stepMs));
  const t1 = Math.min(meta.nTimes, Math.floor((toMs - meta.t0Ms) / meta.stepMs) + 1);
  if (t1 > t0) return { t0, t1 };
  const [first, last] = rainRecord(meta);
  throw new Error(`Those dates are outside the record (${isoDay(first)} to ${isoDay(last)})`);
}

// Index range [i0, i1) of the centres within [lo, hi], on either axis order.
function axisRange(first, step, length, lo, hi) {
  const a = (lo - first) / step;
  const b = (hi - first) / step;
  const i0 = Math.max(0, Math.floor(Math.min(a, b)));
  const i1 = Math.min(length, Math.ceil(Math.max(a, b)) + 1);
  return i1 > i0 ? [i0, i1] : null;
}

function sizes(meta, range) {
  const { href, variable, shard, chunk } = meta;
  return runTask({ type: "rainSizes", href, variable, shard, chunk, ...range });
}

// Plan a map load over `bounds` { west, south, east, north }: the sampling
// that fits it, and what it costs. Throws a readable error if it misses the
// product's grid or record.
export async function planRainLoad({ product, variable, fromMs, toMs, bounds }) {
  const meta = await rainMeta(product, variable);
  const time = timeRange(meta, fromMs, toMs);
  const ys = axisRange(meta.lat0, meta.dLat, meta.shape[1], bounds.south, bounds.north);
  const xs = axisRange(meta.lon0, meta.dLon, meta.shape[2], bounds.west, bounds.east);
  if (!ys || !xs) throw new Error("The view is outside this product's area");
  const [y0, y1] = ys;
  const [x0, x1] = xs;
  const nT = time.t1 - time.t0;
  const gridSize = (s) => [Math.ceil((y1 - y0) / s), Math.ceil((x1 - x0) / s)];
  let stride = 1;
  for (;;) {
    const [ny, nx] = gridSize(stride);
    if (ny * nx <= RAIN_MAX_CELLS && ny * nx * nT * 4 <= RAIN_MAX_MEMORY_BYTES) break;
    stride++;
  }
  const [ny, nx] = gridSize(stride);
  const range = { ...time, y0, y1, x0, x1 };
  const { chunks } = await sizes(meta, range);
  // A coarse sampling can step over whole chunks.
  const off = Math.floor(stride / 2);
  const sampled = (n, c, lo) => {
    const a = n * c;
    const first = Math.max(0, Math.ceil((a - lo - off) / stride));
    return lo + first * stride + off < a + c;
  };
  const used = chunks.filter(
    (c) => sampled(c.y, meta.chunk[1], y0) && sampled(c.x, meta.chunk[2], x0),
  );
  return {
    product,
    variable,
    meta,
    range,
    stride,
    nT,
    ny,
    nx,
    chunks: used,
    bytes: used.reduce((sum, c) => sum + c.bytes, 0),
    memoryBytes: nT * ny * nx * 4,
  };
}

// Run every tile, a few at a time; onTile(result, bytes) per finished chunk.
async function readTiles(meta, range, chunks, stride, scale, onTile) {
  const { href, variable, chunk } = meta;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const c = chunks[next++];
      const result = await runTask({
        type: "rainTile",
        href,
        variable,
        chunk,
        t: c.t,
        y: c.y,
        x: c.x,
        ...range,
        stride,
        scale,
      });
      onTile(result, c.bytes);
    }
  };
  await Promise.all(Array.from({ length: Math.min(RAIN_FETCH_CONCURRENCY, chunks.length) }, worker));
}

// Execute a plan. Cells in no chunk stay NaN. onProgress(done, total, bytes).
export async function loadRainGrid(plan, { onProgress } = {}) {
  const { meta, range, stride, nT, ny, nx, product, variable } = plan;
  const info = RAIN_PRODUCTS[product].variables[variable];
  const frames = new Float32Array(nT * ny * nx).fill(NaN);
  let done = 0;
  let bytes = 0;
  await readTiles(meta, range, plan.chunks, stride, info.scale, (tile, size) => {
    const { tStart, nt, r0, rows, c0, cols, values } = tile;
    for (let i = 0; i < nt; i++) {
      for (let r = 0; r < rows; r++) {
        const from = (i * rows + r) * cols;
        frames.set(values.subarray(from, from + cols), ((tStart + i) * ny + r0 + r) * nx + c0);
      }
    }
    bytes += size;
    onProgress?.(++done, plan.chunks.length, bytes);
  });
  const off = Math.floor(stride / 2);
  return {
    product,
    variable,
    info,
    stride,
    nT,
    ny,
    nx,
    frames,
    bytes,
    time: Float64Array.from({ length: nT }, (_, i) => meta.t0Ms + (range.t0 + i) * meta.stepMs),
    lat0: meta.lat0 + (range.y0 + off) * meta.dLat,
    dLat: meta.dLat * stride,
    lon0: meta.lon0 + (range.x0 + off) * meta.dLon,
    dLon: meta.dLon * stride,
  };
}

// The grid cell holding a point, as tile ranges; null if it's off the grid.
function cellRange(meta, lon, lat) {
  const y = Math.round((lat - meta.lat0) / meta.dLat);
  const x = Math.round((lon - meta.lon0) / meta.dLon);
  if (y < 0 || y >= meta.shape[1] || x < 0 || x >= meta.shape[2]) return null;
  return { y0: y, y1: y + 1, x0: x, x1: x + 1 };
}

// Plan one cell's series: { meta, range, chunks, bytes } (chunks may be empty
// where the store has nothing). Throws a readable error off the grid or record.
export async function planRainSeries({ product, variable, lon, lat, fromMs, toMs }) {
  const meta = await rainMeta(product, variable);
  const time = timeRange(meta, fromMs, toMs);
  const cell = cellRange(meta, lon, lat);
  if (!cell) throw new Error("This reach is outside the product's area");
  const range = { ...time, ...cell };
  const { chunks } = await sizes(meta, range);
  return {
    product,
    variable,
    meta,
    range,
    chunks,
    bytes: chunks.reduce((sum, c) => sum + c.bytes, 0),
  };
}

// { times (epoch ms), values (NaN = no data), bytes } for a planned cell.
export async function loadRainSeries(plan) {
  const { meta, range, chunks, product, variable } = plan;
  const info = RAIN_PRODUCTS[product].variables[variable];
  const n = range.t1 - range.t0;
  const values = new Float32Array(n).fill(NaN);
  await readTiles(meta, range, chunks, 1, info.scale, (tile) => values.set(tile.values, tile.tStart));
  const times = Float64Array.from({ length: n }, (_, i) => meta.t0Ms + (range.t0 + i) * meta.stepMs);
  return { times, values, bytes: plan.bytes };
}

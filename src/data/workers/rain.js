// ====================================================================
// Gridded rainfall reads from dynamical.org's Icechunk stores (worker-side,
// pure). Each array is (time, y, x), sharded, with whole time blocks in one
// inner chunk, so even one cell costs a chunk per block it touches.
//
// `libs` is { IcechunkStore, zarr }, passed in by parse.worker.js, which owns
// the CDN imports. A worker keeps its stores: opening one fetches its repo
// file and snapshot (~0.3 MB), and zarrita caches shard indexes per array.
// ====================================================================

const stores = new Map(); // href -> Promise<store>
const arrays = new Map(); // href + path -> Promise<array>

function openStore(href, libs) {
  if (!stores.has(href)) {
    const p = libs.IcechunkStore.open(href);
    p.catch(() => stores.delete(href));
    stores.set(href, p);
  }
  return stores.get(href);
}

function openArray(href, path, libs) {
  const key = href + path;
  if (!arrays.has(key)) {
    const p = openStore(href, libs).then((store) =>
      libs.zarr.open(store.resolve(path), { kind: "array" }),
    );
    p.catch(() => arrays.delete(key));
    arrays.set(key, p);
  }
  return arrays.get(key);
}

const decoder = new TextDecoder();

async function arrayMeta(href, variable, libs) {
  const store = await openStore(href, libs);
  const bytes = await store.get(`/${variable}/zarr.json`);
  if (!bytes) throw new Error(`${variable} isn't in this store`);
  return JSON.parse(decoder.decode(bytes));
}

// The first two values and the length of a regular coordinate. (A coordinate
// can be 64-bit, so everything goes through Number.)
async function coordinate(href, name, libs) {
  const arr = await openArray(href, `/${name}`, libs);
  const { data } = await libs.zarr.get(arr, [libs.zarr.slice(0, 2)]);
  return { first: Number(data[0]), step: Number(data[1]) - Number(data[0]), length: arr.shape[0] };
}

// What a load needs to know about a variable's array and grid.
export async function readRainMeta({ href, variable }, libs) {
  const meta = await arrayMeta(href, variable, libs);
  const shard = meta.chunk_grid?.configuration?.chunk_shape;
  const sharding = meta.codecs.find((c) => c.name === "sharding_indexed");
  if (!shard || !sharding) throw new Error(`${variable}: expected a sharded array`);
  const [time, lat, lon] = await Promise.all(
    ["time", "latitude", "longitude"].map((n) => coordinate(href, n, libs)),
  );
  return {
    shape: meta.shape,
    shard,
    chunk: sharding.configuration.chunk_shape,
    t0Ms: time.first * 1000,
    stepMs: time.step * 1000,
    nTimes: time.length,
    lat0: lat.first,
    dLat: lat.step,
    lon0: lon.first,
    dLon: lon.step,
  };
}

// Run fn over `items`, at most `limit` at a time.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

const NO_CHUNK = 0xffffffffffffffffn;

// The inner chunks touching [t0, t1) × [y0, y1) × [x0, x1), from the shard
// indexes (a few kB each): [{ t, y, x, bytes }] in chunk numbers, leaving out
// the chunks that were never written (all fill).
export async function readRainSizes({ href, variable, shard, chunk, t0, t1, y0, y1, x0, x1 }, libs) {
  const store = await openStore(href, libs);
  const per = shard.map((s, i) => s / chunk[i]);
  const nInner = per[0] * per[1] * per[2];
  const shards = [];
  for (let st = Math.floor(t0 / shard[0]); st <= Math.floor((t1 - 1) / shard[0]); st++) {
    for (let sy = Math.floor(y0 / shard[1]); sy <= Math.floor((y1 - 1) / shard[1]); sy++) {
      for (let sx = Math.floor(x0 / shard[2]); sx <= Math.floor((x1 - 1) / shard[2]); sx++) {
        shards.push([st, sy, sx]);
      }
    }
  }
  const lists = await mapLimit(shards, 16, async ([st, sy, sx]) => {
    const raw = await store
      .getRange(`/${variable}/c/${st}/${sy}/${sx}`, { suffixLength: nInner * 16 + 4 })
      .catch(() => null);
    if (!raw) return [];
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const found = [];
    for (let i = 0; i < nInner; i++) {
      if (view.getBigUint64(i * 16, true) === NO_CHUNK) continue;
      const t = st * per[0] + Math.floor(i / (per[1] * per[2]));
      const y = sy * per[1] + (Math.floor(i / per[2]) % per[1]);
      const x = sx * per[2] + (i % per[2]);
      const hit =
        (t + 1) * chunk[0] > t0 && t * chunk[0] < t1 &&
        (y + 1) * chunk[1] > y0 && y * chunk[1] < y1 &&
        (x + 1) * chunk[2] > x0 && x * chunk[2] < x1;
      if (hit) found.push({ t, y, x, bytes: Number(view.getBigUint64(i * 16 + 8, true)) });
    }
    return found;
  });
  return { chunks: lists.flat() };
}

// One inner chunk's part of a load, sampled onto the load's grid: rows
// y0 + r·stride + ⌊stride/2⌋, likewise columns. Returns the block's position in
// that grid and its values (× scale; NaN = no data), [t][r][c].
export async function readRainTile(
  { href, variable, chunk, t, y, x, t0, t1, y0, y1, x0, x1, stride, scale },
  libs,
) {
  const off = Math.floor(stride / 2);
  const span = (n, c, lo, hi) => [Math.max(n * c, lo), Math.min((n + 1) * c, hi)];
  const [ta, tb] = span(t, chunk[0], t0, t1);
  const [ya, yb] = span(y, chunk[1], y0, y1);
  const [xa, xb] = span(x, chunk[2], x0, x1);
  // The grid's rows and columns inside this chunk.
  const firstIn = (a, lo) => Math.max(0, Math.ceil((a - lo - off) / stride));
  const r0 = firstIn(ya, y0);
  const c0 = firstIn(xa, x0);
  const rows = Math.max(0, Math.ceil((yb - y0 - off) / stride) - r0);
  const cols = Math.max(0, Math.ceil((xb - x0 - off) / stride) - c0);
  const nt = tb - ta;
  const values = new Float32Array(nt * rows * cols);
  if (values.length) {
    const arr = await openArray(href, `/${variable}`, libs);
    const { slice } = libs.zarr;
    const { data } = await libs.zarr.get(arr, [slice(ta, tb), slice(ya, yb), slice(xa, xb)]);
    const h = yb - ya;
    const w = xb - xa;
    let k = 0;
    for (let i = 0; i < nt; i++) {
      for (let r = 0; r < rows; r++) {
        const base = (i * h + (y0 + (r0 + r) * stride + off - ya)) * w;
        for (let c = 0; c < cols; c++) {
          values[k++] = data[base + (x0 + (c0 + c) * stride + off - xa)] * scale;
        }
      }
    }
  }
  return { tStart: ta - t0, nt, r0, rows, c0, cols, values };
}

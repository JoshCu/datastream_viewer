// ====================================================================
// Flow-field worker: DEM tiles → mosaic → routing (data/workers/flowroute.js).
//
// It fetches the same tile URLs as the map's raster-dem source, so after
// MapLibre has shown an area these come from the HTTP cache. Decoded tiles
// are kept in a small LRU here, so panning over the same ground or stepping
// coarse → fine doesn't decode them again.
//
// Mixed resolutions: the field is built at one zoom, but the DEM doesn't
// reach that zoom everywhere (Mapterhorn is ~z12 in most places, deeper
// where there's lidar, and 404s past it). A missing tile is filled from its
// nearest ancestor, bilinearly upsampled, so the mosaic is seamless and only
// as coarse as the data underneath.
//
// Protocol (main → worker):
//   { type: "cancel", epoch }  drop anything older than `epoch`
//   { type: "field", epoch, id, z, x0, y0, w, h, url, encoding, tileSize }
//       Build the field over global pixels [x0, x0+w) × [y0, y0+h) at zoom z
//       (pixels of the source's tileSize tiles). `url` is the source's tile
//       template ({z}/{x}/{y}).
// Replies (worker → main):
//   { type: "field", epoch, id, result: { z, x0, y0, w, h, elev, dir,
//     sqrtSlope, acc, outlet, tiles, fallback, failed, ms } }  — arrays
//     transferred; `fallback` tiles came from an ancestor, `failed` ones
//     because a fetch failed (worth retrying)
//   { type: "error", epoch, id, error }
// A request whose epoch is no longer the latest is dropped after its tiles
// load, before the (expensive) routing.
// ====================================================================
import { routeFlow } from "../data/workers/flowroute.js";

const CACHE_TILES = 96; // ~1 MB each at 512²
// "z/x/y" -> Promise<{ dim, elev } | null (no tile) | FAILED>, LRU order.
const cache = new Map();
// A tile that couldn't be fetched (network, 5xx): filled from its ancestor
// like a missing one, but not cached, and counted so the field is retried.
const FAILED = { failed: true };
let latestEpoch = -1;

function decode(rgba, encoding) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    if (rgba[p + 3] === 0) out[i] = NaN;
    else if (encoding === "mapbox") out[i] = -10000 + (r * 65536 + g * 256 + b) * 0.1;
    else out[i] = r * 256 + g + b / 256 - 32768; // terrarium
  }
  return out;
}

async function fetchTile(url, encoding) {
  const res = await fetch(url);
  // 404 (past the data's zoom) and 204 (no tile) both mean "use the parent".
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`DEM tile ${res.status}: ${url}`);
  // No colour management or premultiplication: the RGB bytes are the data.
  const bmp = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { dim: canvas.width, elev: decode(data, encoding) };
}

function getTile(template, encoding, z, x, y) {
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key); // re-insert: most recently used
  } else {
    const url = template.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    p = fetchTile(url, encoding).catch((err) => {
      if (cache.get(key) === p) cache.delete(key); // don't cache a failure
      console.warn(err);
      return FAILED;
    });
  }
  cache.set(key, p);
  while (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
  return p;
}

// The tile itself, or its nearest ancestor that exists: { tile, dz, failed }
// (`failed`: some level on the way couldn't be fetched), or null.
async function bestTile(template, encoding, z, x, y) {
  let failed = false;
  for (let dz = 0; dz <= z; dz++) {
    const tile = await getTile(template, encoding, z - dz, x >> dz, y >> dz);
    if (tile === FAILED) failed = true;
    else if (tile) return { tile, dz, failed };
  }
  return null;
}

// Fill the part of `out` (w × h at global pixel x0, y0) that tile (tx, ty)
// at zoom z covers, from `best` (that tile or an ancestor dz levels up, at
// unwrapped ancestor coordinates best.tx, best.ty). `level` maps "tx/ty" at
// the ancestor's zoom to its loaded neighbours, so the bilinear upsampling
// reads across the ancestor's edges instead of clamping there (which would
// leave a flat strip and a step at every coarse seam).
function blit(out, x0, y0, w, h, tileSize, tx, ty, best, level) {
  const ax = Math.max(x0, tx * tileSize);
  const bx = Math.min(x0 + w, (tx + 1) * tileSize);
  const ay = Math.max(y0, ty * tileSize);
  const by = Math.min(y0 + h, (ty + 1) * tileSize);
  if (!best) {
    for (let Y = ay; Y < by; Y++) out.fill(NaN, (Y - y0) * w + ax - x0, (Y - y0) * w + bx - x0);
    return;
  }
  const { tile, dz } = best;
  const { dim, elev } = tile;
  // Exact copy when it's the tile itself at the expected size.
  if (dz === 0 && dim === tileSize) {
    for (let Y = ay; Y < by; Y++) {
      const src = (Y - ty * tileSize) * dim + (ax - tx * tileSize);
      out.set(elev.subarray(src, src + (bx - ax)), (Y - y0) * w + (ax - x0));
    }
    return;
  }
  // Otherwise sample pixel centres bilinearly in the ancestor level's global
  // pixels (gx, gy). Inside the ancestor that's a plain read; at its edge the
  // neighbouring ancestor is read, or the edge is clamped if there's none.
  const s = dim / (tileSize << dz); // ancestor pixels per output pixel
  const px0 = best.tx * dim;
  const py0 = best.ty * dim;
  // With no neighbour there, clamp one axis at a time (y first), so a
  // missing corner tile doesn't also cut off the side neighbour.
  const pixel = (gx, gy) => {
    const ntx = Math.floor(gx / dim);
    const nty = Math.floor(gy / dim);
    if (ntx === best.tx && nty === best.ty) return elev[(gy - py0) * dim + (gx - px0)];
    const nb = level?.get(`${ntx}/${nty}`);
    if (nb && nb.dim === dim) return nb.elev[(gy - nty * dim) * dim + (gx - ntx * dim)];
    if (nty !== best.ty) return pixel(gx, Math.min(py0 + dim - 1, Math.max(py0, gy)));
    return pixel(Math.min(px0 + dim - 1, Math.max(px0, gx)), gy);
  };
  for (let Y = ay; Y < by; Y++) {
    const fy = (Y + 0.5) * s - 0.5;
    const gy = Math.floor(fy);
    const ty1 = fy - gy;
    const ly = gy - py0;
    let o = (Y - y0) * w + (ax - x0);
    for (let X = ax; X < bx; X++, o++) {
      const fx = (X + 0.5) * s - 0.5;
      const gx = Math.floor(fx);
      const tx1 = fx - gx;
      const lx = gx - px0;
      let a, b, c, d;
      if (lx >= 0 && ly >= 0 && lx < dim - 1 && ly < dim - 1) {
        const k = ly * dim + lx;
        a = elev[k];
        b = elev[k + 1];
        c = elev[k + dim];
        d = elev[k + dim + 1];
      } else {
        a = pixel(gx, gy);
        b = pixel(gx + 1, gy);
        c = pixel(gx, gy + 1);
        d = pixel(gx + 1, gy + 1);
      }
      const top = a + (b - a) * tx1;
      const bot = c + (d - c) * tx1;
      out[o] = top + (bot - top) * ty1;
    }
  }
}

const EARTH_CIRCUMFERENCE_M = 40075016.686;

// Metres per pixel on each row of the field (Web Mercator: cos(latitude)).
function rowMetres(z, y0, h, tileSize) {
  const world = tileSize * 2 ** z;
  const out = new Float32Array(h);
  for (let r = 0; r < h; r++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y0 + r + 0.5)) / world)));
    out[r] = (EARTH_CIRCUMFERENCE_M * Math.cos(lat)) / world;
  }
  return out;
}

async function buildField({ epoch, z, x0, y0, w, h, url, encoding, tileSize }) {
  const t0 = performance.now();
  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(y0 / tileSize); ty <= Math.floor((y0 + h - 1) / tileSize); ty++) {
    for (let tx = Math.floor(x0 / tileSize); tx <= Math.floor((x0 + w - 1) / tileSize); tx++) {
      if (ty < 0 || ty >= n) continue;
      // Wrap x across the antimeridian for the fetch; blit uses the unwrapped tx.
      const wx = ((tx % n) + n) % n;
      tiles.push({ tx, ty, best: bestTile(url, encoding, z, wx, ty) });
    }
  }
  const resolved = await Promise.all(tiles.map((t) => t.best));
  if (epoch !== latestEpoch) return null;

  // Ancestors in use, at unwrapped coordinates (so the sampling lines up with
  // tx), and their neighbours at the same zoom for sampling across seams.
  const bests = resolved.map(
    (best, i) => best && { ...best, tx: tiles[i].tx >> best.dz, ty: tiles[i].ty >> best.dz },
  );
  const levels = new Map(); // ancestor zoom -> Map("tx/ty" -> Promise<tile>)
  for (const b of bests) {
    if (!b?.dz) continue;
    const zl = z - b.dz;
    const nl = 2 ** zl;
    if (!levels.has(zl)) levels.set(zl, new Map());
    const level = levels.get(zl);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ax = b.tx + dx;
        const ay = b.ty + dy;
        const key = `${ax}/${ay}`;
        if (ay < 0 || ay >= nl || level.has(key)) continue;
        level.set(key, getTile(url, encoding, zl, ((ax % nl) + nl) % nl, ay));
      }
    }
  }
  for (const level of levels.values()) {
    for (const [key, p] of level) {
      const tile = await p;
      if (tile && tile !== FAILED) level.set(key, tile);
      else level.delete(key);
    }
  }
  if (epoch !== latestEpoch) return null;

  const elev = new Float32Array(w * h).fill(NaN);
  let fallback = 0;
  let failed = 0;
  tiles.forEach((t, i) => {
    const b = bests[i];
    if (!b || b.dz) fallback++;
    if (!b || b.failed) failed++;
    blit(elev, x0, y0, w, h, tileSize, t.tx, t.ty, b, b && levels.get(z - b.dz));
  });

  const routed = routeFlow(elev, w, h, rowMetres(z, y0, h, tileSize));
  return {
    z, x0, y0, w, h, elev, ...routed,
    tiles: tiles.length,
    fallback,
    failed,
    ms: Math.round(performance.now() - t0),
  };
}

self.onmessage = async ({ data }) => {
  // Any message moves the epoch on; "cancel" does only that, so a build in
  // flight is dropped before its routing.
  latestEpoch = Math.max(latestEpoch, data.epoch);
  if (data.type !== "field") return;
  try {
    const result = await buildField(data);
    if (!result) return;
    self.postMessage({ type: "field", epoch: data.epoch, id: data.id, result }, [
      result.elev.buffer,
      result.dir.buffer,
      result.sqrtSlope.buffer,
      result.acc.buffer,
      result.outlet.buffer,
    ]);
  } catch (err) {
    self.postMessage({ type: "error", epoch: data.epoch, id: data.id, error: String(err?.message ?? err) });
  }
};

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
//   { type: "field", epoch, id, z, x0, y0, w, h, url, encoding, tileSize,
//     speedModel, colorBy, deltas }
//       Build the field over global pixels [x0, x0+w) × [y0, y0+h) at zoom z
//       (pixels of the source's tileSize tiles). `url` is the source's tile
//       template ({z}/{x}/{y}); the particles' cells are packed for
//       `speedModel` / `colorBy` (data/workers/flowcells.js). `deltas` are
//       the terrain edits over it (data/workers/flowterrain.js), added to
//       the mosaic before routing.
// Replies (worker → main):
//   { type: "field", epoch, id, result: { z, x0, y0, w, h, elev, dir,
//     sqrtSlope, acc, outlet, cells, colour, speedModel, colorBy, tiles,
//     fallback, failed, ms } }  — arrays
//     transferred; `fallback` tiles came from an ancestor, `failed` ones
//     because a fetch failed (worth retrying)
//   { type: "hand", epoch, id, z, x0, y0, w, h, url, encoding, tileSize,
//     deltas, lines }
//       HAND over the same kind of mosaic, for flood mapping (src/fim/):
//       `lines` are the reaches to burn in, in grid cells (see burnLines in
//       data/workers/hand.js).
// Replies (worker → main), continued:
//   { type: "hand", epoch, id, result: { z, x0, y0, w, h, hand, reach,
//     preview, tiles, fallback, failed, ms } }  — hand / reach transferred.
//     A big field first gets a `preview: true` reply at half resolution
//     (z − 1, possibly half-cell x0 / y0), then the full one.
//   { type: "error", epoch, id, error }
// A request whose epoch is no longer the latest is dropped after its tiles
// load, before the (expensive) routing.
// ====================================================================
import { routeFlow } from "../data/workers/flowroute.js";
import { packFlowCells } from "../data/workers/flowcells.js";
import { applyDeltas } from "../data/workers/flowterrain.js";
import { burnLines, computeHand } from "../data/workers/hand.js";
import { fetchTile } from "./demio.js";

const CACHE_TILES = 96; // ~1 MB each at 512²
// "z/x/y" -> Promise<{ dim, elev } | null (no tile) | FAILED>, LRU order.
const cache = new Map();
// A tile that couldn't be fetched (network, 5xx): filled from its ancestor
// like a missing one, but not cached, and counted so the field is retried.
const FAILED = { failed: true };
let latestEpoch = -1;

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

// The DEM mosaic over global pixels [x0, x0+w) × [y0, y0+h) at zoom z, with
// the terrain edits added: { elev, tiles, fallback, failed }, or null once
// superseded (epoch).
async function buildMosaic({ epoch, z, x0, y0, w, h, url, encoding, tileSize, deltas }) {
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
  if (deltas?.length) applyDeltas(elev, tileSize * n, x0, y0, w, h, deltas);
  return { elev, tiles: tiles.length, fallback, failed };
}

async function buildField(req) {
  const t0 = performance.now();
  const { z, x0, y0, w, h, tileSize, speedModel, colorBy } = req;
  const mosaic = await buildMosaic(req);
  if (!mosaic) return null;
  const { elev, ...counts } = mosaic;
  const routed = routeFlow(elev, w, h, rowMetres(z, y0, h, tileSize));
  const packed = packFlowCells({ w, h, elev, ...routed }, speedModel, colorBy);
  return {
    z, x0, y0, w, h, elev, ...routed, ...packed, speedModel, colorBy, ...counts,
    ms: Math.round(performance.now() - t0),
  };
}

// Above this many cells, a HAND request first gets a half-resolution answer
// from the same mosaic (a quarter of the cells, so ~a quarter of the
// routing time, and no extra tiles), then the full one.
const HAND_PREVIEW_CELLS = 1_500_000;

// The mosaic averaged over 2×2 blocks (ignoring no-data cells), and the
// lines scaled to match.
function halve(elev, w, h, lines) {
  const cw = w >> 1;
  const ch = h >> 1;
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = 2 * y * w + 2 * x;
      let sum = 0;
      let k = 0;
      for (const v of [elev[i], elev[i + 1], elev[i + w], elev[i + w + 1]]) {
        if (v === v) {
          sum += v;
          k++;
        }
      }
      out[y * cw + x] = k ? sum / k : NaN;
    }
  }
  const xy = lines.xy.map((v) => v / 2);
  return { elev: out, w: cw, h: ch, lines: { ...lines, xy } };
}

// HAND for flood mapping (data/workers/hand.js): the mosaic with `lines`
// burned in. `preview(result)` gets the half-resolution answer first, for a
// big field; a request superseded meanwhile isn't finished.
async function buildHand(req, preview) {
  const t0 = performance.now();
  const { z, x0, y0, w, h, lines } = req;
  const mosaic = await buildMosaic(req);
  if (!mosaic) return null;
  const { elev, ...counts } = mosaic;
  if (w * h > HAND_PREVIEW_CELLS && z > 0) {
    const c = halve(elev, w, h, lines);
    const { hand, reach } = computeHand(c.elev, c.w, c.h, burnLines(c.lines, c.w, c.h));
    // Half-cell origins are fine: the field's corners are computed from them.
    preview({
      z: z - 1, x0: x0 / 2, y0: y0 / 2, w: c.w, h: c.h, hand, reach, preview: true, ...counts,
      ms: Math.round(performance.now() - t0),
    });
    // Let a newer request's message in before the full-resolution pass.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (req.epoch !== latestEpoch) return null;
  }
  const { hand, reach } = computeHand(elev, w, h, burnLines(lines, w, h));
  return { z, x0, y0, w, h, hand, reach, ...counts, ms: Math.round(performance.now() - t0) };
}

// Arrays each reply transfers.
const TRANSFER = {
  field: (r) => [r.elev, r.dir, r.sqrtSlope, r.acc, r.outlet, r.cells, r.colour],
  hand: (r) => [r.hand, r.reach],
};

self.onmessage = async ({ data }) => {
  // Any message moves the epoch on; "cancel" does only that, so a build in
  // flight is dropped before its routing.
  latestEpoch = Math.max(latestEpoch, data.epoch);
  if (data.type !== "field" && data.type !== "hand") return;
  try {
    const reply = (result) =>
      self.postMessage(
        { type: data.type, epoch: data.epoch, id: data.id, result },
        TRANSFER[data.type](result).map((a) => a.buffer),
      );
    const result = await (data.type === "hand" ? buildHand(data, reply) : buildField(data));
    if (!result) return;
    reply(result);
  } catch (err) {
    self.postMessage({ type: "error", epoch: data.epoch, id: data.id, error: String(err?.message ?? err) });
  }
};

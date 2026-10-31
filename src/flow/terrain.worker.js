// ====================================================================
// Edited DEM tiles for the map (flow/terrain.js): the source's own tile,
// decoded, with the terrain edits added, re-encoded as PNG. MapLibre's
// raster-dem sources load them through the `flowdem://` protocol.
//
// Protocol (main → worker):
//   { type: "deltas", deltas: [{ key, scale, x0, y0, size, d }] }  set/replace
//   { type: "clear" }                                             drop all
//   { type: "tile", id, url, encoding, z, x, y }
// Replies (worker → main):
//   { id, data }       PNG bytes (transferred)
//   { id, status }     no tile there (404), as the source answered
//   { id, error }
// ====================================================================
import { fetchTile } from "./demio.js";
import { applyDeltas, deltaOverlaps, encodeDem, encodePng } from "../data/workers/flowterrain.js";

// Decoded originals, LRU: the same tiles are re-served at every commit.
const CACHE_TILES = 48;
const cache = new Map(); // url -> Promise<{ dim, elev } | null>
const deltas = new Map(); // key -> delta

function original(url, encoding) {
  let p = cache.get(url);
  if (p) cache.delete(url);
  else p = fetchTile(url, encoding);
  cache.set(url, p);
  p.catch(() => cache.get(url) === p && cache.delete(url));
  while (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
  return p;
}

async function tile({ url, encoding, z, x, y }) {
  const t = await original(url, encoding);
  if (!t) return null;
  const { dim } = t;
  const scale = dim * 2 ** z;
  const over = [...deltas.values()].filter((d) => deltaOverlaps(d, scale, x * dim, y * dim, dim, dim));
  const elev = t.elev.slice();
  applyDeltas(elev, scale, x * dim, y * dim, dim, dim, over);
  return encodePng(encodeDem(elev, encoding), dim, dim);
}

self.onmessage = async ({ data }) => {
  if (data.type === "deltas") {
    for (const d of data.deltas) deltas.set(d.key, d);
  } else if (data.type === "clear") {
    deltas.clear();
  } else if (data.type === "tile") {
    try {
      const png = await tile(data);
      if (png) self.postMessage({ id: data.id, data: png.buffer }, [png.buffer]);
      else self.postMessage({ id: data.id, status: 404 });
    } catch (err) {
      self.postMessage({ id: data.id, error: String(err?.message ?? err) });
    }
  }
};

// ====================================================================
// Terrain edits (flow/terrain.js): elevation deltas laid over the DEM, and
// the DEM re-encoded as a PNG with them applied. Pure, so the flow worker
// (field mosaics) and the terrain worker (map tiles) share it.
//
// A delta is one DEM tile's worth of metres at the zoom it was made at:
// { scale, x0, y0, size, d } with `scale` its world size in pixels
// (tileSize · 2^z), (x0, y0) its corner in those pixels, `d` a
// Float32Array(size²). Edits made at different zooms are all summed.
// ====================================================================

// Samples per axis when a delta is averaged down onto a coarser grid.
const MAX_SAMPLES = 8;

// Do `delta` and the box [x0, x0+w) × [y0, y0+h) at world size `scale`
// overlap?
export function deltaOverlaps(delta, scale, x0, y0, w, h) {
  const k = delta.scale / scale;
  return (
    delta.x0 < (x0 + w) * k && delta.x0 + delta.size > x0 * k &&
    delta.y0 < (y0 + h) * k && delta.y0 + delta.size > y0 * k
  );
}

// Add `deltas` onto `out`: w × h pixels from (x0, y0) at world size
// `scale`. Nearest-neighbour onto a finer grid, a box average (up to
// MAX_SAMPLES² samples) onto a coarser one.
export function applyDeltas(out, scale, x0, y0, w, h, deltas) {
  for (const t of deltas) {
    const k = t.scale / scale; // delta pixels per output pixel
    const T = t.size;
    const ax = Math.max(x0, Math.floor(t.x0 / k));
    const bx = Math.min(x0 + w, Math.ceil((t.x0 + T) / k));
    const ay = Math.max(y0, Math.floor(t.y0 / k));
    const by = Math.min(y0 + h, Math.ceil((t.y0 + T) / k));
    if (ax >= bx || ay >= by) continue;
    const n = k <= 1 ? 1 : Math.min(MAX_SAMPLES, Math.ceil(k));
    const inv = 1 / (n * n);
    const d = t.d;
    for (let Y = ay; Y < by; Y++) {
      let o = (Y - y0) * w + (ax - x0);
      for (let X = ax; X < bx; X++, o++) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const sy = Math.floor((Y + (j + 0.5) / n) * k) - t.y0;
          if (sy < 0 || sy >= T) continue;
          for (let i = 0; i < n; i++) {
            const sx = Math.floor((X + (i + 0.5) / n) * k) - t.x0;
            if (sx < 0 || sx >= T) continue;
            sum += d[sy * T + sx];
          }
        }
        out[o] += sum * inv;
      }
    }
  }
}

// Elevations (metres, NaN = no data) as RGBA in the source's encoding;
// no data is transparent, as it came.
export function encodeDem(elev, encoding) {
  const out = new Uint8ClampedArray(elev.length * 4);
  const terrarium = encoding !== "mapbox";
  for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
    const e = elev[i];
    if (e !== e) continue;
    let v = terrarium ? Math.round((e + 32768) * 256) : Math.round((e + 10000) * 10);
    v = Math.max(0, Math.min(0xffffff, v));
    out[p] = v >> 16;
    out[p + 1] = (v >> 8) & 255;
    out[p + 2] = v & 255;
    out[p + 3] = 255;
  }
  return out;
}

// ---- PNG -----------------------------------------------------------
// Written by hand rather than through a canvas: browsers with
// fingerprinting protection perturb canvas exports as well as readbacks,
// and a flipped byte here is a 256 m spike.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// RGBA bytes (w × h) as a PNG file. Rows are unfiltered: elevation bytes
// compress poorly either way, and this is on the tile path.
export async function encodePng(rgba, w, h) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  // "deflate" is the zlib format, which is what IDAT holds.
  const zlib = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer(),
  );
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

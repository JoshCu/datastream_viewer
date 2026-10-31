// ====================================================================
// DEM tile fetch + decode, for the workers that read the map's raster-dem
// tiles themselves (flow.worker.js for the field, terrain.worker.js for the
// edited map tiles). Worker-side: OffscreenCanvas / VideoFrame, no DOM.
// ====================================================================

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

// Browsers with fingerprinting protection (Firefox's, Brave's) perturb a few
// bytes of every canvas readback. In a DEM that's a ±256 m spike wherever a
// red byte is hit, so check once, as MapLibre does (its DEM tiles go the same
// way): draw known bytes and read them back.
let canvasDistorted = null;
function isCanvasDistorted() {
  if (canvasDistorted != null) return canvasDistorted;
  const n = 5;
  const ctx = new OffscreenCanvas(n, n).getContext("2d", { willReadFrequently: true });
  for (let i = 0; i < n * n; i++) {
    ctx.fillStyle = `rgb(${i * 4},${i * 4 + 1},${i * 4 + 2})`;
    ctx.fillRect(i % n, Math.floor(i / n), 1, 1);
  }
  const { data } = ctx.getImageData(0, 0, n, n);
  canvasDistorted = data.some((v, i) => i % 4 !== 3 && v !== i);
  return canvasDistorted;
}

// The bitmap's RGBA bytes through VideoFrame, which the fingerprinting
// protection leaves alone, or null if the frame isn't in an RGB format.
async function readVideoFrame(bmp) {
  if (typeof VideoFrame === "undefined") return null;
  const frame = new VideoFrame(bmp, { timestamp: 0 });
  try {
    const format = frame.format;
    if (!format || !(format.startsWith("RGB") || format.startsWith("BGR"))) return null;
    const data = new Uint8ClampedArray(bmp.width * bmp.height * 4);
    await frame.copyTo(data);
    const bgr = format.startsWith("BGR");
    const opaque = format.endsWith("X"); // RGBX / BGRX: the fourth byte is padding
    for (let p = 0; p < data.length; p += 4) {
      if (bgr) {
        const r = data[p + 2];
        data[p + 2] = data[p];
        data[p] = r;
      }
      if (opaque) data[p + 3] = 255;
    }
    return data;
  } finally {
    frame.close();
  }
}

function readCanvas(bmp) {
  const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, bmp.width, bmp.height).data;
}

// { dim, elev } (metres, NaN = no data), or null where there's no tile
// (404 / 204: past the data's zoom). Throws on any other failure.
export async function fetchTile(url, encoding) {
  const res = await fetch(url);
  // 404 (past the data's zoom) and 204 (no tile) both mean "use the parent".
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`DEM tile ${res.status}: ${url}`);
  // No colour management or premultiplication: the RGB bytes are the data.
  const bmp = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  try {
    const data = (isCanvasDistorted() && (await readVideoFrame(bmp).catch(() => null))) || readCanvas(bmp);
    return { dim: bmp.width, elev: decode(data, encoding) };
  } finally {
    bmp.close();
  }
}

// ====================================================================
// The NEXRAD point clouds: one deck.gl PointCloudLayer per radar in a
// MapboxOverlay.
//
// deck.gl is only fetched the first time a scan is shown, and renders on
// WebGPU where available, WebGL2 otherwise. Gate positions are
// metres east/north of the radar (METER_OFFSETS around the site), z metres
// above sea level; vertical exaggeration is a model-matrix scale on z, so
// changing it doesn't rebuild anything. A radar's display arrays are rebuilt
// only when its volume, the product, the threshold or the tilt changes; the
// fade only rewrites the colours' alpha.
// ====================================================================
import { map, nexradState } from "../state.js";
import { PRODUCTS, LUT_SIZE, colorLut } from "./products.js";

// ES modules rather than deck.gl's UMD bundle: the UMD's `window.luma` only
// carries a subset of @luma.gl/core, which the WebGPU adapter can't extend.
// esm.sh resolves every package's @luma.gl/core range to the same module, so
// deck and both adapters share one luma instance.
const ESM = "https://esm.sh";
const DECK_VERSION = "9.4.0";
const LUMA_VERSION = "9.4.2";

let deckPromise = null;
let overlay = null;

// WebGPU when the browser can actually hand out an adapter (navigator.gpu can
// exist with none, e.g. blocklisted GPUs), WebGL2 otherwise. The overlay draws
// on its own canvas (not interleaved), so it doesn't need MapLibre's context.
async function deviceProps() {
  const { webgl2Adapter } = await import(`${ESM}/@luma.gl/webgl@${LUMA_VERSION}`);
  const gpu = await navigator.gpu?.requestAdapter().catch(() => null);
  if (!gpu) return { type: "webgl", adapters: [webgl2Adapter] };
  const { webgpuAdapter } = await import(`${ESM}/@luma.gl/webgpu@${LUMA_VERSION}`);
  return { type: "webgpu", adapters: [webgpuAdapter, webgl2Adapter] };
}

function loadDeck() {
  deckPromise ??= Promise.all([
    import(`${ESM}/@deck.gl/core@${DECK_VERSION}`),
    import(`${ESM}/@deck.gl/layers@${DECK_VERSION}`),
    import(`${ESM}/@deck.gl/mapbox@${DECK_VERSION}`),
    deviceProps(),
  ]).then(
    ([{ COORDINATE_SYSTEM }, { PointCloudLayer }, { MapboxOverlay }, device]) => ({
      COORDINATE_SYSTEM,
      PointCloudLayer,
      MapboxOverlay,
      deviceProps: device,
    }),
    (err) => {
      deckPromise = null;
      throw new Error("Couldn't load deck.gl", { cause: err });
    },
  );
  return deckPromise;
}

// Floor for faded alpha, so gates just past the threshold stay faintly visible.
const MIN_FADE_ALPHA = 0.03;

// Write each gate's alpha into `colors` from how far its value sits past the
// threshold: t^fade, with t = 0 at the threshold and 1 at the end of the
// product's range (|value| for signed moments). Low values turn see-through
// first; fade 0 leaves every gate opaque.
function writeAlpha(colors, points, product, threshold, fade) {
  const lo = product.signed ? threshold : Math.max(threshold, product.min);
  const hi = product.signed ? Math.max(-product.min, product.max) : product.max;
  const span = hi - lo;
  for (let n = 0; n < points.count; n++) {
    let a = 1;
    if (fade > 0 && span > 0) {
      const v = product.signed ? Math.abs(points.values[n]) : points.values[n];
      const t = Math.min(1, Math.max(0, (v - lo) / span));
      a = Math.max(MIN_FADE_ALPHA, t ** fade);
    }
    colors[n * 4 + 3] = Math.round(a * 255);
  }
}

// Flatten the selected tilt(s) of `volume` into deck attribute arrays,
// keeping only gates past the threshold.
export function buildPoints(volume, { threshold, cut, fade = 0 }) {
  const product = PRODUCTS[volume.moment];
  const keep = product.signed ? (v) => Math.abs(v) >= threshold : (v) => v >= threshold;
  const cuts = cut < 0 ? volume.cuts.map((c, i) => [c, i]) : [[volume.cuts[cut], cut]];

  let count = 0;
  for (const [c] of cuts) for (let i = 0; i < c.v.length; i++) if (keep(c.v[i])) count++;

  const lut = colorLut(product);
  const span = product.max - product.min;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  const values = new Float32Array(count);
  const cutOf = new Uint8Array(count);
  let n = 0;
  for (const [c, ci] of cuts) {
    for (let i = 0; i < c.v.length; i++) {
      const v = c.v[i];
      if (!keep(v)) continue;
      positions[n * 3] = c.x[i];
      positions[n * 3 + 1] = c.y[i];
      positions[n * 3 + 2] = c.z[i];
      const t = Math.min(1, Math.max(0, (v - product.min) / span));
      const k = Math.round(t * (LUT_SIZE - 1)) * 3;
      colors[n * 4] = lut[k];
      colors[n * 4 + 1] = lut[k + 1];
      colors[n * 4 + 2] = lut[k + 2];
      values[n] = v;
      cutOf[n] = ci;
      n++;
    }
  }
  const points = { count, positions, colors, values, cutOf };
  writeAlpha(colors, points, product, threshold, fade);
  return points;
}

// The cut of `volume` nearest `tilt` (degrees), or -1 (every cut) for null.
// Radars on different VCPs don't scan the same angles, so each one draws its
// own closest tilt.
function cutFor(volume, tilt) {
  if (tilt == null) return -1;
  let best = 0;
  volume.cuts.forEach((c, i) => {
    if (Math.abs(c.angle - tilt) < Math.abs(volume.cuts[best].angle - tilt)) best = i;
  });
  return best;
}

const layerId = (radar) => `nexrad-${radar.key}`;

function tooltip({ index, layer }) {
  if (!layer || index < 0) return null;
  const radar = nexradState.radars.find((r) => layerId(r) === layer.id);
  if (!radar?.points) return null;
  const { volume, points } = radar;
  const { units } = PRODUCTS[volume.moment];
  const v = points.values[index];
  const tilt = volume.cuts[points.cutOf[index]].angle;
  const km = (points.positions[index * 3 + 2] / 1000).toFixed(1);
  return {
    text: `${volume.icao}: ${v.toFixed(volume.moment === "RHO" ? 3 : 1)} ${units}\n${km} km MSL · ${tilt.toFixed(1)}° tilt`,
  };
}

function layerOf(deck, radar) {
  const { site } = radar.volume;
  const k = nexradState.exaggeration;
  return new deck.PointCloudLayer({
    id: layerId(radar),
    data: {
      length: radar.points.count,
      attributes: {
        getPosition: { value: radar.points.positions, size: 3 },
        getColor: { value: radar.points.colors, size: 4, normalized: true },
      },
    },
    coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS,
    coordinateOrigin: [site.lon, site.lat, 0],
    modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, k, 0, 0, 0, 0, 1],
    pointSize: nexradState.pointSize,
    sizeUnits: "pixels",
    opacity: nexradState.opacity,
    // Translucent points mustn't write depth: a point drawn later but further
    // away would fail the depth test and vanish instead of blending, which
    // shows where one radar's cloud overlaps another's. Opaque points keep
    // depth so nearer gates still hide farther ones.
    parameters: { depthWriteEnabled: nexradState.opacity >= 1 && !nexradState.fade },
    material: false,
    pickable: true,
  });
}

// Redraw every radar that has points, with the current display settings
// (size, opacity, exaggeration). Also how a removed radar disappears.
export async function renderNexrad() {
  const shown = nexradState.radars.filter((r) => r.points);
  if (!shown.length) {
    overlay?.setProps({ layers: [] });
    return;
  }
  const deck = await loadDeck();
  if (!overlay) {
    overlay = new deck.MapboxOverlay({
      interleaved: false,
      deviceProps: deck.deviceProps,
      getTooltip: tooltip,
      onDeviceInitialized: (device) => console.info(`NEXRAD: deck.gl on ${device.type}`),
    });
    map.addControl(overlay);
  }
  // Re-read: a radar can be removed while deck.gl is loading.
  overlay.setProps({ layers: nexradState.radars.filter((r) => r.points).map((r) => layerOf(deck, r)) });
}

// Rebuild the points of `radars` (default: all of them) from their volumes
// and the shared threshold/tilt, then redraw.
export async function rebuildNexrad(radars = nexradState.radars) {
  for (const r of radars) {
    r.points = r.volume
      ? buildPoints(r.volume, {
          threshold: nexradState.threshold,
          cut: cutFor(r.volume, nexradState.tilt),
          fade: nexradState.fade,
        })
      : null;
  }
  await renderNexrad();
}

// Re-apply the fade to every radar's points without rebuilding them, then
// redraw. Each gets a fresh colors array: deck only re-uploads an attribute
// whose value changed identity.
export async function refadeNexrad() {
  for (const r of nexradState.radars) {
    if (!r.points) continue;
    const colors = r.points.colors.slice();
    writeAlpha(colors, r.points, PRODUCTS[r.volume.moment], nexradState.threshold, nexradState.fade);
    r.points.colors = colors;
  }
  await renderNexrad();
}

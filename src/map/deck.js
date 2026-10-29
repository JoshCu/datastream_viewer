// ====================================================================
// deck.gl for every deck-drawn mode (NEXRAD point clouds, flow particles).
//
// deck.gl is only fetched the first time something is shown, and renders on
// WebGPU where available, WebGL2 otherwise. Each mode (`owner`) gets its own
// MapboxOverlay, made on its first layers: an overlay redraws all its
// layers whenever any of them changes, so the flow particles, which change
// every frame, would otherwise redraw millions of radar points every frame
// too. The overlays are separate canvases, stacked in the order they were
// first used.
// ====================================================================
import { map } from "../state.js";

// ES modules rather than deck.gl's UMD bundle: the UMD's `window.luma` only
// carries a subset of @luma.gl/core, which the WebGPU adapter can't extend.
// esm.sh resolves every package's @luma.gl/core range to the same module, so
// deck and both adapters share one luma instance. @deck.gl/core is pinned in
// the others' deps too: left to their `^` range, esm.sh hands them the newest
// core, and deck refuses to run with two versions loaded.
const ESM = "https://esm.sh";
const DECK_VERSION = "9.4.0";
const LUMA_VERSION = "9.4.2";
const DECK_DEPS = `?deps=@deck.gl/core@${DECK_VERSION}`;

let deckPromise = null;
let deck = null; // the resolved loadDeck() value
const overlays = new Map(); // owner -> MapboxOverlay
const tooltips = new Map(); // owner -> (info) => tooltip | null

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

// { COORDINATE_SYSTEM, PointCloudLayer, LineLayer, MapboxOverlay, deviceProps }
export function loadDeck() {
  deckPromise ??= Promise.all([
    import(`${ESM}/@deck.gl/core@${DECK_VERSION}`),
    import(`${ESM}/@deck.gl/layers@${DECK_VERSION}${DECK_DEPS}`),
    import(`${ESM}/@deck.gl/mapbox@${DECK_VERSION}${DECK_DEPS}`),
    deviceProps(),
  ]).then(
    ([{ COORDINATE_SYSTEM }, { PointCloudLayer, LineLayer }, { MapboxOverlay }, device]) =>
      (deck = {
        COORDINATE_SYSTEM,
        PointCloudLayer,
        LineLayer,
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

// Register `owner`'s tooltip (called with deck's pick info; return null for
// none). Set it before the owner's first layers.
export function setDeckTooltip(owner, fn) {
  tooltips.set(owner, fn);
}

// Replace `owner`'s layers and redraw them. Layers are built from
// loadDeck()'s classes, so it has resolved by the time any arrive; clearing
// before then is a no-op.
export function setDeckLayers(owner, layers) {
  let overlay = overlays.get(owner);
  if (!overlay) {
    if (!layers.length) return;
    const getTooltip = tooltips.get(owner);
    overlay = new deck.MapboxOverlay({
      interleaved: false,
      deviceProps: deck.deviceProps,
      ...(getTooltip && { getTooltip }),
      onDeviceInitialized: (device) => console.info(`${owner}: deck.gl on ${device.type}`),
    });
    map.addControl(overlay);
    overlays.set(owner, overlay);
  }
  overlay.setProps({ layers });
}

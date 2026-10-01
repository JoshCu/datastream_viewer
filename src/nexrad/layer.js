// ====================================================================
// The NEXRAD point cloud: a deck.gl PointCloudLayer in a MapboxOverlay.
//
// deck.gl is only fetched the first time a scan is shown. Gate positions are
// metres east/north of the radar (METER_OFFSETS around the site), z metres
// above sea level; vertical exaggeration is a model-matrix scale on z, so
// changing it doesn't rebuild anything. The display arrays are rebuilt only
// when the volume, product, threshold or tilt changes.
// ====================================================================
import { map, nexradState } from "../state.js";
import { PRODUCTS, LUT_SIZE, colorLut } from "./products.js";

const DECK_URL = "https://unpkg.com/deck.gl@9.4.0/dist.min.js";

let deckPromise = null;
let overlay = null;
let points = null; // { count, positions, colors, values, cutOf }

function loadDeck() {
  deckPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DECK_URL;
    script.onload = () => resolve(window.deck);
    script.onerror = () => {
      deckPromise = null;
      reject(new Error("Couldn't load deck.gl"));
    };
    document.head.append(script);
  });
  return deckPromise;
}

// Flatten the selected tilt(s) of `volume` into deck attribute arrays,
// keeping only gates past the threshold.
export function buildPoints(volume, { threshold, cut }) {
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
      colors[n * 4 + 3] = 255;
      values[n] = v;
      cutOf[n] = ci;
      n++;
    }
  }
  return { count, positions, colors, values, cutOf };
}

function tooltip({ index, layer }) {
  if (!layer || index < 0 || !points || !nexradState.volume) return null;
  const { units } = PRODUCTS[nexradState.volume.moment];
  const v = points.values[index];
  const tilt = nexradState.volume.cuts[points.cutOf[index]].angle;
  const km = (points.positions[index * 3 + 2] / 1000).toFixed(1);
  return {
    text: `${v.toFixed(nexradState.volume.moment === "RHO" ? 3 : 1)} ${units}\n${km} km MSL · ${tilt.toFixed(1)}° tilt`,
  };
}

function layerOf(deck) {
  const { site } = nexradState.volume;
  const k = nexradState.exaggeration;
  return new deck.PointCloudLayer({
    id: "nexrad",
    data: {
      length: points.count,
      attributes: {
        getPosition: { value: points.positions, size: 3 },
        getColor: { value: points.colors, size: 4, normalized: true },
      },
    },
    coordinateSystem: deck.COORDINATE_SYSTEM.METER_OFFSETS,
    coordinateOrigin: [site.lon, site.lat, 0],
    modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, k, 0, 0, 0, 0, 1],
    pointSize: nexradState.pointSize,
    sizeUnits: "pixels",
    opacity: nexradState.opacity,
    material: false,
    pickable: true,
  });
}

// Redraw with the current display settings (size, opacity, exaggeration).
export async function renderNexrad() {
  if (!nexradState.volume || !points) return;
  const deck = await loadDeck();
  if (!overlay) {
    overlay = new deck.MapboxOverlay({ interleaved: false, getTooltip: tooltip });
    map.addControl(overlay);
  }
  overlay.setProps({ layers: [layerOf(deck)] });
}

// Rebuild the points from nexradState (volume, threshold, tilt) and redraw.
// Returns the number of points drawn.
export async function rebuildNexrad() {
  points = nexradState.volume ? buildPoints(nexradState.volume, nexradState) : null;
  if (points) await renderNexrad();
  else overlay?.setProps({ layers: [] });
  return points?.count ?? 0;
}

// ====================================================================
// The NEXRAD point clouds: one deck.gl PointCloudLayer per radar in a
// MapboxOverlay.
//
// deck.gl is only fetched the first time a scan is shown. Gate positions are
// metres east/north of the radar (METER_OFFSETS around the site), z metres
// above sea level; vertical exaggeration is a model-matrix scale on z, so
// changing it doesn't rebuild anything. A radar's display arrays are rebuilt
// only when its volume, the product, the threshold or the tilt changes.
// ====================================================================
import { map, nexradState } from "../state.js";
import { PRODUCTS, LUT_SIZE, colorLut } from "./products.js";

const DECK_URL = "https://unpkg.com/deck.gl@9.4.0/dist.min.js";

let deckPromise = null;
let overlay = null;

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
    overlay = new deck.MapboxOverlay({ interleaved: false, getTooltip: tooltip });
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
      ? buildPoints(r.volume, { threshold: nexradState.threshold, cut: cutFor(r.volume, nexradState.tilt) })
      : null;
  }
  await renderNexrad();
}

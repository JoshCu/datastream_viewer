// ====================================================================
// Flowpaths line paint, with the hovered-reach highlight folded in. The
// hovered reach (feature-state "hover", set by map/interactions.js) is drawn
// in its inverted colour and a little wider than its neighbours, so it's
// clear where one reach ends and the next begins. Every writer of a layer's
// line-color / line-width (basemap, a loaded run, the live sim) goes through
// setFlowpathPaint, so the highlight survives whatever the layer is showing;
// flowpathPaint returns the unwrapped value for saving and restoring.
// ====================================================================
import { map } from "../state.js";

const HOVER = ["boolean", ["feature-state", "hover"], false];
const GROW_PX = 1.5;

// Width curve over zoom, by stream order at low zoom and true ground width
// (property `prop` × `toMetres`) close in. Shared by both reach networks.
function widthCurve(prop, toMetres) {
  const w = ["*", ["coalesce", ["get", prop], 0], toMetres];
  return [
    "interpolate", ["exponential", 2], ["zoom"],
    // low zoom: purely cartographic, by order
    4, ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.3, 8, 3],
    8, ["max",
         ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.6, 8, 5],
         ["*", w, 0.00327]],
    12, ["max",
         ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 1, 8, 7],
         ["*", w, 0.0523]],
    // high zoom: true ground width, with a 1px floor
    16, ["max", 1, ["*", w, 0.837]],
    22, ["max", 1, ["*", w, 53.6]],
  ];
}

// The basemap's own flowpaths paint, before any run or sim restyles it.
// Hydrofabric widths are in cm.
export const BASE_FLOWPATH_PAINT = {
  "line-color": "rgb(0, 119, 187)",
  "line-width": widthCurve("widthcm", 0.01),
};

// The NWM flowlines' paint: RouteLink TopWdth (m), which the tiles carry only
// from z7 (z0–6 have just the id and order, hence the coalesce). A different
// blue from the hydrofabric's so the two networks read apart when both are on.
export const BASE_NWM_PAINT = {
  "line-color": "rgb(0, 150, 136)",
  "line-width": widthCurve("TopWdth", 1),
};

const isZoomCurve = (e) =>
  Array.isArray(e) &&
  (e[0] === "interpolate" || e[0] === "step") &&
  Array.isArray(e[e[0] === "step" ? 1 : 2]) &&
  e[e[0] === "step" ? 1 : 2][0] === "zoom";

function inverted(color) {
  const ch = (i) => ["-", 255, ["at", i, ["var", "c"]]];
  return [
    "let", "c", ["to-rgba", color],
    ["rgba", ch(0), ch(1), ch(2), ["at", 3, ["var", "c"]]],
  ];
}

// A zoom curve must stay the outermost expression, so a case on feature-state
// goes inside each of its stop outputs instead of around it: `fn` gets each
// output (or `width` itself, if it isn't a zoom curve).
export function mapWidthStops(width, fn) {
  if (isZoomCurve(width)) {
    const first = width[0] === "step" ? 2 : 4;
    return width.map((v, i) => (i >= first && (i - first) % 2 === 0 ? mapWidthStops(v, fn) : v));
  }
  return fn(width);
}

function wider(width) {
  return mapWidthStops(width, (w) => ["case", HOVER, ["+", w, GROW_PX], w]);
}

export function withHover(prop, value) {
  if (prop === "line-color") return ["case", HOVER, inverted(value), value];
  if (prop === "line-width") return wider(value);
  return value;
}

// Per line layer: what it's currently showing, unwrapped.
const current = {
  flowpaths: { ...BASE_FLOWPATH_PAINT },
  "nwm-flowlines": { ...BASE_NWM_PAINT },
};

export function flowpathPaint(prop, layer = "flowpaths") {
  return current[layer][prop];
}

export function setFlowpathPaint(prop, value, layer = "flowpaths") {
  current[layer][prop] = value;
  if (map.getLayer(layer)) map.setPaintProperty(layer, prop, withHover(prop, value));
}

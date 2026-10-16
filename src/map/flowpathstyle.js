// ====================================================================
// Flowpaths line paint, with the hovered-reach highlight folded in. The
// hovered reach (feature-state "hover", set by map/interactions.js) is drawn
// in its inverted colour and a little wider than its neighbours, so it's
// clear where one reach ends and the next begins. Every writer of the layer's
// line-color / line-width (basemap, a loaded run, the live sim) goes through
// setFlowpathPaint, so the highlight survives whatever the layer is showing;
// flowpathPaint returns the unwrapped value for saving and restoring.
// ====================================================================
import { map } from "../state.js";

const HOVER = ["boolean", ["feature-state", "hover"], false];
const GROW_PX = 1.5;

// The basemap's own flowpaths paint, before any run or sim restyles it.
export const BASE_FLOWPATH_PAINT = {
  "line-color": "rgb(0, 119, 187)",
  "line-width": [
    "interpolate", ["exponential", 2], ["zoom"],
    // low zoom: purely cartographic, by order
    4, ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.3, 8, 3],
    8, ["max",
         ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 0.6, 8, 5],
         ["*", ["coalesce", ["get", "widthcm"], 0], 0.0000327]],
    12, ["max",
         ["interpolate", ["exponential", 1.6], ["get", "order"], 1, 1, 8, 7],
         ["*", ["coalesce", ["get", "widthcm"], 0], 0.000523]],
    // high zoom: true ground width, with a 1px floor
    16, ["max", 1, ["*", ["coalesce", ["get", "widthcm"], 0], 0.00837]],
    22, ["max", 1, ["*", ["coalesce", ["get", "widthcm"], 0], 0.536]],
  ],
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

// A zoom curve must stay the outermost expression, so the hover case goes
// inside each of its stop outputs instead of around it.
function wider(width) {
  if (isZoomCurve(width)) {
    const first = width[0] === "step" ? 2 : 4;
    return width.map((v, i) => (i >= first && (i - first) % 2 === 0 ? wider(v) : v));
  }
  return ["case", HOVER, ["+", width, GROW_PX], width];
}

export function withHover(prop, value) {
  if (prop === "line-color") return ["case", HOVER, inverted(value), value];
  if (prop === "line-width") return wider(value);
  return value;
}

let current = { ...BASE_FLOWPATH_PAINT };

export function flowpathPaint(prop) {
  return current[prop];
}

export function setFlowpathPaint(prop, value) {
  current[prop] = value;
  map.setPaintProperty("flowpaths", prop, withHover(prop, value));
}

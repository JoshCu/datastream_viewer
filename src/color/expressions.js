// ====================================================================
// MapLibre paint expressions for the results color ramp / line width
// ====================================================================
import { state } from "../state.js";
import { PALETTE, RESULT_VALUE, NO_DATA_COLOR } from "../config.js";
import { scaleTransform, strictlyIncreasing } from "./scales.js";
import { resultSamples, quantileOf, resultBreaks } from "./breaks.js";

// Build the color ramp expression for the active scale. Transform scales
// spread the palette evenly in transformed space; distribution scales place
// stops (or discrete steps) at data-derived breakpoints.
export function resultColorStops(bounds) {
  const N = PALETTE.length;
  const V = RESULT_VALUE;

  if (state.scale === "quantile") {
    // Continuous, but stops sit at data percentiles for an even spread.
    const samples = resultSamples();
    const values = strictlyIncreasing(
      PALETTE.map((_, i) => quantileOf(samples, i / (N - 1))),
    );
    const stops = PALETTE.flatMap((color, i) => [values[i], color]);
    return ["interpolate", ["linear"], V, ...stops];
  }

  if (state.scale === "jenks" || state.scale === "quantile-classes") {
    // Discrete classes via a step expression.
    const breaks = resultBreaks(state.scale, N); // N-1 interior boundaries
    const args = [];
    for (let i = 0; i < breaks.length; i++)
      args.push(breaks[i], PALETTE[i + 1]);
    return ["step", V, PALETTE[0], ...args];
  }

  // Continuous transform scales (linear, log, sqrt, cbrt, symlog).
  const { input, a, b } = scaleTransform(bounds);
  const hi = b > a ? b : a + 1;
  const stops = PALETTE.flatMap((color, i) => [
    a + ((hi - a) * i) / (N - 1),
    color,
  ]);
  return ["interpolate", ["linear"], input, ...stops];
}

export function resultColorExpression(bounds) {
  return [
    "case",
    ["<=", RESULT_VALUE, -9998],
    NO_DATA_COLOR,
    resultColorStops(bounds),
  ];
}

export function resultWidthExpression(bounds) {
  const max = bounds.max > bounds.min ? bounds.max : bounds.min + 1;
  return [
    "case",
    ["<=", RESULT_VALUE, -9998],
    0,
    ["interpolate", ["linear"], RESULT_VALUE, bounds.min, 1.5, max, 7],
  ];
}

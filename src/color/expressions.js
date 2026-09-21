// ====================================================================
// MapLibre paint expressions for the results color ramp / line width
// ====================================================================
import { state } from "../state.js";
import { PALETTE, DIFF_PALETTE, RESULT_VALUE, NO_DATA_COLOR } from "../config.js";
import { scaleTransform, strictlyIncreasing } from "./scales.js";
import { resultSamples, quantileOf, resultBreaks } from "./breaks.js";

// Build the color ramp expression for the active scale. Transform scales
// spread the palette evenly in transformed space; distribution scales place
// stops (or discrete steps) at data-derived breakpoints. A diff dataset
// swaps in the diverging palette (symmetric bounds put its pale center stop
// on zero difference).
export function resultColorStops(bounds) {
  const palette = state.data?.isDiff ? DIFF_PALETTE : PALETTE;
  const N = palette.length;
  const V = RESULT_VALUE;

  if (state.scale === "quantile") {
    // Continuous, but stops sit at data percentiles for an even spread.
    const samples = resultSamples();
    const values = strictlyIncreasing(
      palette.map((_, i) => quantileOf(samples, i / (N - 1))),
    );
    const stops = palette.flatMap((color, i) => [values[i], color]);
    return ["interpolate", ["linear"], V, ...stops];
  }

  if (state.scale === "jenks" || state.scale === "quantile-classes") {
    // Discrete classes via a step expression.
    const breaks = resultBreaks(state.scale, N); // N-1 interior boundaries
    const args = [];
    for (let i = 0; i < breaks.length; i++)
      args.push(breaks[i], palette[i + 1]);
    return ["step", V, palette[0], ...args];
  }

  // Continuous transform scales (linear, log, sqrt, cbrt, symlog).
  const { input, a, b } = scaleTransform(bounds);
  const hi = b > a ? b : a + 1;
  const stops = palette.flatMap((color, i) => [
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
  // Diff bounds are symmetric around zero; width should track the magnitude
  // of the difference in either direction, not a min→max ramp that would
  // make "no difference" render as a mid-width line.
  if (state.data?.isDiff) {
    const maxAbs = Math.max(Math.abs(bounds.min), Math.abs(bounds.max)) || 1;
    return [
      "case",
      ["<=", RESULT_VALUE, -9998],
      0,
      ["interpolate", ["linear"], ["abs", RESULT_VALUE], 0, 1.5, maxAbs, 7],
    ];
  }

  const max = bounds.max > bounds.min ? bounds.max : bounds.min + 1;
  return [
    "case",
    ["<=", RESULT_VALUE, -9998],
    0,
    ["interpolate", ["linear"], RESULT_VALUE, bounds.min, 1.5, max, 7],
  ];
}

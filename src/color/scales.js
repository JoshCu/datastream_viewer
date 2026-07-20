// ====================================================================
// Continuous color-scale transforms
// ====================================================================
import { state } from "../state.js";
import { RESULT_VALUE } from "../config.js";

// Continuous transform scales: map the feature-state value to an
// interpolate() input expression, plus the transformed data-range
// endpoints a (at min) and b (at max) where the palette stops are spread.
export function scaleTransform(bounds) {
  const V = RESULT_VALUE;
  const min = bounds.min;
  const max = bounds.max;
  switch (state.scale) {
    case "log": {
      // Floor to a small positive number so zeros and min don't blow up.
      const lo = Math.max(min, 1e-6);
      const hi = Math.max(max, lo * 10);
      return {
        input: ["log10", ["max", V, lo]],
        a: Math.log10(lo),
        b: Math.log10(hi),
      };
    }
    case "sqrt":
      return powerTransform(V, min, max, 0.5);
    case "cbrt":
      return powerTransform(V, min, max, 1 / 3);
    case "symlog": {
      // Linear within +/- linthresh, log10 beyond; continuous at linthresh.
      const lt = Math.max(max / 100, 1e-6);
      const s = (v) =>
        v <= lt ? v / lt : 1 + Math.log10(Math.max(v, 1e-9) / lt);
      const input = [
        "case",
        ["<=", V, lt],
        ["/", V, lt],
        ["+", 1, ["log10", ["/", ["max", V, 1e-9], lt]]],
      ];
      return { input, a: s(min), b: s(max) };
    }
    case "linear":
    default:
      return { input: V, a: min, b: max };
  }
}

// PowerNorm-style: color position = ((v-min)/range)^gamma. gamma < 1
// spreads low values out (0.5 = square root, ~0.33 = cube root), taming
// outliers less aggressively than log.
export function powerTransform(V, min, max, gamma) {
  const range = max > min ? max - min : 1;
  const input = ["^", ["/", ["-", ["max", V, min], min], range], gamma];
  return { input, a: 0, b: 1 };
}

export function strictlyIncreasing(values) {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    if (!(out[i] > out[i - 1])) out[i] = out[i - 1] + 1e-6;
  }
  return out;
}

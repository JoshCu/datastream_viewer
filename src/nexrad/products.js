// ====================================================================
// NEXRAD moments: labels, display ranges and colour ramps (pure).
//
// `stops` are [value, colour]; `stepped` ramps hold each colour until the next
// stop (the familiar NWS reflectivity bands), the rest interpolate. The
// threshold hides weak gates: value ≥ threshold, or |value| ≥ threshold for a
// signed moment like velocity.
// ====================================================================

export const PRODUCTS = {
  REF: {
    label: "Reflectivity",
    units: "dBZ",
    min: -10,
    max: 75,
    threshold: 20,
    stepped: true,
    stops: [
      [-10, "#3a4656"],
      [5, "#04e9e7"],
      [10, "#019ff4"],
      [15, "#0300f4"],
      [20, "#02fd02"],
      [25, "#01c501"],
      [30, "#008e00"],
      [35, "#fdf802"],
      [40, "#e5bc00"],
      [45, "#fd9500"],
      [50, "#fd0000"],
      [55, "#d40000"],
      [60, "#bc0000"],
      [65, "#f800fd"],
      [70, "#9854c6"],
      [75, "#fdfdfd"],
    ],
  },
  VEL: {
    label: "Radial velocity",
    units: "m/s",
    min: -40,
    max: 40,
    threshold: 5,
    signed: true,
    stops: [
      [-40, "#02fcfc"],
      [-25, "#00a000"],
      [-10, "#90f090"],
      [0, "#707070"],
      [10, "#f09090"],
      [25, "#c00000"],
      [40, "#ffd400"],
    ],
  },
  ZDR: {
    label: "Differential reflectivity",
    units: "dB",
    min: -2,
    max: 6,
    threshold: -2,
    stops: [
      [-2, "#404040"],
      [0, "#a0a0a0"],
      [1, "#4060ff"],
      [2, "#40c040"],
      [3, "#ffff40"],
      [4, "#ff8000"],
      [6, "#ff00ff"],
    ],
  },
  RHO: {
    label: "Correlation coefficient",
    units: "",
    min: 0.2,
    max: 1.05,
    threshold: 0.8,
    stops: [
      [0.2, "#202060"],
      [0.7, "#4040ff"],
      [0.85, "#40c0ff"],
      [0.9, "#40ff80"],
      [0.95, "#ffff40"],
      [0.98, "#ff8000"],
      [1.0, "#ff0000"],
      [1.05, "#ff80ff"],
    ],
  },
};

export const LUT_SIZE = 256;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Colour at `value` along the product's ramp, as [r, g, b].
function colorAt(product, value) {
  const { stops, stepped } = product;
  if (value <= stops[0][0]) return rgb(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (value >= v1) continue;
    const [v0, c0] = stops[i - 1];
    if (stepped) return rgb(c0);
    const t = (value - v0) / (v1 - v0);
    const a = rgb(c0);
    const b = rgb(c1);
    return a.map((x, k) => Math.round(x + (b[k] - x) * t));
  }
  return rgb(stops[stops.length - 1][1]);
}

// RGB lookup table over [min, max]: entry i is the colour at
// min + i / (LUT_SIZE - 1) × (max - min).
export function colorLut(product) {
  const lut = new Uint8Array(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const v = product.min + (i / (LUT_SIZE - 1)) * (product.max - product.min);
    lut.set(colorAt(product, v), i * 3);
  }
  return lut;
}

// CSS gradient for the legend bar, sampled from the same ramp.
export function legendCss(product) {
  const n = 32;
  const parts = [];
  for (let i = 0; i <= n; i++) {
    const v = product.min + (i / n) * (product.max - product.min);
    parts.push(`rgb(${colorAt(product, v).join(",")}) ${((i / n) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

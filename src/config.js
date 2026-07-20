// ====================================================================
// Shared constants
// ====================================================================

// Empty "any" matches nothing — used to hide layers by default.
export const HIDDEN_FILTER = ["any"];

export const VARIABLES = {
  flow: { label: "Flow", units: "m³/s" },
  velocity: { label: "Velocity", units: "m/s" },
  depth: { label: "Depth", units: "m" },
};

// Ice-fire ramp (matches the static legend gradient in the sidebar).
export const PALETTE = [
  "#0077b6",
  "#00b4d8",
  "#90e0ef",
  "#ffba08",
  "#ff6b35",
  "#d00000",
];

// Short legend suffix per color scale.
export const SCALE_LABELS = {
  linear: "linear",
  log: "log",
  sqrt: "√",
  cbrt: "∛",
  symlog: "symlog",
  quantile: "quantile",
  "quantile-classes": "quantile classes",
  jenks: "natural breaks",
};

// Flowpaths without a value at this timestep are drawn transparent, so a
// single-VPU subset shows only the loaded reaches.
export const NO_DATA_COLOR = "rgba(0, 0, 0, 0)";
export const FILL_VALUE = -9999; // t-route missing-data sentinel
export const FLOWPATH_FEATURE = { source: "flowpaths", sourceLayer: "flowpaths" };
// Current value in feature-state; the fill value means "no data".
export const RESULT_VALUE = ["coalesce", ["feature-state", "value"], FILL_VALUE];

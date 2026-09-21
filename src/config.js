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

// Diverging ramp for diff views (A − B): symmetric around the middle (odd
// length) so zero difference lands on the pale center stop, not off to one
// side. Blue = A below B, red = A above B.
export const DIFF_PALETTE = [
  "#2166ac",
  "#67a9cf",
  "#d1e5f0",
  "#f7f7f7",
  "#fddbc7",
  "#ef8a62",
  "#b2182b",
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

// Hydrofabric gage points (hydrolocations with hl_reference == "gages"). Each
// carries the flowpath it sits on in its `id` property and its USGS site
// number in `hl_uri` ("gages-<site>").
export const GAGE_LAYER = "conus_gages";
export const GAGE_GLOW_LAYER = "conus_gages_glow";
export const GAGE_FEATURE = { source: "gages", sourceLayer: "gages" };

// USGS Water Data OGC API (the post-2025 replacement for the NWIS IV service).
export const USGS_API = "https://api.waterdata.usgs.gov/ogcapi/v1";
export const USGS_FLOW_PARAM = "00060"; // discharge, ft³/s
export const CFS_TO_CMS = 0.028316846592;

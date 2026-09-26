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

// The routed variables, in display order. This is the single source of truth:
// parsers, merge, diff and the loader all iterate it rather than spelling out
// the triple. config.js is the one module workers may import, so both sides of
// the worker boundary share it.
export const VARIABLE_KEYS = Object.keys(VARIABLES);

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
// Anything at or below this is the fill value; real data is always above it.
// Tested rather than compared to FILL_VALUE directly so float round-trips
// through Float32Array can't land just shy of the sentinel and read as data.
export const FILL_THRESHOLD = FILL_VALUE + 1;
export function isValid(v) {
  return v > FILL_THRESHOLD;
}
export const FLOWPATH_FEATURE = { source: "flowpaths", sourceLayer: "flowpaths" };
// Current value in feature-state; the fill value means "no data".
export const RESULT_VALUE = ["coalesce", ["feature-state", "value"], FILL_VALUE];
// MapLibre-expression form of isValid(): true when the feature-state value is
// real data. Paired with RESULT_VALUE so the sentinel has one definition.
export const RESULT_IS_FILL = ["<=", RESULT_VALUE, FILL_THRESHOLD];

// Hydrofabric gage points (hydrolocations with hl_reference == "gages"). Each
// carries the flowpath it sits on in its `id` property and its USGS site
// number in `hl_uri` ("gages-<site>").
// hl_uri is "gages-<site>"; the label layer slices this prefix off in a style
// expression, so its length has to come from here rather than a counted literal.
export const GAGE_URI_PREFIX = "gages-";
export const GAGE_LAYER = "conus_gages";
export const GAGE_GLOW_LAYER = "conus_gages_glow";
export const GAGE_LABEL_LAYER = "conus_gages_label";
export const GAGE_FEATURE = { source: "gages", sourceLayer: "gages" };

// USGS Water Data OGC API (the post-2025 replacement for the NWIS IV service).
export const USGS_API = "https://api.waterdata.usgs.gov/ogcapi/v1";
export const USGS_FLOW_PARAM = "00060"; // discharge, ft³/s
export const CFS_TO_CMS = 0.028316846592;

// Hydrograph line colors: a fixed categorical order (never cycled), checked
// for color-blind separation between neighbours on the dark panel surface.
// Each loaded run holds one slot for as long as it's loaded; runs past the
// eighth fall back to a dashed neutral line. Observations are drawn in the
// primary text ink so the reference stands apart from every model run.
export const SERIES_COLORS = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
];
export const SERIES_OVERFLOW_COLOR = "#8899aa";
export const OBS_COLOR = "#e6edf5";
export const CURRENT_TIME_COLOR = "#ffba08";

// t-route writes file_reference_time as "YYYY-MM-DD HH:MM:SS" (sometimes with
// "_" or "T" as the separator) and no timezone; it is UTC. Returns epoch ms, or
// undefined when the string is unparseable. Lives here rather than in
// data/access.js because the NetCDF parser needs it worker-side, and config.js
// is the only module workers may import.
export function refTimeMillis(raw) {
  if (typeof raw !== "string") return undefined;
  let s = raw.trim().replace(/^(\d{4}-\d{2}-\d{2})[ _]/, "$1T");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

// ---- Live routing sim (src/sim/) ------------------------------------
//
// A Muskingum-Cunge network over the reaches loaded on screen, routed in wasm
// (wasm/mc_route) and painted through the same feature-state "value" as a
// loaded run. See WASM_ROUTING.md.
export const SIM_DT = 300; // seconds per routing step
// Per-step multiplier on lateral inflow, so a brush deposit tapers off
// (0.97 per 5 min step ≈ a 1.9 h half-life) once the button is released.
export const SIM_QLAT_DECAY = 0.97;
// Below this flow (m³/s) a reach is drawn dry. SIM_DIRTY_EPS must stay under
// it: a reach draining to zero may be left painted at up to eps, and that
// must still read as dry.
export const SIM_WET_Q = 0.01;
export const SIM_DIRTY_EPS = 0.005;
// Fixed log colour domain (m³/s). A live sim has no dataset bounds to derive
// one from, and a domain that moved every frame would recolour the whole map.
export const SIM_Q_DOMAIN = { min: SIM_WET_Q, max: 1000 };
// Routing work allowed per batch (the sim worker runs one batch per animation
// frame). When the wet network is too big to fit the requested steps in this
// budget, the sim runs slower instead of lagging behind the map. It runs off
// the main thread, so it can take most of a 60 Hz frame.
export const SIM_FRAME_BUDGET_MS = 12;
export const SIM_DRY_COLOR = "rgba(0, 119, 187, 0.45)";
// The flowpath tiles are geometry-only, so channel parameters are guessed from
// stream order until the real flowpath-attributes are wired in. Bottom width
// bw and bankfull top width tw in metres, side slope cs (the kernel's
// z = 1 / cs), Manning's n. The compound channel is 3× tw at 2× n, and the
// bed slope is one constant.
export const SIM_S0 = 0.001;
export const SIM_CHANNEL_BY_ORDER = [
  { bw: 1.6, tw: 4, cs: 0.5, n: 0.06 }, // order 1
  { bw: 2.4, tw: 6, cs: 0.45, n: 0.06 },
  { bw: 3.5, tw: 9, cs: 0.4, n: 0.055 },
  { bw: 5.3, tw: 13, cs: 0.35, n: 0.055 },
  { bw: 7.4, tw: 19, cs: 0.3, n: 0.05 },
  { bw: 11, tw: 28, cs: 0.25, n: 0.05 },
  { bw: 14, tw: 36, cs: 0.22, n: 0.045 },
  { bw: 16, tw: 45, cs: 0.2, n: 0.045 },
  { bw: 26, tw: 70, cs: 0.15, n: 0.04 },
  { bw: 110, tw: 250, cs: 0.12, n: 0.04 }, // order 10+
];

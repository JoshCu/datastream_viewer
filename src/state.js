// ====================================================================
// Shared mutable singletons
//
// This module is a dependency leaf: it imports nothing, so every other
// module can import it without risking an import cycle.
// ====================================================================

// S3 Browser State
export const s3State = {
  currentBucket: "ciroh-community-ngen-datastream",
  pathSegments: ["outputs"],
  currentPath: "outputs/",
  // URLs of the t-route files listed for the selected VPU (the "Load Files"
  // button loads every parquet one among them).
  vpuFiles: [],
  isLoading: false,
  maxNavigationDepth: 6,
  // The VPU_* folders currently listed, if any (drives the CONUS button).
  vpuFolders: [],
  // Set once the user navigates the browser (or arrives via a bucket/path
  // link); until then the URL doesn't advertise the default bucket.
  used: false,
};

// Application state. state.data holds the loaded run entirely in memory as
// feature-major typed arrays (the compact "arrow" layout used by the
// map_app results viewer): matrix[featureRow * nTimes + timeIndex].
export const state = {
  data: null,
  variable: "flow",
  timeIndex: 0,
  isPlaying: false,
  playSpeed: 5,
  scale: "linear", // color scale: linear | log | sqrt | cbrt | symlog | ...
  originalPaint: null, // flowpaths paint to restore on clear
  hoveredId: null,
  lastClickedDivide: null,
  // Live routing sim (src/sim/). While simActive the sim owns the flowpaths
  // paint and feature-state instead of a loaded run; while brushActive, left
  // clicks on the map deposit water rather than select things.
  simActive: false,
  brushActive: false,
};

// Forcings (src/forcing/). Independent of state.data: a t-route run can sit
// on the flowpaths while forcings are painted on the catchments.
export const forcingState = {
  // Where rows come from: one entry per forcing file, keyed by VPU id for an
  // S3 cycle (url sources) or by a local key for dropped files. Each is
  // { key, vpu, label, source: { url } | { file }, layout, rowOf, loaded }
  // with layout/rowOf/loaded filled in once the file's layout is known.
  files: new Map(),
  sourceLabel: null, // the cycle path or the dropped file names
  run: null, // the ForcingRun (forcing/store.js) once any rows have loaded
  variable: null,
  scale: "linear",
  timeIndex: 0,
  busy: false,
};

// NEXRAD Level II point cloud (src/nexrad/). Drawn by a deck.gl overlay,
// independent of both the t-route run and the forcings.
// Several radars can be shown at once; product, tilt and display settings are
// shared by all of them.
export const nexradState = {
  // One per station row: { key, icao, scans: [{ key, url, time }], index,
  // volume, url, points, … }. `index` is the scan picked in the row, `url`
  // the one `volume` ({ icao, site, time, moment, cuts: [{ angle, x, y, z, v }] })
  // came from; `points` is its built point cloud (nexrad/layer.js).
  radars: [],
  locked: false, // stepping one radar snaps the others to its time
  product: "REF",
  threshold: 20,
  tilt: null, // elevation angle (each radar draws its nearest cut), or null for every tilt
  exaggeration: 4,
  pointSize: 2,
  opacity: 0.8,
  fade: 0, // alpha = t^fade, t = value's position from threshold to max; 0 = off
  birdRange: 80, // km: bird mode's points stop this far from the radar
};

// The MapLibre map instance. It's created asynchronously in map/init.js;
// `map` is a live binding, so importers see the value once setMap() runs.
export let map = null;
export function setMap(instance) {
  map = instance;
}

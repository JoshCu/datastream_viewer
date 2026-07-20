// ====================================================================
// Shared mutable singletons
//
// This module is a dependency leaf: it imports nothing, so every other
// module can import it without risking an import cycle.
// ====================================================================

// S3 Browser State
export const s3State = {
  buckets: [
    "ciroh-community-ngen-datastream",
    "ciroh-community-ngen-datastream-temp",
  ],
  currentBucket: "ciroh-community-ngen-datastream",
  pathSegments: ["outputs"],
  currentPath: "outputs/",
  selectedFile: null,
  trouteFiles: [],
  isLoading: false,
  maxNavigationDepth: 6,
  // The VPU_* folders currently listed, if any (drives the CONUS button).
  vpuFolders: [],
};

// Application state. state.data holds the loaded run entirely in memory as
// feature-major typed arrays (the compact "arrow" layout used by the
// map_app results viewer): matrix[featureRow * nTimes + timeIndex].
export const state = {
  data: null,
  variable: "flow",
  timeIndex: 0,
  isPlaying: false,
  playInterval: null,
  playSpeed: 5,
  scale: "linear", // color scale: linear | log | sqrt | cbrt | symlog | ...
  originalPaint: null, // flowpaths paint to restore on clear
  hoveredId: null,
  lastClickedDivide: null,
  selectedFeature: null,
  // Set by the map event handlers when the rendered set of reaches may have
  // changed (camera moved or a tile streamed in). updateFeatureStates() reads
  // this to decide whether it must re-run queryRenderedFeatures or can reuse
  // its cached on-screen ids (e.g. on a bare timestep change during playback).
  viewDirty: false,
};

// The MapLibre map instance. It's created asynchronously in map/init.js;
// `map` is a live binding, so importers see the value once setMap() runs.
export let map = null;
export function setMap(instance) {
  map = instance;
}

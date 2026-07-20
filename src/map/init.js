// ====================================================================
// App bootstrap: create the map, bind map + DOM event listeners.
// ====================================================================
import { state, setMap } from "../state.js";
import { updateIncomingStyle } from "./basemap-style.js";
import {
  applyResultsPaint,
  scheduleFeatureStateUpdate,
  scheduleTilePaint,
} from "./paint.js";
import {
  onDivideClick,
  onFlowpathHover,
  onFlowpathLeave,
  onFlowpathClick,
  refreshTooltip,
} from "./interactions.js";
import { setupS3Browser } from "../s3/browser.js";
import { loadConus, preloadParquetWasm } from "../data/loader.js";
import { updateLegend } from "../ui/panels.js";
import { updateTimeDisplay } from "../ui/time.js";
import { seekFromOverview } from "../ui/overview.js";
import {
  startPlayback,
  stopPlayback,
  togglePlay,
  stepForward,
  stepBackward,
} from "../ui/playback.js";

// maplibregl and pmtiles are globals provided by CDN <script>s in index.html.

// Persistent "a camera move is in progress" gate for the idle handler. Unlike
// state.viewDirty (which updateFeatureStates consumes on its next query) this
// stays set for the whole gesture, so idle reliably fires one settle-time
// requery — and it lets idle skip the idles that setFeatureState itself emits.
let cameraMoved = false;

// Set when a camera move interrupts active playback, so idle can resume it once
// the gesture settles. Only movestart-while-playing sets it, so repeated
// movestarts within one gesture don't clobber it.
let resumePlaybackAfterMove = false;

export function init() {
  // Warm the shared parquet-wasm binary in the background so it's compiled and
  // ready by the time a Parquet/CONUS load fires — the workers reuse it.
  preloadParquetWasm();

  const protocol = new pmtiles.Protocol({ metadata: true });
  maplibregl.addProtocol("pmtiles", protocol.tile);
  maplibregl.setWorkerCount(4);

  const map = new maplibregl.Map({
    container: "map",
    center: [-96, 40],
    zoom: 4,
    validateStyle: false,
  });
  setMap(map);
  map.setStyle("https://communityhydrofabric.com/map/styles/dark-base.json", {
    transformStyle: updateIncomingStyle,
  });

  // Upstream highlight on divide click.
  map.on("click", "divides", onDivideClick);
  map.on("mouseenter", "divides", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "divides", () => {
    map.getCanvas().style.cursor = "";
  });

  // Flowpath hover tooltip + click info panel (bound to the fat overlay).
  map.on("mousemove", "flowpaths-hover", onFlowpathHover);
  map.on("mouseleave", "flowpaths-hover", onFlowpathLeave);
  map.on("click", "flowpaths-hover", onFlowpathClick);

  // A camera move only marks cameraMoved; the full-viewport requery is
  // deferred to idle (via state.viewDirty) so it happens once when the pan
  // settles, not on every frame mid-pan.
  map.on("movestart", () => {
    cameraMoved = true;
    // Pause playback while the camera is moving; idle resumes it. Guarded on
    // isPlaying so a second movestart mid-gesture doesn't overwrite the flag.
    if (state.isPlaying) {
      resumePlaybackAfterMove = true;
      stopPlayback();
    }
  });
  map.on("idle", () => {
    if (state.data && cameraMoved) {
      cameraMoved = false;
      state.viewDirty = true;
      scheduleFeatureStateUpdate();
      if (resumePlaybackAfterMove) {
        resumePlaybackAfterMove = false;
        startPlayback();
      }
    }
  });
  // Paint each flowpaths tile the moment it finishes loading, so reaches light
  // up as they stream in mid-pan instead of only once the pan stops. Bounded
  // to the loaded tile's footprint (not the whole screen) and rAF-coalesced,
  // so a burst of tiles is at most one small query per frame.
  map.on("sourcedata", (e) => {
    if (state.data && e.sourceId === "flowpaths" && e.tile) {
      scheduleTilePaint(e.tile.tileID);
    }
  });

  setupEventListeners();
  setupS3Browser();
}

function setupEventListeners() {
  document.getElementById("timeSlider").addEventListener("input", (e) => {
    state.timeIndex = parseInt(e.target.value, 10);
    scheduleFeatureStateUpdate();
    updateTimeDisplay();
    refreshTooltip();
  });

  document.querySelectorAll(".var-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".var-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.variable = btn.dataset.var;
      updateLegend();
      applyResultsPaint();
      scheduleFeatureStateUpdate();
      updateTimeDisplay();
      refreshTooltip();
    });
  });

  // The color scale only changes the paint expression (which reads
  // feature-state), so no feature-state re-apply is needed.
  document.getElementById("scaleSelect").addEventListener("change", (e) => {
    state.scale = e.target.value;
    applyResultsPaint();
    updateLegend();
  });

  document.getElementById("close-info").addEventListener("click", () => {
    document.getElementById("info-panel").classList.remove("visible");
    state.selectedFeature = null;
  });

  document.getElementById("speed-slider").addEventListener("input", (e) => {
    state.playSpeed = parseInt(e.target.value, 10);
    document.getElementById("speed-value").textContent = state.playSpeed + "x";
    if (state.isPlaying) {
      stopPlayback();
      startPlayback();
    }
  });

  // Playback transport (previously inline onclick handlers in index.html).
  document.getElementById("playBtn").addEventListener("click", togglePlay);
  document
    .getElementById("stepBackBtn")
    .addEventListener("click", stepBackward);
  document.getElementById("stepFwdBtn").addEventListener("click", stepForward);

  // Overview sparkline: click to seek.
  document
    .getElementById("results-overview")
    .addEventListener("click", seekFromOverview);

  // CONUS: recursively load every VPU under the current cycle folder.
  document.getElementById("conusBtn").addEventListener("click", loadConus);
}

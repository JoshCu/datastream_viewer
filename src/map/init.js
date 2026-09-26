// ====================================================================
// App bootstrap: create the map, bind map + DOM event listeners.
// ====================================================================
import { state, setMap } from "../state.js";
import { GAGE_LAYER } from "../config.js";
import { updateIncomingStyle } from "./basemap-style.js";
import {
  applyResultsPaint,
  scheduleFeatureStateUpdate,
  scheduleTilePaint,
  syncPaintToDataset,
} from "./paint.js";
import {
  onDivideClick,
  onFlowpathHover,
  onFlowpathLeave,
  onFlowpathClick,
  onGageClick,
  onGageHover,
  onGageLeave,
  invalidateCanvasBox,
  HillshadeControl,
} from "./interactions.js";
import { GageControl, updateGageFilter } from "./gages.js";
import { setupS3Browser } from "../s3/browser.js";
import { setupUploadPanel } from "../ui/upload.js";
import { loadConus, preloadParquetWasm } from "../data/loader.js";
import { onActiveDatasetChange } from "../data/sources.js";
import {
  updateLegend,
  initCollapsiblePanels,
  syncPanelsToDataset,
} from "../ui/panels.js";
import {
  setTimeIndex,
  updateTimeDisplay,
  syncTimeToDataset,
} from "../ui/time.js";
import { seekFromOverview, invalidateOverview } from "../ui/overview.js";
import { setupHydrograph, closeHydrograph } from "../ui/hydrograph.js";
import { togglePlay, stepForward, stepBackward } from "../ui/playback.js";


// maplibregl and pmtiles are globals provided by CDN <script>s in index.html.

// Persistent "a camera move is in progress" gate for the idle handler. Unlike
// state.viewDirty (which updateFeatureStates consumes on its next query) this
// stays set for the whole gesture, so idle reliably fires one settle-time
// requery — and it lets idle skip the idles that setFeatureState itself emits.
let cameraMoved = false;

export function init() {
  // Each module owns its own reaction to the active run changing; the loader
  // just announces it. Order matters only in that the overview's cached curve
  // must be dropped before anything redraws it.
  onActiveDatasetChange(invalidateOverview);
  onActiveDatasetChange(syncPanelsToDataset);
  onActiveDatasetChange(syncTimeToDataset);
  onActiveDatasetChange(syncPaintToDataset);
  onActiveDatasetChange(updateGageFilter);

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
  map.setStyle("https://tiles.openfreemap.org/styles/liberty", {
    transformStyle: updateIncomingStyle,
  });

  map.addControl(
      new maplibregl.NavigationControl({
          visualizePitch: true,
          showZoom: true,
          showCompass: true
      })
  );

  map.addControl(
      new maplibregl.TerrainControl({
          source: 'terrainSource',
          exaggeration: 1
      })
  );
  // add a control to enable and disable the hill shade
  map.addControl(
      new HillshadeControl()
  );
  map.addControl(new GageControl());

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

  // Gages (only shown for reaches in the loaded run, see map/gages.js).
  map.on("click", GAGE_LAYER, onGageClick);
  map.on("mousemove", GAGE_LAYER, onGageHover);
  map.on("mouseleave", GAGE_LAYER, onGageLeave);

  // A camera move only marks cameraMoved; the full-viewport requery is
  // deferred to idle (via state.viewDirty) so it happens once when the pan
  // settles, not on every frame mid-pan.
  map.on("movestart", () => {
    cameraMoved = true;
  });
  map.on("idle", () => {
    if (state.data && cameraMoved) {
      cameraMoved = false;
      state.viewDirty = true;
      scheduleFeatureStateUpdate();
    }
  });
  // Paint each flowpaths tile the moment it finishes loading, so reaches light
  // up as they stream in mid-pan instead of only once the pan stops. Bounded
  // to the loaded tile's footprint (not the whole screen) and rAF-coalesced,
  // so a burst of tiles is at most one small query per frame.
  map.on("resize", invalidateCanvasBox);

  map.on("sourcedata", (e) => {
    if (state.data && e.sourceId === "flowpaths" && e.tile) {
      scheduleTilePaint(e.tile.tileID);
    }
  });

  // Warm the shared parquet-wasm binary once the map has settled, so its 6.5MB
  // fetch doesn't contend with the basemap style, glyphs and first tiles. It
  // still lands long before any Parquet/CONUS load can be requested.
  map.once("idle", preloadParquetWasm);

  setupEventListeners();
  setupS3Browser();
  setupUploadPanel();
  setupHydrograph();
  initCollapsiblePanels();
}

function setupEventListeners() {
  document.getElementById("timeSlider").addEventListener("input", (e) => {
    setTimeIndex(parseInt(e.target.value, 10));
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
      // scheduleFeatureStateUpdate() ends in refreshTooltip(), so the tooltip
      // picks up the new variable without a second call here.
      scheduleFeatureStateUpdate();
      updateTimeDisplay();
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
    closeHydrograph();
  });

  document.getElementById("speed-slider").addEventListener("input", (e) => {
    state.playSpeed = parseInt(e.target.value, 10);
    document.getElementById("speed-value").textContent = state.playSpeed + "x";
    // The playback loop reads playSpeed each frame, so a speed change takes
    // effect without stopping and restarting.
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

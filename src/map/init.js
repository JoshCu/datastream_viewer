// ====================================================================
// App bootstrap: create the map, bind map + DOM event listeners.
// ====================================================================
import { state, forcingState, setMap } from "../state.js";
import { GAGE_LAYER, FORCING_LAYER, USGS_SITES_LAYER, REACH_SETS } from "../config.js";
import { updateIncomingStyle } from "./basemap-style.js";
import {
  activeReachSource,
  applyResultsPaint,
  invalidateResultsView,
  scheduleFeatureStateUpdate,
  scheduleTilePaint,
  syncPaintToDataset,
} from "./paint.js";
import {
  onCatchmentClick,
  onFlowpathHover,
  onFlowpathLeave,
  onFlowpathClick,
  onGageClick,
  onGageHover,
  onGageLeave,
  onUsgsSiteClick,
  onUsgsSiteHover,
  onUsgsSiteLeave,
  invalidateCanvasBox,
  TerrainControl,
  HydrofabricControl,
} from "./interactions.js";
import { GageControl, updateGageFilter, addGageIcon, scheduleNwmGageHarvest } from "./gages.js";
import { SearchControl } from "./search.js";
import { setupUsgsSites } from "./usgssites.js";
import { loadUsgsCatalog } from "../data/usgscatalog.js";
import { setupUsgsPanel } from "../ui/usgspanel.js";
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
import { setupSimPanel, scheduleSimRebuild, stopSimForDataset } from "../sim/network.js";
import { setupBrush } from "../sim/brush.js";
import { setupSimRain } from "../sim/rain.js";
import { forcingTileLoaded, invalidateForcingView } from "../forcing/paint.js";
import { setupForcingPanel, onForcingHover, onForcingLeave } from "../ui/forcingpanel.js";
import { setupForcingPlot } from "../ui/forcingplot.js";
import { setupNwmPanel } from "../ui/nwmpanel.js";
import { setupContextMenu } from "../ui/contextmenu.js";
import { setupNexradPanel } from "../ui/nexradpanel.js";
import { setupWindsPanel } from "../ui/windspanel.js";
import { setupFloodPanel } from "../ui/floodpanel.js";
import { syncGridToDataset } from "./grid.js";
import { setupFlowPanel } from "../ui/flowpanel.js";
import { setupErosionPanel } from "../ui/erosionpanel.js";
import { setRunColormapId } from "../ui/colormap.js";
import { initialMapView, syncMapView } from "../ui/url.js";
import { writeUrl as writeLayersUrl } from "./layerprefs.js";


// maplibregl and pmtiles are globals provided by CDN scripts in index.html.

// Persistent "a camera move is in progress" gate for the idle handler. It
// stays set for the whole gesture, so idle reliably fires one settle-time
// requery — and it lets idle skip the idles that setFeatureState itself emits.
let cameraMoved = false;

export function init() {
  // Each module owns its own reaction to the active run changing; the loader
  // just announces it. Order matters only in that the overview's cached curve
  // must be dropped before anything redraws it, and a live sim must hand the
  // flowpaths paint back before syncPaintToDataset saves it as the original.
  onActiveDatasetChange(stopSimForDataset);
  onActiveDatasetChange(invalidateOverview);
  onActiveDatasetChange(syncPanelsToDataset);
  onActiveDatasetChange(syncTimeToDataset);
  onActiveDatasetChange(syncGridToDataset); // before paint: it adds the layer painted
  onActiveDatasetChange(syncPaintToDataset);
  onActiveDatasetChange(updateGageFilter);

  const protocol = new pmtiles.Protocol({ metadata: true });
  maplibregl.addProtocol("pmtiles", protocol.tile);
  maplibregl.setWorkerCount(4);

  const map = new maplibregl.Map({
    container: "map",
    center: [-96, 40],
    zoom: 4,
    // A link's `map=` camera, if it has one.
    ...initialMapView(),
    validateStyle: false,
    // MapLibre 6 defaults to 4, which past a source's maxzoom splits tiles into
    // clipped children. querySourceFeatures then returns only the view's pieces
    // of a reach, but the sim (reach lengths), the flood map and "Load viewport"
    // need the whole loaded tile.
    zoomLevelsToOverscale: undefined,
  });
  setMap(map);
  map.setMissingStyleImageResolver(addGageIcon);
  map.setStyle("https://tiles.openfreemap.org/styles/liberty", {
    transformStyle: updateIncomingStyle,
  });

  // First, so it sits at the top of the control column.
  map.addControl(new SearchControl());
  map.addControl(
      new maplibregl.NavigationControl({
          visualizePitch: true,
          showZoom: true,
          showCompass: true
      })
  );

  // Terrain + hillshade share one group, as do flowpaths + catchments.
  map.addControl(new TerrainControl());
  map.addControl(new HydrofabricControl());
  map.addControl(new GageControl());

  // Catchment click -> forcing plot; the forcing hover readout. The upstream
  // highlight moved to the right-click menu (ui/contextmenu.js).
  map.on("click", FORCING_LAYER, onCatchmentClick);
  map.on("mousemove", FORCING_LAYER, onForcingHover);
  map.on("mouseleave", FORCING_LAYER, onForcingLeave);

  // Reach hover tooltip + click info panel (bound to each network's fat
  // overlay: the hydrofabric's and the NWM flowlines').
  for (const set of Object.values(REACH_SETS)) {
    map.on("mousemove", set.hoverLayer, onFlowpathHover);
    map.on("mouseleave", set.hoverLayer, () => onFlowpathLeave(set));
    map.on("click", set.hoverLayer, onFlowpathClick);
  }

  // Gages (only shown for reaches in the loaded run, see map/gages.js).
  map.on("click", GAGE_LAYER, onGageClick);
  map.on("mousemove", GAGE_LAYER, onGageHover);
  map.on("mouseleave", GAGE_LAYER, onGageLeave);
  // Every USGS site with a continuous record (map/usgssites.js).
  map.on("click", USGS_SITES_LAYER, onUsgsSiteClick);
  map.on("mousemove", USGS_SITES_LAYER, onUsgsSiteHover);
  map.on("mouseleave", USGS_SITES_LAYER, onUsgsSiteLeave);

  // A camera move only marks cameraMoved; the full-viewport requery of each
  // painter is deferred to idle so it happens once when the pan settles, not
  // on every frame mid-pan.
  map.on("movestart", () => {
    cameraMoved = true;
  });
  map.on("idle", () => {
    if (!cameraMoved) return;
    cameraMoved = false;
    if (state.data) invalidateResultsView();
    if (forcingState.run) invalidateForcingView();
  });
  // Paint each flowpaths tile the moment it finishes loading, so reaches light
  // up as they stream in mid-pan instead of only once the pan stops. Bounded
  // to the loaded tile's footprint (not the whole screen) and rAF-coalesced,
  // so a burst of tiles is at most one small query per frame.
  map.on("resize", invalidateCanvasBox);

  map.on("sourcedata", (e) => {
    if (e.sourceId === "divides" && e.tile && forcingState.run) {
      forcingTileLoaded(e.tile.tileID);
      return;
    }
    if (!e.tile) return;
    if (state.data) {
      if (e.sourceId === activeReachSource()) scheduleTilePaint(e.tile.tileID);
      // An NWM run learns its gages from the flowline tiles (map/gages.js).
      if (e.sourceId === REACH_SETS.nwm.feature.source) scheduleNwmGageHarvest();
    }
    // The live sim routes over every loaded hydrofabric tile, so new tiles
    // mean a rebuild.
    else if (state.simActive && e.sourceId === "flowpaths") scheduleSimRebuild();
  });
  // Rebuild the live sim's network for the new view. Not on idle: a running
  // sim writes feature-state every frame, so the map may never go idle.
  map.on("moveend", scheduleSimRebuild);
  // Keep the camera in the URL. Not written until the first move, so a plain
  // visit's URL stays plain.
  map.on("moveend", () => syncMapView(map));
  // Each layer control applies its starting state on load; then put the
  // whole set in the URL, so the link reproduces it.
  map.once("load", writeLayersUrl);

  // Warm the shared parquet-wasm binary once the map has settled, so its 6.5MB
  // fetch doesn't contend with the basemap style, glyphs and first tiles. It
  // still lands long before any Parquet/CONUS load can be requested.
  map.once("idle", preloadParquetWasm);
  // Likewise the USGS site catalog: instant from IndexedDB after the first
  // visit, ~6 MB from the API (in a worker) when missing or a day old.
  setupUsgsSites();
  map.once("idle", () => loadUsgsCatalog());

  setupEventListeners();
  // Before the S3 browser: a deep link's first URL sync must see its panel open.
  initCollapsiblePanels();
  setupS3Browser();
  setupUploadPanel();
  setupNwmPanel();
  setupHydrograph();
  setupForcingPanel();
  setupForcingPlot();
  setupContextMenu();
  setupNexradPanel();
  setupWindsPanel();
  setupFloodPanel();
  setupFlowPanel();
  setupErosionPanel();
  setupUsgsPanel();
  setupSimPanel();
  setupBrush();
  setupSimRain();
}

function setupEventListeners() {
  document.getElementById("timeSlider").addEventListener("input", (e) => {
    setTimeIndex(parseInt(e.target.value, 10));
  });

  // Scoped to the variable picker: other panels (erosion tools) reuse the
  // .var-btn look for their own buttons.
  document.querySelectorAll("#varSelector .var-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      document
        .querySelectorAll("#varSelector .var-btn")
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
  document.getElementById("colormapSelect").addEventListener("change", (e) => {
    setRunColormapId(e.target.value);
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

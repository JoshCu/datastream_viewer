// ====================================================================
// Particle erosion panel: the flow particles' interaction and erosion
// settings (erosionState, state.js), the terrain brushes and the terrain
// reset. Its settings apply while it's open; opening it opens the Flow
// Particles panel, whose speed and momentum sliders it shares.
// ====================================================================
import { flowState, erosionState } from "../state.js";
import { registerPanelLayer, syncPanelLayers } from "./panellayers.js";
import { setFlowActive } from "./flowpanel.js";
import { setStatus } from "./panels.js";
import { bindSlider } from "./sliders.js";
import { setBrushTool, setupFlowBrush } from "../flow/brush.js";
import { onTerrainChange, terrainEdits, resetTerrain, setupTerrainEdits } from "../flow/terrain.js";
import { rebuildFlowField } from "../flow/field.js";
import { commitFlowErosion } from "../flow/particles.js";

const $ = (id) => document.getElementById(id);

function showEdits() {
  const { tiles } = terrainEdits();
  setStatus(
    tiles ? "loaded" : "idle",
    tiles ? `Terrain edited (${tiles} DEM tile${tiles === 1 ? "" : "s"})` : "Terrain unedited",
    "erosion",
  );
}

function selectTool(tool) {
  setBrushTool(tool);
  for (const b of $("eroTools").querySelectorAll(".var-btn")) {
    b.classList.toggle("active", b.dataset.tool === tool);
  }
}

function setErosionActive(on) {
  // The particles are what erode.
  if (on) setFlowActive(true);
  if (on === erosionState.active) return;
  erosionState.active = on;
  if (!on) {
    commitFlowErosion();
    selectTool("none");
  }
  syncPanelLayers();
}

function onToggle() {
  const open = !$("erosionPanel").classList.contains("collapsed");
  // Opening this one brings up the flow panel it shares its sliders with.
  const flow = $("flowPanel");
  if (open && !flowState.active && flow.classList.contains("collapsed")) {
    flow.querySelector(".panel-title").click();
  }
  setErosionActive(open);
}

export function setupErosionPanel() {
  setupTerrainEdits();
  setupFlowBrush();
  bindSlider(flowState, "eroSpeed", "speed", (v) => v.toFixed(1));
  bindSlider(flowState, "eroMomentum", "momentum", (v) => v.toFixed(2));
  bindSlider(erosionState, "eroRange", "range", (v) => `${v}px`);
  bindSlider(erosionState, "eroTransfer", "transfer", (v) => v.toFixed(2));
  bindSlider(erosionState, "eroRate", "rate", (v) => `${v.toFixed(3)} m`);
  bindSlider(erosionState, "eroHardness", "hardness", (v) => v.toFixed(1));
  bindSlider(erosionState, "eroDeposit", "deposit", (v) => `${v.toFixed(4)} m`);
  bindSlider(erosionState, "eroInterval", "interval", (v) => `${v.toFixed(1)} s`);
  bindSlider(erosionState, "eroSize", "size", (v) => `${v}px`);
  bindSlider(erosionState, "eroStrength", "strength", (v) => `${v} m/s`);
  for (const b of $("eroTools").querySelectorAll(".var-btn")) {
    b.addEventListener("click", () => selectTool(b.dataset.tool));
  }
  $("eroResetBtn").addEventListener("click", () => {
    resetTerrain();
    rebuildFlowField();
  });
  onTerrainChange(showEdits);
  showEdits();

  const eroding = () => erosionState.active && flowState.active;
  registerPanelLayer("erosionPanel", {
    name: "erosion",
    isShowing: eroding,
    toggle: () => setErosionActive(!eroding()),
    stop: () => setErosionActive(false),
  });

  $("erosionPanel").querySelector(".panel-title").addEventListener("click", onToggle);
  // A shared link can open the panel at load.
  onToggle();
}

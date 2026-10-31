// ====================================================================
// Particle erosion panel: the flow particles' interaction and erosion
// settings (erosionState, state.js), the terrain brushes and the terrain
// reset. Its settings apply while it's open; opening it opens the Flow
// Particles panel, whose speed and momentum sliders it shares.
// ====================================================================
import { flowState, erosionState } from "../state.js";
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

function onToggle() {
  const open = !$("erosionPanel").classList.contains("collapsed");
  if (open === erosionState.active) return;
  erosionState.active = open;
  if (open) {
    // The particles are what erode.
    if (!flowState.active) $("flowPanel").querySelector(".panel-title").click();
  } else {
    commitFlowErosion();
    selectTool("none");
  }
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

  $("erosionPanel").querySelector(".panel-title").addEventListener("click", onToggle);
  // A shared link can open the panel at load.
  onToggle();
}

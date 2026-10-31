// ====================================================================
// Flow particles panel: opening it starts the particles over the view,
// collapsing it stops them. The settings live in flowState (state.js).
// ====================================================================
import { map, flowState } from "../state.js";
import { colormapColors, colormapGradient } from "../color/colormaps.js";
import { fillColormapSelect } from "./colormap.js";
import { setStatus } from "./panels.js";
import { bindSlider } from "./sliders.js";
import {
  onFlowStatus,
  refreshFlowField,
  scheduleFlowField,
  clearFlowField,
} from "../flow/field.js";
import {
  startFlowParticles,
  stopFlowParticles,
  resetFlowParticles,
  restartFlowParticles,
  resizeFlowTrail,
  setFlowColormap,
  updateFlowCells,
  rebuildSpawnGrid,
} from "../flow/particles.js";
import { applyFlowDebug } from "../flow/debug.js";

const $ = (id) => document.getElementById(id);

function syncLegend() {
  $("flowLegendGradient").style.background = colormapGradient(colormapColors(flowState.colormap));
  const byArea = flowState.colorBy === "acc";
  $("flowLegendMin").textContent = byArea ? "Hillslope" : "Slow";
  $("flowLegendMax").textContent = byArea ? "Big river" : "Fast";
}

function bindSelect(id, key, apply, parse = String) {
  const select = $(id);
  select.value = String(flowState[key]);
  select.addEventListener("change", () => {
    flowState[key] = parse(select.value);
    apply?.();
  });
}

function onToggle() {
  const open = !$("flowPanel").classList.contains("collapsed");
  if (open === flowState.active) return;
  flowState.active = open;
  if (open) {
    startFlowParticles().catch((err) => {
      // deck.gl didn't load (offline, CDN blocked): nothing would draw.
      flowState.active = false;
      clearFlowField();
      setStatus("error", `${err.message}. Close and reopen to retry.`, "flow");
    });
    refreshFlowField();
  } else {
    stopFlowParticles();
    clearFlowField();
  }
  applyFlowDebug();
}

export function setupFlowPanel() {
  onFlowStatus(({ kind, text }) => setStatus(kind, text, "flow"));

  bindSlider(flowState, "flowCount", "count", (v) => `${v / 1000}k`, resetFlowParticles);
  bindSlider(flowState, "flowSpeed", "speed", (v) => v.toFixed(1));
  bindSlider(flowState, "flowMomentum", "momentum", (v) => v.toFixed(2));
  bindSlider(flowState, "flowTrail", "trail", (v) => `${v}`, resizeFlowTrail);
  bindSlider(flowState, "flowWidth", "width", (v) => `${v}px`);
  bindSlider(flowState, "flowOpacity", "opacity", (v) => v.toFixed(2));
  bindSelect("flowSpeedModel", "speedModel", updateFlowCells);
  bindSelect("flowColorBy", "colorBy", () => {
    updateFlowCells();
    syncLegend();
  });
  fillColormapSelect($("flowColormap"), false, flowState.colormap);
  bindSelect("flowColormap", "colormap", () => {
    setFlowColormap();
    syncLegend();
  });
  bindSelect("flowDetail", "detail", () => refreshFlowField(true), Number);
  bindSelect("flowDebug", "debug", applyFlowDebug);
  bindSelect("flowCompute", "compute", restartFlowParticles);
  syncLegend();

  map.on("moveend", () => {
    if (!flowState.active) return;
    rebuildSpawnGrid();
    scheduleFlowField();
  });
  map.on("resize", () => {
    if (flowState.active) rebuildSpawnGrid();
  });

  $("flowPanel").querySelector(".panel-title").addEventListener("click", onToggle);
  // A shared link can open the panel before the style has loaded; the field
  // waits for the DEM source itself.
  onToggle();
}

// ====================================================================
// Flow particles panel: opening it starts the particles over the view,
// collapsing it stops them. The settings live in flowState (state.js).
// ====================================================================
import { map, flowState } from "../state.js";
import { colormapColors, colormapGradient } from "../color/colormaps.js";
import { fillColormapSelect } from "./colormap.js";
import { setStatus } from "./panels.js";
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
  resizeFlowTrail,
  setFlowColormap,
  updateFlowCells,
  rebuildSpawnGrid,
} from "../flow/particles.js";

const $ = (id) => document.getElementById(id);

function syncLegend() {
  $("flowLegendGradient").style.background = colormapGradient(colormapColors(flowState.colormap));
  const byArea = flowState.colorBy === "acc";
  $("flowLegendMin").textContent = byArea ? "Hillslope" : "Slow";
  $("flowLegendMax").textContent = byArea ? "Big river" : "Fast";
}

// A range input bound to flowState[key]: `fmt` labels it, `apply` reacts.
function bindSlider(id, key, fmt, apply) {
  const input = $(id);
  const label = $(`${id}Value`);
  input.value = flowState[key];
  label.textContent = fmt(flowState[key]);
  input.addEventListener("input", () => {
    flowState[key] = Number(input.value);
    label.textContent = fmt(flowState[key]);
    apply?.();
  });
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
}

export function setupFlowPanel() {
  onFlowStatus(({ kind, text }) => setStatus(kind, text, "flow"));

  bindSlider("flowCount", "count", (v) => `${v / 1000}k`, resetFlowParticles);
  bindSlider("flowSpeed", "speed", (v) => v.toFixed(1));
  bindSlider("flowTrail", "trail", (v) => `${v}`, resizeFlowTrail);
  bindSlider("flowWidth", "width", (v) => `${v}px`);
  bindSlider("flowOpacity", "opacity", (v) => v.toFixed(2));
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

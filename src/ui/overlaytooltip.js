// ====================================================================
// Hover tooltip for the forcings, rainfall and HUC boundaries, while their panel
// is open and their layer showing: the forcing and rain values under the cursor
// at each one's own clock, with the catchment or rain cell they're read from
// outlined, and the hydrologic units there. They can be up at once, as a section
// each.
//
// It hangs below-left of the cursor, since the other tooltips take the right
// (reach and gage below, flood above) and can be up at the same time.
// ====================================================================
import { forcingState, map, rainState } from "../state.js";
import {
  DIVIDE_FEATURE,
  FORCING_LAYER,
  HOVER_CELL_SOURCE,
  HOVER_DIVIDE_LAYER,
  HOVER_DIVIDE_STATE,
  RAIN_CATCHMENT_LAYER,
  RAIN_PRODUCTS,
  forcingMeta,
  isValid,
} from "../config.js";
import { onForcingChange } from "../forcing/store.js";
import { onRainChange, rainCatchmentValue, rainCellAt } from "../rain/rain.js";
import { hucAt, shownHucLevels } from "../map/huc.js";
import { labeledRow } from "./dom.js";

const $ = (id) => document.getElementById(id);
const CURSOR_GAP = 15;
const EDGE_PAD = 8;

const isOpen = (panelId) => !$(panelId).classList.contains("collapsed");
const forcingOn = () => !!forcingState.run && forcingState.visible && isOpen("forcingPanel");
const rainOn = () => !!rainState.grid && rainState.visible && isOpen("rainPanel");
const rainByCatchment = () => rainOn() && rainState.display === "catchments";
const hucOn = () => isOpen("hucPanel") && shownHucLevels().length > 0;

const fmtTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
const row = (label, value) => labeledRow(label, value, { prefix: "tooltip" });

function titleEl(text) {
  const el = document.createElement("div");
  el.className = "tooltip-title";
  el.textContent = text;
  return el;
}

// ---- The outlines ------------------------------------------------------

let outlinedDivide = null;
let outlinedCell = null; // its key (rain.js's row * nx + col)

function outlineDivide(id) {
  if (id === outlinedDivide) return;
  const target = { ...DIVIDE_FEATURE, id: outlinedDivide };
  if (outlinedDivide != null) map.setFeatureState(target, { [HOVER_DIVIDE_STATE]: false });
  outlinedDivide = id;
  if (id == null) return;
  // Showing the layer reloads the divides tiles, so it's done once and left on.
  if (map.getLayoutProperty(HOVER_DIVIDE_LAYER, "visibility") !== "visible") {
    map.setLayoutProperty(HOVER_DIVIDE_LAYER, "visibility", "visible");
  }
  map.setFeatureState({ ...DIVIDE_FEATURE, id }, { [HOVER_DIVIDE_STATE]: true });
}

function outlineCell(cell) {
  const key = cell?.key ?? null;
  if (key === outlinedCell) return;
  outlinedCell = key;
  map.getSource(HOVER_CELL_SOURCE)?.setData({
    type: "FeatureCollection",
    features: cell
      ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cell.ring } }]
      : [],
  });
}

// ---- The contents ------------------------------------------------------

// Every variable the run has, the one on the map first.
function forcingSection(id) {
  const { run, variable, timeIndex } = forcingState;
  const slot = run.index.get(id);
  const nodes = [titleEl(`Forcings · cat-${id}`)];
  if (slot === undefined) {
    nodes.push(row("Status", "not loaded"));
    return nodes;
  }
  const names = [variable, ...run.variables.filter((v) => v !== variable)];
  for (const name of names) {
    const v = run.matrices[name][slot * run.nTimes + timeIndex];
    const { label, units, scale, offset } = forcingMeta(name);
    nodes.push(row(label, isValid(v) ? `${(v * scale + offset).toFixed(3)} ${units}`.trim() : "N/A"));
  }
  nodes.push(row("Time", fmtTime(run.time[timeIndex])));
  return nodes;
}

function rainSection(divideId, cell) {
  const grid = rainState.grid;
  const { label, units } = grid.info;
  const name = RAIN_PRODUCTS[grid.product].name;
  const time = row("Time", fmtTime(grid.time[rainState.timeIndex]));
  if (rainByCatchment()) {
    const mean = rainCatchmentValue(divideId);
    const text = mean === undefined || mean < 0 ? "no data" : `${mean.toFixed(2)} ${units}`;
    return [titleEl(`${name} · cat-${divideId}`), row(`${label} (mean)`, text), time];
  }
  const text = Number.isNaN(cell.value) ? "no data" : `${cell.value.toFixed(2)} ${units}`;
  return [titleEl(`${name} cell`), row(label, text), row("Centre", `${cell.lat.toFixed(3)}, ${cell.lng.toFixed(3)}`), time];
}

function hucSection(units) {
  return [
    titleEl("Hydrologic units"),
    // Some units have no name in the tiles, only their code in its place.
    ...units.map(({ level, huc, name }) => row(level.label, name && name !== huc ? `${huc} · ${name}` : huc)),
  ];
}

// ---- Tracking the cursor -----------------------------------------------

let pointer = null; // { point, lngLat }, while over the map
let size = null; // { w, h, mapH, minX }, measured when the contents change
let hucUnits = []; // hucAt()'s answer for the pointer

function hide() {
  outlineDivide(null);
  outlineCell(null);
  hucUnits = [];
  $("overlayTooltip").classList.remove("visible");
}

function place() {
  const tooltip = $("overlayTooltip");
  const { x, y } = pointer.point;
  let left = x - CURSOR_GAP - size.w;
  if (left < size.minX) left = x + CURSOR_GAP;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(EDGE_PAD, Math.min(y + CURSOR_GAP, size.mapH - EDGE_PAD - size.h))}px`;
}

// Fill and place the tooltip for what's outlined now; hidden if nothing is.
function render() {
  const showForcing = forcingOn() && outlinedDivide != null;
  const showRain = rainOn() && (rainByCatchment() ? outlinedDivide != null : outlinedCell != null);
  const showHuc = hucUnits.length > 0;
  const tooltip = $("overlayTooltip");
  if (!showForcing && !showRain && !showHuc) {
    tooltip.classList.remove("visible");
    return;
  }
  const nodes = [];
  if (showForcing) nodes.push(...forcingSection(outlinedDivide));
  if (showRain) nodes.push(...rainSection(outlinedDivide, rainCellAt(pointer.lngLat.lng, pointer.lngLat.lat)));
  if (showHuc) nodes.push(...hucSection(hucUnits));
  tooltip.replaceChildren(...nodes);
  // The map runs under the sidebar, so that's the edge on the left (the sidebar
  // slides off screen when hidden).
  const minX = Math.max(0, document.querySelector(".sidebar").getBoundingClientRect().right) + EDGE_PAD;
  size = { w: tooltip.offsetWidth, h: tooltip.offsetHeight, mapH: map.getCanvas().clientHeight, minX };
  place();
  tooltip.classList.add("visible");
}

// What's under the pointer now. Sets the outlines; true if they changed.
function locate() {
  const layers = [];
  if (forcingOn()) layers.push(FORCING_LAYER);
  if (rainByCatchment()) layers.push(RAIN_CATCHMENT_LAYER);
  const divide = layers.length ? map.queryRenderedFeatures(pointer.point, { layers })[0]?.id ?? null : null;
  const { lng, lat } = pointer.lngLat;
  const cell = rainOn() && !rainByCatchment() ? rainCellAt(lng, lat) : null;
  const units = hucOn() ? hucAt(pointer.point) : [];
  const hucChanged = units.map((u) => u.huc).join() !== hucUnits.map((u) => u.huc).join();
  const changed = hucChanged || divide !== outlinedDivide || (cell?.key ?? null) !== outlinedCell;
  outlineDivide(divide);
  outlineCell(cell);
  hucUnits = units;
  return changed;
}

function onMove(e) {
  pointer = { point: e.point, lngLat: e.lngLat };
  if (map.isMoving()) return;
  if (!forcingOn() && !rainOn() && !hucOn()) {
    hide();
    return;
  }
  if (locate()) render();
  else if ($("overlayTooltip").classList.contains("visible")) place();
}

function onLeave() {
  pointer = null;
  hide();
}

export function setupOverlayTooltip() {
  map.on("mousemove", onMove);
  map.on("movestart", hide); // the map slides out from under it
  map.getCanvas().addEventListener("mouseleave", onLeave);

  // The clock moved or the data changed under a still cursor.
  const refresh = () => {
    if (!pointer || map.isMoving()) return;
    locate();
    render();
  };
  onRainChange(({ kind }) => {
    if (kind === "time" && pointer) render();
    else refresh();
  });
  onForcingChange(({ kind }) => {
    if (kind === "time" && pointer) render();
    else if (kind === "run") {
      // Clearing a run wipes the divides' feature-state, the outline's too.
      outlineDivide(null);
      refresh();
    } else if (kind === "rows") refresh();
  });
}

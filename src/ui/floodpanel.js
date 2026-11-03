// ====================================================================
// Flood mapping panel, in one of two modes:
//
// - "flat": a flat water surface raised and lowered over the terrain.
//   Everything whose ground is below the water level is tinted by depth (the
//   FLOOD_LAYER color-relief layer on the DEM, map/basemap-style.js), so
//   moving the level only rewrites that layer's colour ramp.
// - "nwm": flooding from the loaded run (NWM, or ngen through the NWM
//   crosswalk), per reach and per timestep, by HAND (src/fim/fim.js, which
//   owns its own layer and status).
//
// The rest of this comment is about the flat mode.
// The level is entered relative to sea level or to a reference point picked
// on the map (its ground elevation). Opening the panel turns the 3D terrain
// on and tilts the camera; while it's open, hovering the map shows the ground
// elevation, plus the water depth where it's flooded.
// ====================================================================
import { map } from "../state.js";
import {
  FLOOD_LAYER,
  FLOOD_DEEP_M,
  FLOOD_SHALLOW_COLOR,
  FLOOD_DEEP_COLOR,
} from "../config.js";
import { labeledRow } from "./dom.js";
import { setStatus } from "./panels.js";
import { setupFim, setFimActive, setFimFrom, setFimDepthFrom, onFimStatus, fimAt } from "../fim/fim.js";
import { onActiveDatasetChange } from "../data/sources.js";
// maplibregl is a global provided by the CDN <script> in index.html.

const $ = (id) => document.getElementById(id);
const FT_PER_M = 3.28084;
const fmt = (m) => `${m.toFixed(1)} m (${(m * FT_PER_M).toFixed(1)} ft)`;
const signed = (m) => (m < 0 ? m.toFixed(1) : `+${m.toFixed(1)}`);

let open = false;
let mode = "flat"; // "flat" | "nwm"
let level = null; // water surface, m above sea level; null until first fit
let ref = null; // { lngLat, elev }: the picked reference point
let base = "sea"; // what the level is entered relative to: "sea" | "ref"
let picking = false;
let needsFit = false; // refit the slider to the view at the next idle
let marker = null;
let downAt = null; // where the pointer went down, to tell a pick from a drag

// Ground elevation (m) under a point from the 3D terrain, or null when the
// terrain is off. queryTerrainElevation includes the exaggeration.
function elevationAt(lngLat) {
  const terrain = map.getTerrain();
  if (!terrain) return null;
  const elev = map.queryTerrainElevation(lngLat);
  return elev == null ? null : elev / (terrain.exaggeration || 1);
}

const baseElev = () => (base === "ref" && ref ? ref.elev : 0);

// ---- The water layer --------------------------------------------------

// Darkest at FLOOD_DEEP_M below the surface, lightest just under it, and
// clear above it (the last two stops are a hair apart so the shore is sharp).
function applyWater() {
  if (!map.getLayer(FLOOD_LAYER)) return;
  const shown = open && mode === "flat" && level != null;
  map.setLayoutProperty(FLOOD_LAYER, "visibility", shown ? "visible" : "none");
  if (!shown) return;
  map.setPaintProperty(FLOOD_LAYER, "color-relief-color", [
    "interpolate", ["linear"], ["elevation"],
    level - FLOOD_DEEP_M, FLOOD_DEEP_COLOR,
    level - 0.01, FLOOD_SHALLOW_COLOR,
    level, "rgba(0, 0, 0, 0)",
  ]);
}

function setLevel(m) {
  if (!Number.isFinite(m)) return;
  level = Math.round(m * 10) / 10;
  applyWater();
  syncControls();
}

// ---- Controls ---------------------------------------------------------

function syncControls() {
  const slider = $("floodLevel");
  const b = baseElev();
  if (level != null) {
    const v = level - b;
    // Keep the value inside the slider's range, whatever was typed.
    if (v < +slider.min) slider.min = Math.floor(v);
    if (v > +slider.max) slider.max = Math.ceil(v);
    slider.value = v;
    if (document.activeElement !== $("floodLevelInput")) $("floodLevelInput").value = v.toFixed(1);
    $("floodLevelValue").textContent =
      base === "ref" && ref ? `${signed(v)} m` : `${v.toFixed(1)} m`;
  }
  $("floodBase").value = base;
  $("floodBase").querySelector('option[value="ref"]').disabled = !ref;
  $("floodPickBtn").classList.toggle("active", picking);
  $("floodPickBtn").textContent = picking ? "Click the map…" : "Pick reference";
  $("floodClearRefBtn").disabled = !ref;
  $("floodRefInfo").textContent = ref
    ? `Reference ${ref.lngLat.lat.toFixed(4)}°, ${ref.lngLat.lng.toFixed(4)}° · ground ${fmt(ref.elev)}`
    : "No reference point";
  $("floodSurface").textContent =
    level == null ? "" : `Water surface ${fmt(level)} above sea level`;
}

// Span the slider over the ground elevations in view (sampled on a grid),
// relative to the current base. With the camera tilted, the top of the
// screen is near or past the horizon, so only the lower part is sampled.
function fitSlider() {
  const canvas = map.getCanvas();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const top = map.getPitch() > 30 ? h * 0.35 : 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 6; j++) {
      const x = ((i + 0.5) / 8) * w;
      const y = top + ((j + 0.5) / 6) * (h - top);
      const elev = elevationAt(map.unproject([x, y]));
      if (elev == null) continue;
      min = Math.min(min, elev);
      max = Math.max(max, elev);
    }
  }
  if (min > max) return;
  if (level == null) setLevel(min + (max - min) * 0.05);
  const b = baseElev();
  const slider = $("floodLevel");
  slider.min = Math.floor(min - b - 2);
  slider.max = Math.ceil(max - b + 2);
  slider.step = max - min > 500 ? 1 : 0.1;
  syncControls();
}

// ---- Reference point --------------------------------------------------

function setPicking(on) {
  picking = on;
  map.getContainer().classList.toggle("flood-picking", on);
  syncControls();
}

function setReference(lngLat) {
  const elev = elevationAt(lngLat);
  if (elev == null) return;
  ref = { lngLat, elev };
  // Water up to the picked ground, entered relative to it from here on.
  base = "ref";
  setLevel(elev);
  fitSlider();
  showMarker();
}

function showMarker() {
  if (!ref || !open || mode !== "flat") {
    marker?.remove();
    return;
  }
  marker ??= new maplibregl.Marker({ color: "#2b8cdf", scale: 0.6 });
  marker.setLngLat(ref.lngLat).addTo(map);
}

// A pick swallows the click before MapLibre sees it (capture phase on the
// map's container, which is the canvas container's parent), so it doesn't
// also open a reach, gage or catchment. A drag isn't a pick.
function onPointerDown(e) {
  downAt = picking ? [e.clientX, e.clientY] : null;
}

function onClickCapture(e) {
  if (!picking || !downAt) return;
  if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  e.stopPropagation();
  e.preventDefault();
  const rect = map.getCanvasContainer().getBoundingClientRect();
  setPicking(false);
  setReference(map.unproject([e.clientX - rect.left, e.clientY - rect.top]));
}

// ---- Hover readout ----------------------------------------------------

function flatRows(elev) {
  const rows = [labeledRow("Elevation", fmt(elev), { prefix: "tooltip" })];
  if (ref) rows.push(labeledRow("vs reference", `${signed(elev - ref.elev)} m`, { prefix: "tooltip" }));
  if (level != null && elev < level) {
    rows.push(labeledRow("Water depth", fmt(level - elev), { prefix: "tooltip", cls: "flood-depth" }));
  }
  return rows;
}

// HAND, the reach the cell drains to, its stage and the depth there.
function nwmRows(elev, at) {
  const row = (label, value, cls) => labeledRow(label, value, { prefix: "tooltip", cls });
  const rows = [];
  if (elev != null) rows.push(row("Elevation", fmt(elev)));
  if (!at) return rows;
  rows.push(row("Drains to", Number.isFinite(at.wb) ? `wb-${at.wb} · COMID ${at.comid}` : `COMID ${at.comid}`));
  rows.push(row("HAND", fmt(at.hand)));
  if (Number.isFinite(at.stage)) {
    rows.push(row("Stage", fmt(at.stage)));
    if (at.depth > 0) rows.push(row("Water depth", fmt(at.depth), "flood-depth"));
  }
  return rows;
}

function onMouseMove(e) {
  const tooltip = $("floodTooltip");
  const elev = open ? elevationAt(e.lngLat) : null;
  const rows = !open ? [] : mode === "nwm" ? nwmRows(elev, fimAt(e.lngLat)) : elev == null ? [] : flatRows(elev);
  if (!rows.length) {
    tooltip.classList.remove("visible");
    return;
  }
  tooltip.replaceChildren(...rows);
  // Above-right of the cursor, so it doesn't sit on the reach tooltip
  // (below-right).
  tooltip.style.left = `${e.point.x + 15}px`;
  tooltip.style.top = `${e.point.y - 15}px`;
  tooltip.classList.add("visible");
}

function hideTooltip() {
  $("floodTooltip").classList.remove("visible");
}

// ---- Open / close -----------------------------------------------------

// Opening turns the terrain on (if it was off) and tilts a flat camera so
// the water reads as 3D.
function enter3d() {
  if (!map.getTerrain()) map.setTerrain({ source: "terrainSource", exaggeration: 1 });
  if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
}

function onToggle() {
  open = !$("floodPanel").classList.contains("collapsed");
  // A shared link can open the panel before the style has loaded.
  if (!map.getLayer(FLOOD_LAYER)) {
    map.once("styledata", onToggle);
    return;
  }
  if (open) {
    enter3d();
    needsFit = true;
    map.triggerRepaint(); // so an idle follows even if nothing moves
  } else {
    setPicking(false);
    hideTooltip();
  }
  applyMode();
}

// Show the controls for the mode, and switch its layer on (the other's off).
function applyMode() {
  $("floodMode").value = mode;
  $("floodFlat").style.display = mode === "flat" ? "" : "none";
  $("floodNwm").style.display = mode === "nwm" ? "" : "none";
  if (mode !== "flat") setPicking(false);
  setFimActive(open && mode === "nwm");
  applyWater();
  showMarker();
}

export function setupFloodPanel() {
  setupFim();
  onFimStatus(({ kind, text }) => setStatus(kind, text, "fim"));
  $("floodMode").addEventListener("change", (e) => {
    mode = e.target.value;
    applyMode();
    if (mode === "flat") needsFit = true;
  });
  $("floodStageFrom").addEventListener("change", (e) => setFimFrom(e.target.value));
  $("floodDepthFrom").addEventListener("change", (e) => setFimDepthFrom(e.target.value));
  // The depth choice only applies to an ngen run (an NWM run has no depth).
  onActiveDatasetChange(({ data }) => {
    $("floodDepthFromRow").style.display = data && data.reaches !== "nwm" && !data.isDiff ? "" : "none";
  });
  $("floodLevel").addEventListener("input", (e) => setLevel(baseElev() + Number(e.target.value)));
  $("floodLevelInput").addEventListener("change", (e) => {
    if (e.target.value !== "") setLevel(baseElev() + Number(e.target.value));
  });
  $("floodBase").addEventListener("change", (e) => {
    base = e.target.value;
    fitSlider();
    syncControls();
  });
  $("floodPickBtn").addEventListener("click", () => setPicking(!picking));
  $("floodClearRefBtn").addEventListener("click", () => {
    ref = null;
    base = "sea";
    fitSlider();
    syncControls();
    showMarker();
  });
  $("floodLegendGradient").style.background =
    `linear-gradient(to right, ${FLOOD_SHALLOW_COLOR}, ${FLOOD_DEEP_COLOR})`;
  $("floodLegendMax").textContent = `${FLOOD_DEEP_M}+ m`;

  const container = map.getContainer();
  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("click", onClickCapture, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) setPicking(false);
  });

  map.on("mousemove", onMouseMove);
  map.getCanvas().addEventListener("mouseleave", hideTooltip);
  map.on("moveend", () => {
    if (open) needsFit = true;
  });
  map.on("idle", () => {
    if (!open || mode !== "flat" || !needsFit) return;
    needsFit = false;
    fitSlider();
  });

  $("floodPanel").querySelector(".panel-title").addEventListener("click", onToggle);
  onToggle();
  syncControls();
}

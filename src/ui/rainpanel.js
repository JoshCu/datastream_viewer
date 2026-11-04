// ====================================================================
// Rainfall panel: pick a product, variable and dates, load the view, and step
// through it. The reads are in data/rain.js and the map side in rain/rain.js;
// this owns the DOM. Nothing touches the network until the Load button.
// ====================================================================
import { forcingState, map, rainState, state } from "../state.js";
import { RAIN_CONFIRM_BYTES, RAIN_PRODUCTS } from "../config.js";
import { colormapColors, colormapGradient } from "../color/colormaps.js";
import { loadRainGrid, planRainLoad } from "../data/rain.js";
import { onForcingChange } from "../forcing/store.js";
import { renderRainCredit } from "../rain/credit.js";
import {
  clearRain,
  followRainClock,
  onRainChange,
  rainValueAt,
  setRainColormap,
  setRainDisplay,
  setRainTimeIndex,
  showRainGrid,
} from "../rain/rain.js";
import { fillColormapSelect } from "./colormap.js";
import { setStatus } from "./panels.js";
import { onTimeChange } from "./time.js";

const $ = (id) => document.getElementById(id);
const status = (kind, text) => setStatus(kind, text, "rain");
const DAY_MS = 24 * 3600 * 1000;

let busy = false;

const fmtBytes = (b) =>
  b < 1024 * 1024
    ? `${(b / 1024).toFixed(0)} kB`
    : b < 1024 ** 3
      ? `${(b / 1024 ** 2).toFixed(1)} MB`
      : `${(b / 1024 ** 3).toFixed(2)} GB`;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (input) => (input.value ? Date.parse(`${input.value}T00:00:00Z`) : NaN);

function syncVariables() {
  const { variables } = RAIN_PRODUCTS[rainState.product];
  $("rainVariable").replaceChildren(
    ...Object.entries(variables).map(([key, v]) => new Option(`${v.label} (${v.units})`, key)),
  );
  if (!variables[rainState.variable]) rainState.variable = Object.keys(variables)[0];
  $("rainVariable").value = rainState.variable;
}

function setDefaultDates() {
  const { defaultDays } = RAIN_PRODUCTS[rainState.product];
  const today = Date.now();
  $("rainTo").value = isoDay(today);
  $("rainFrom").value = isoDay(today - defaultDays * DAY_MS);
}

function viewBounds() {
  const b = map.getBounds();
  return {
    west: Math.max(-180, b.getWest()),
    south: Math.max(-90, b.getSouth()),
    east: Math.min(180, b.getEast()),
    north: Math.min(90, b.getNorth()),
  };
}

async function load() {
  if (busy) return;
  const fromMs = dayMs($("rainFrom"));
  const toMs = dayMs($("rainTo"));
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    status("error", "Pick a date range");
    return;
  }
  busy = true;
  $("rainLoadBtn").disabled = true;
  try {
    status("loading", "Measuring the download…");
    const plan = await planRainLoad({
      product: rainState.product,
      variable: rainState.variable,
      fromMs,
      toMs: toMs + DAY_MS - 1,
      bounds: viewBounds(),
    });
    const sampling = plan.stride > 1 ? `, every ${plan.stride}th cell` : "";
    const summary =
      `${plan.chunks.length} chunks, ${fmtBytes(plan.bytes)} to download, ` +
      `${fmtBytes(plan.memoryBytes)} in memory (${plan.nT} steps × ${plan.ny} × ${plan.nx}${sampling})`;
    if (plan.bytes > RAIN_CONFIRM_BYTES && !confirm(`This load means ${summary}. Continue?`)) {
      status("idle", "Load cancelled");
      return;
    }
    status("loading", `Loading ${summary}…`);
    const grid = await loadRainGrid(plan, {
      onProgress: (done, total, bytes) =>
        status("loading", `Loading chunks ${done} / ${total} · ${fmtBytes(bytes)}`),
    });
    showRainGrid(grid);
    status("success", `${grid.nT} steps × ${grid.ny} × ${grid.nx}${sampling} · ${fmtBytes(grid.bytes)}`);
  } catch (err) {
    console.error("Rainfall load error:", err);
    status("error", `Error: ${err.message}`);
  } finally {
    busy = false;
    $("rainLoadBtn").disabled = false;
  }
}

function syncLegend() {
  const grid = rainState.grid;
  if (!grid) return;
  const { label, units, min, max, log } = grid.info;
  $("rainLegendTitle").textContent = `${RAIN_PRODUCTS[grid.product].name} ${label} (${units})${log ? " · log" : ""}`;
  $("rainLegendGradient").style.background = colormapGradient(colormapColors(rainState.colormap));
  $("rainLegendMin").textContent = String(min);
  $("rainLegendMax").textContent = String(max);
}

function syncTime() {
  const grid = rainState.grid;
  if (!grid) return;
  const t = grid.time[rainState.timeIndex];
  $("rainTimeSlider").value = rainState.timeIndex;
  $("rainTime").textContent = `${new Date(t).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

// ---- Playback ---------------------------------------------------------------

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const PLAY_INTERVAL_MS = 300;
let playing = false;
let lastStep = 0;

function step(delta) {
  const grid = rainState.grid;
  if (grid) setRainTimeIndex((rainState.timeIndex + delta + grid.nT) % grid.nT);
}

function tick(now) {
  if (!playing) return;
  if (now - lastStep >= PLAY_INTERVAL_MS) {
    lastStep = now;
    step(1);
  }
  requestAnimationFrame(tick);
}

function setPlaying(on) {
  playing = on && !!rainState.grid;
  $("rainPlayBtn").innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  $("rainPlayBtn").classList.toggle("active", playing);
  if (playing) requestAnimationFrame(tick);
}

// ---- Setup ------------------------------------------------------------------

export function setupRainPanel() {
  $("rainProduct").replaceChildren(
    ...Object.entries(RAIN_PRODUCTS).map(([key, p]) => new Option(p.label, key)),
  );
  $("rainProduct").value = rainState.product;
  syncVariables();
  setDefaultDates();
  renderRainCredit($("rainCredit"), rainState.product);
  fillColormapSelect($("rainColormap"), false, rainState.colormap);

  $("rainProduct").addEventListener("change", (e) => {
    rainState.product = e.target.value;
    syncVariables();
    setDefaultDates();
    renderRainCredit($("rainCredit"), rainState.product);
  });
  $("rainVariable").addEventListener("change", (e) => {
    rainState.variable = e.target.value;
  });
  $("rainLoadBtn").addEventListener("click", load);
  $("rainClearBtn").addEventListener("click", () => {
    clearRain();
    status("idle", "Idle");
  });
  $("rainDisplay").addEventListener("change", (e) => setRainDisplay(e.target.value));
  $("rainColormap").addEventListener("change", (e) => {
    setRainColormap(e.target.value);
    syncLegend();
  });
  $("rainTimeSlider").addEventListener("input", (e) => setRainTimeIndex(Number(e.target.value)));
  $("rainPlayBtn").addEventListener("click", () => setPlaying(!playing));
  $("rainStepBackBtn").addEventListener("click", () => step(-1));
  $("rainStepFwdBtn").addEventListener("click", () => step(1));

  onRainChange(({ kind }) => {
    if (kind === "time") {
      syncTime();
      return;
    }
    const grid = rainState.grid;
    $("rainControls").style.display = grid ? "" : "none";
    $("rainClearBtn").disabled = !grid;
    if (!grid) {
      setPlaying(false);
      return;
    }
    $("rainTimeSlider").max = grid.nT - 1;
    syncLegend();
    syncTime();
    // The credit on show is the loaded product's until the picker moves on.
    renderRainCredit($("rainCredit"), grid.product);
  });

  // Rain follows the clock of whatever it's being compared with.
  onTimeChange(() => {
    if (state.data?.timeAbsolute) followRainClock(state.data.time[state.timeIndex]);
  });
  onForcingChange(({ kind }) => {
    if (kind === "time" && forcingState.run) followRainClock(forcingState.run.time[forcingState.timeIndex]);
  });

  map.on("mousemove", (e) => {
    const grid = rainState.grid;
    if (!grid) return;
    const v = rainValueAt(e.lngLat.lng, e.lngLat.lat);
    $("rainHover").textContent =
      v === undefined
        ? "Off the loaded area"
        : Number.isNaN(v)
          ? "No data here"
          : `${v.toFixed(2)} ${grid.info.units} at ${e.lngLat.lat.toFixed(2)}, ${e.lngLat.lng.toFixed(2)}`;
  });
}

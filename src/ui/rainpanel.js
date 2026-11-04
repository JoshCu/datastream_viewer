// ====================================================================
// Rainfall panel: pick a product, variable and dates, and load the view; the
// timeline steps through it. The reads are in data/rain.js and the map side in rain/rain.js;
// this owns the DOM. Nothing touches the network until the Load button.
// ====================================================================
import { map, rainState } from "../state.js";
import { RAIN_CONFIRM_BYTES, RAIN_PRODUCTS, TIMELINE_COLORS } from "../config.js";
import { colormapColors, colormapGradient } from "../color/colormaps.js";
import { loadRainGrid, planRainLoad } from "../data/rain.js";
import { renderRainCredit } from "../rain/credit.js";
import {
  clearRain,
  onRainChange,
  rainValueAt,
  setRainColormap,
  setRainDisplay,
  setRainTimeIndex,
  setRainVisible,
  showRainGrid,
} from "../rain/rain.js";
import { fillColormapSelect } from "./colormap.js";
import { setStatus } from "./panels.js";
import { registerPanelLayer, syncPanelLayers } from "./panellayers.js";
import { registerTimelineTracks, syncTimeline, trackMoved } from "./timeline.js";

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

  registerPanelLayer("rainPanel", {
    name: "rainfall",
    isShowing: () => rainState.visible,
    canToggle: () => !!rainState.grid,
    toggle: () => setRainVisible(!rainState.visible),
  });

  registerTimelineTracks(() => {
    const grid = rainState.grid;
    if (!grid) return [];
    const product = RAIN_PRODUCTS[grid.product];
    return [
      {
        key: "rain",
        label: grid.product.toUpperCase(),
        detail: `${product.name} ${grid.info.label}`,
        color: TIMELINE_COLORS.rain,
        times: grid.time,
        index: () => rainState.timeIndex,
        seek: setRainTimeIndex,
        panel: "rainPanel",
      },
    ];
  });

  onRainChange(({ kind }) => {
    if (kind === "time") {
      trackMoved("rain", rainState.timeIndex);
      return;
    }
    syncPanelLayers();
    syncTimeline();
    const grid = rainState.grid;
    $("rainControls").style.display = grid ? "" : "none";
    $("rainClearBtn").disabled = !grid;
    if (!grid) return;
    syncLegend();
    // The credit on show is the loaded product's until the picker moves on.
    renderRainCredit($("rainCredit"), grid.product);
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

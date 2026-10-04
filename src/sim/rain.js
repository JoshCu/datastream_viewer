// ====================================================================
// Live-routing rain: feed forcing precipitation into the sim as lateral
// inflow.
//
// Each catchment drains to the reach with the same number (cat-N → wb-N in
// the NextGen hydrofabric), so a catchment's qlat is its precipitation rate
// times its area times a runoff fraction — a crude stand-in for a runoff
// model, but enough to see where the rain goes. The forcings come through
// the Forcings panel's loader (the latest short-range cycle when no source is
// picked yet, rows for the catchments in view), and new rows are fetched as
// the view moves.
//
// The table is per catchment and per forcing interval (hourly); the sim
// worker holds each reach's qlat at its interval's value before every 5-min
// step, and loops the series once it runs out (a short-range cycle is only
// 18 h). The catchment colours follow the interval being routed.
//
// Like sim/brush.js this imports network.js, never the reverse, and listens
// through onSimUpdate.
// ====================================================================
import { state, forcingState, map } from "../state.js";
import { DIVIDE_FEATURE, isValid } from "../config.js";
import { setSimForcing, simForcingPosition, onSimUpdate } from "./network.js";
import { onForcingChange } from "../forcing/store.js";
import { hasForcingSource } from "../forcing/loader.js";
import { setForcingTimeIndex } from "../forcing/paint.js";
import { MIN_CATCHMENT_ZOOM } from "../forcing/viewport.js";
import { loadLatestShortRange, loadViewportForcings } from "../ui/forcingpanel.js";

// Precipitation variables, in order of preference; both are kg m⁻² s⁻¹,
// i.e. mm/s of water.
const PRECIP_VARIABLES = ["precip_rate", "APCP_surface"];
// Wait this long after the camera or the catchment tiles settle before
// fetching rows / rebuilding the table.
const REFRESH_DEBOUNCE_MS = 600;

let driving = false;
let runoff = 0.3; // fraction of the rain that reaches the channel
let note = ""; // why rain isn't flowing, shown in place of the clock
// Catchment areas (m²) by id, the largest seen: each refresh sums whatever
// pieces of the catchment the loaded tiles hold, which grows as tiles land.
const areas = new Map();
let refreshTimer = null;
let shownIndex = null;

const $ = (id) => document.getElementById(id);

const precipVariable = (run) => PRECIP_VARIABLES.find((v) => run?.variables.includes(v));

// ---- Catchment areas ---------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

// Signed area (m²) of one ring, on a local equirectangular projection.
function ringArea(ring) {
  let lat0 = 0;
  for (const p of ring) lat0 += p[1];
  const kx = Math.cos((lat0 / ring.length) * RAD);
  let a = 0;
  for (let k = 1; k < ring.length; k++) {
    const [x0, y0] = ring[k - 1];
    const [x1, y1] = ring[k];
    a += x0 * kx * y1 - x1 * kx * y0;
  }
  return (a / 2) * (RAD * EARTH_RADIUS_M) ** 2;
}

function polygonArea(rings) {
  // Holes wind against the outer ring, so the signed sum subtracts them.
  return Math.abs(rings.reduce((a, r) => a + ringArea(r), 0));
}

// A catchment crossing tile boundaries comes back once per tile, each piece
// clipped to (a small buffer around) its tile, so the pieces add up to about
// its area — as sim/network.js does for reach lengths.
function measureAreas() {
  const fresh = new Map();
  const features = map.querySourceFeatures(DIVIDE_FEATURE.source, {
    sourceLayer: DIVIDE_FEATURE.sourceLayer,
  });
  for (const f of features) {
    if (f.id == null) continue;
    const g = f.geometry;
    const polys = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : [];
    let a = 0;
    for (const rings of polys) a += polygonArea(rings);
    fresh.set(f.id, (fresh.get(f.id) ?? 0) + a);
  }
  for (const [id, a] of fresh) if (a > (areas.get(id) ?? 0)) areas.set(id, a);
}

// ---- The inflow table --------------------------------------------------

// Send the sim worker qlat (m³/s) per reach per forcing interval, for every
// loaded catchment whose area is known.
function sendTable(restart = false) {
  if (!driving) return;
  const run = forcingState.run;
  const variable = precipVariable(run);
  if (!variable) {
    setSimForcing(null);
    note = run ? "These forcings have no precipitation" : "Waiting for forcings…";
    updateReadout();
    return;
  }
  measureAreas();
  const n = run.nTimes;
  const m = run.matrices[variable];
  const ids = [];
  const slots = [];
  for (const [id, slot] of run.index) {
    if (areas.has(id)) {
      ids.push(id);
      slots.push(slot);
    }
  }
  const qlat = new Float32Array(ids.length * n);
  for (let j = 0; j < ids.length; j++) {
    // mm/s → m/s, over the catchment, times the runoff fraction.
    const k = 1e-3 * areas.get(ids[j]) * runoff;
    const base = slots[j] * n;
    for (let t = 0; t < n; t++) {
      const v = m[base + t];
      qlat[j * n + t] = isValid(v) && v > 0 ? v * k : 0;
    }
  }
  const dt = n > 1 ? (run.time[1] - run.time[0]) / 1000 : 3600;
  setSimForcing({ ids: Uint32Array.from(ids), qlat, nTimes: n, dt }, restart);
  note = ids.length ? "" : "No catchments with rain loaded in view";
  updateReadout();
}

// Fetch rows for the catchments in view (big loads are skipped, not asked
// about, since this runs on every pan), then rebuild the table.
function scheduleRefresh() {
  if (!driving) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!driving) return;
    if (hasForcingSource() && !forcingState.busy && map.getZoom() >= MIN_CATCHMENT_ZOOM) {
      // A load that adds rows rebuilds the table through onForcingChange.
      await loadViewportForcings({ ask: false });
    }
    // Catchment tiles that landed since the last table add to the areas.
    sendTable();
  }, REFRESH_DEBOUNCE_MS);
}

// ---- Mode switching ------------------------------------------------------

async function startRain() {
  driving = true;
  shownIndex = null;
  syncControls();
  if (!hasForcingSource()) {
    note = "Finding the latest short-range forcings…";
    updateReadout();
    if (!(await loadLatestShortRange())) {
      note = "Couldn't find a forcing cycle (see the Forcings panel)";
      updateReadout();
      return;
    }
  }
  if (!driving) return;
  if (map.getZoom() < MIN_CATCHMENT_ZOOM) {
    note = `Zoom in to level ${MIN_CATCHMENT_ZOOM} or closer to fetch forcings`;
    updateReadout();
    return;
  }
  note = "Fetching forcings for the catchments in view…";
  updateReadout();
  await loadViewportForcings({ ask: true });
  if (driving) sendTable(true);
}

function stopRain() {
  driving = false;
  clearTimeout(refreshTimer);
  setSimForcing(null);
  note = "";
  syncControls();
}

// ---- Panel ----------------------------------------------------------------

function syncControls() {
  $("simRainBtn").classList.toggle("active", driving);
  $("simRainControls").style.display = driving ? "" : "none";
  updateReadout();
}

function fmtTime(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function updateReadout() {
  const el = $("simRainInfo");
  if (!driving) return;
  const pos = simForcingPosition();
  const run = forcingState.run;
  if (note || !pos || !run) {
    el.textContent = note || "Starting…";
    return;
  }
  el.textContent =
    `Forcing ${fmtTime(run.time[pos.index])} · hour ${pos.index + 1}/${run.nTimes}` +
    (pos.loop ? ` · loop ${pos.loop + 1}` : "");
  // The catchment colours follow the interval being routed.
  if (pos.index !== shownIndex) {
    shownIndex = pos.index;
    setForcingTimeIndex(pos.index);
  }
}

export function setupSimRain() {
  $("simRainBtn").addEventListener("click", () => (driving ? stopRain() : startRain()));

  const slider = $("simRunoff");
  const value = $("simRunoffValue");
  const applyRunoff = () => {
    runoff = parseInt(slider.value, 10) / 100;
    value.textContent = `${slider.value}%`;
  };
  slider.addEventListener("input", applyRunoff);
  // Rebuilding the table on every input tick would be wasted work.
  slider.addEventListener("change", () => sendTable());
  applyRunoff();

  onForcingChange(({ kind }) => {
    if (!driving) return;
    // A new run (another cycle) starts its series over.
    if (kind === "run" || kind === "sources") sendTable(true);
    else if (kind === "rows") sendTable();
  });
  map.on("moveend", scheduleRefresh);
  map.on("sourcedata", (e) => {
    if (e.sourceId === DIVIDE_FEATURE.source && e.tile) scheduleRefresh();
  });

  // Rain stops with the sim (the worker drops its table on stop).
  onSimUpdate(() => {
    if (!state.simActive && driving) stopRain();
    else updateReadout();
  });
  syncControls();
}

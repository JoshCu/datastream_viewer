// ====================================================================
// NEXRAD panel: date → station → scan pickers, product/tilt/threshold and
// the point-cloud display sliders. Listings and loads go through
// nexrad/source.js; drawing through nexrad/layer.js.
// ====================================================================
import { map, nexradState } from "../state.js";
import { setStatus } from "./panels.js";
import { PRODUCTS, legendCss } from "../nexrad/products.js";
import { listStations, listScans, loadVolume } from "../nexrad/source.js";
import { rebuildNexrad, renderNexrad } from "../nexrad/layer.js";

const $ = (id) => document.getElementById(id);
const STATION_KEY = "nexradStation";

let scans = [];
let listSeq = 0; // newer listings/loads supersede older ones
let loadSeq = 0;

const status = (kind, text) => setStatus(kind, text, "nexrad");
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 19)}Z`;

function savedStation() {
  try {
    return localStorage.getItem(STATION_KEY) || "";
  } catch {
    return "";
  }
}

function saveStation(station) {
  try {
    localStorage.setItem(STATION_KEY, station);
  } catch {
    // Storage blocked: the pick just isn't remembered.
  }
}

// Replace a select's options with a placeholder plus [value, label] pairs.
function fillSelect(select, items, placeholder) {
  select.replaceChildren(
    new Option(placeholder, ""),
    ...items.map(([value, label]) => new Option(label, value)),
  );
}

async function refreshStations() {
  const date = $("nexradDate").value;
  if (!date) return;
  const seq = ++listSeq;
  status("loading", "Listing stations…");
  try {
    const stations = await listStations(date);
    if (seq !== listSeq) return;
    const want = $("nexradStation").value || savedStation();
    fillSelect($("nexradStation"), stations.map((s) => [s, s]), "Station…");
    if (stations.includes(want)) $("nexradStation").value = want;
    status("idle", stations.length ? `${stations.length} stations on ${date}` : `No data on ${date}`);
    await refreshScans();
  } catch (err) {
    if (seq === listSeq) status("error", err.message);
  }
}

async function refreshScans() {
  const date = $("nexradDate").value;
  const station = $("nexradStation").value;
  scans = [];
  fillSelect($("nexradScan"), [], "Scan time…");
  if (!date || !station) return;
  saveStation(station);
  const seq = ++listSeq;
  status("loading", `Listing ${station} scans…`);
  try {
    const found = await listScans(date, station);
    if (seq !== listSeq) return;
    scans = found;
    fillSelect(
      $("nexradScan"),
      scans.map((s, i) => [String(i), clock(s.time)]),
      scans.length ? "Scan time…" : "No scans",
    );
    status("idle", `${scans.length} ${station} scans on ${date} — pick a time`);
  } catch (err) {
    if (seq === listSeq) status("error", err.message);
  }
}

// Rebuild the tilt picker for the loaded volume, keeping the chosen angle if
// the new volume has it.
function syncTilts() {
  const { cuts } = nexradState.volume;
  const select = $("nexradTilt");
  const was = nexradState.cut >= 0 ? Number(select.selectedOptions[0]?.dataset.angle) : null;
  select.replaceChildren(
    new Option("All tilts", "-1"),
    ...cuts.map((c, i) => {
      const opt = new Option(`${c.angle.toFixed(1)}°`, String(i));
      opt.dataset.angle = c.angle;
      return opt;
    }),
  );
  const match = was == null ? -1 : cuts.findIndex((c) => Math.abs(c.angle - was) < 0.25);
  nexradState.cut = match;
  select.value = String(match);
}

// Threshold slider range and legend for the current product.
function syncProduct() {
  const p = PRODUCTS[nexradState.product];
  const slider = $("nexradThreshold");
  slider.min = p.signed ? 0 : p.min;
  slider.max = p.max;
  slider.step = p.max - p.min < 5 ? 0.01 : 0.5;
  slider.value = nexradState.threshold;
  $("nexradThresholdValue").textContent = `${nexradState.threshold}`;
  $("nexradLegendTitle").textContent = `${p.label}${p.units ? ` (${p.units})` : ""}`;
  $("nexradLegendGradient").style.background = legendCss(p);
  $("nexradLegendMin").textContent = p.min;
  $("nexradLegendMax").textContent = p.max;
}

function summary(count) {
  const { icao, site, time } = nexradState.volume;
  status(
    "success",
    `${icao} ${isoDate(time)} ${clock(time)} · VCP ${site.vcp} · ${count.toLocaleString()} pts`,
  );
}

// Load `url` (a scan) for the current product and draw it. Moves the camera
// only when the radar changes.
async function showScan(url) {
  const seq = ++loadSeq;
  const prev = nexradState.volume;
  status("loading", "Downloading…");
  try {
    const volume = await loadVolume(url, nexradState.product, (got, total) => {
      if (seq !== loadSeq) return;
      if (total && got >= total) status("loading", "Decoding…");
      else status("loading", `Downloading ${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ""} MB…`);
    });
    if (seq !== loadSeq) return;
    nexradState.volume = volume;
    nexradState.url = url;
    syncTilts();
    const count = await rebuildNexrad();
    if (seq !== loadSeq) return;
    $("nexradControls").style.display = "";
    $("nexradClearBtn").disabled = false;
    summary(count);
    if (prev?.icao !== volume.icao) {
      map.flyTo({ center: [volume.site.lon, volume.site.lat], zoom: 7, pitch: 60 });
    }
  } catch (err) {
    if (seq === loadSeq) status("error", err.message);
  }
}

function loadScanAt(i) {
  if (!scans[i]) return;
  $("nexradScan").value = String(i);
  showScan(scans[i].url);
}

function step(delta) {
  const i = Number($("nexradScan").value);
  const next = $("nexradScan").value === "" ? (delta > 0 ? 0 : scans.length - 1) : i + delta;
  loadScanAt(next);
}

// Today's (UTC) newest scan for the chosen station, falling back to
// yesterday just after midnight.
async function loadLatest() {
  if (!$("nexradStation").value) {
    status("error", "Pick a station first");
    return;
  }
  for (const daysBack of [0, 1]) {
    const date = isoDate(Date.now() - daysBack * 86400000);
    if ($("nexradDate").value !== date) {
      $("nexradDate").value = date;
      await refreshStations();
    } else {
      await refreshScans();
    }
    if (scans.length) {
      loadScanAt(scans.length - 1);
      return;
    }
  }
}

function clear() {
  loadSeq++;
  nexradState.volume = null;
  nexradState.url = null;
  rebuildNexrad();
  $("nexradControls").style.display = "none";
  $("nexradClearBtn").disabled = true;
  $("nexradScan").value = "";
  status("idle", "Cleared");
}

// Coalesce slider drags into one rebuild per frame.
let rebuildQueued = false;
function scheduleRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(async () => {
    rebuildQueued = false;
    if (nexradState.volume) summary(await rebuildNexrad());
  });
}

// A display slider: writes its number to nexradState[key], shows `fmt(value)`
// next to it, then calls `apply`.
function bindSlider(id, key, fmt, apply) {
  $(id).addEventListener("input", (e) => {
    nexradState[key] = Number(e.target.value);
    $(`${id}Value`).textContent = fmt(nexradState[key]);
    apply();
  });
}

export function setupNexradPanel() {
  const panel = $("nexradPanel");
  $("nexradDate").value = isoDate(Date.now());
  $("nexradDate").max = isoDate(Date.now());

  // List stations the first time the panel is opened (or now, if a shared
  // link opened it).
  let listed = false;
  const listOnce = () => {
    if (listed || panel.classList.contains("collapsed")) return;
    listed = true;
    refreshStations();
  };
  panel.querySelector(".panel-title").addEventListener("click", listOnce);
  listOnce();

  $("nexradDate").addEventListener("change", refreshStations);
  $("nexradStation").addEventListener("change", refreshScans);
  $("nexradScan").addEventListener("change", (e) => loadScanAt(Number(e.target.value)));
  $("nexradPrevBtn").addEventListener("click", () => step(-1));
  $("nexradNextBtn").addEventListener("click", () => step(1));
  $("nexradLatestBtn").addEventListener("click", loadLatest);
  $("nexradClearBtn").addEventListener("click", clear);

  $("nexradProduct").addEventListener("change", (e) => {
    nexradState.product = e.target.value;
    nexradState.threshold = PRODUCTS[nexradState.product].threshold;
    syncProduct();
    if (nexradState.url) showScan(nexradState.url);
  });
  $("nexradTilt").addEventListener("change", (e) => {
    nexradState.cut = Number(e.target.value);
    scheduleRebuild();
  });

  bindSlider("nexradThreshold", "threshold", (v) => `${v}`, scheduleRebuild);
  bindSlider("nexradExaggeration", "exaggeration", (v) => `${v}×`, renderNexrad);
  bindSlider("nexradPointSize", "pointSize", (v) => `${v}px`, renderNexrad);
  bindSlider("nexradOpacity", "opacity", (v) => v.toFixed(2), renderNexrad);

  syncProduct();
}

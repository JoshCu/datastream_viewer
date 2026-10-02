// ====================================================================
// NEXRAD panel: one date picker, then a station → scan row per radar, a lock
// that steps them together, and the shared product/tilt/threshold and
// point-cloud display sliders. Listings and loads go through
// nexrad/source.js; drawing through nexrad/layer.js.
//
// Locked, stepping (or picking a scan on) a row moves that row, then every
// other row jumps to its scan nearest the new time — which can be the scan
// it's already on, since the radars don't scan in step.
// ====================================================================
import { map, nexradState } from "../state.js";
import { setStatus } from "./panels.js";
import { PRODUCTS, legendCss } from "../nexrad/products.js";
import { listStations, listScans, loadVolume, forgetStation, SAME_TILT_DEG } from "../nexrad/source.js";
import { rebuildNexrad, renderNexrad, refadeNexrad } from "../nexrad/layer.js";
import { showSites, styleSites, stationCoords } from "../nexrad/sites.js";
import { birdProfile, compass, sunElevation } from "../nexrad/birds.js";
import { surfaceAt } from "../nexrad/surface.js";
import { onForcingChange } from "../forcing/store.js";

const $ = (id) => document.getElementById(id);
const STATIONS_KEY = "nexradStations";
const OLD_STATION_KEY = "nexradStation"; // the single pick, before rows
const DAY_MS = 86400000;

const LOCKED_SHACKLE = "M8 11V7a4 4 0 0 1 8 0v4";
const UNLOCKED_SHACKLE = "M8 11V7a4 4 0 0 1 7.75-1.4";

const radars = nexradState.radars;
const rows = new Map(); // radar.key → { root, station, scan }
let stations = []; // ICAOs with data on the picked date
let listSeq = 0; // a newer date listing supersedes older ones
let nextKey = 0;
let active = null; // the radar whose controls were used last; locked steps follow it

// Per-radar status lines: loads in flight, then failures, else the summary.
const progress = new Map(); // radar.key → text
const errors = new Map();

const status = (kind, text) => setStatus(kind, text, "nexrad");
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 19)}Z`;
const live = (radar) => radars.includes(radar);
const timeOf = (radar) => radar.scans[radar.index]?.time;

function savedStations() {
  try {
    const list = localStorage.getItem(STATIONS_KEY);
    if (list == null) return [localStorage.getItem(OLD_STATION_KEY)].filter(Boolean);
    const ids = JSON.parse(list);
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveStations() {
  try {
    localStorage.setItem(STATIONS_KEY, JSON.stringify(chosen()));
  } catch {
    // Storage blocked: the picks just aren't remembered.
  }
}

const chosen = () => radars.map((r) => r.icao).filter(Boolean);

function restyle() {
  styleSites(stations, chosen());
  $("nexradClearBtn").disabled = !chosen().length;
}

// Replace a select's options with a placeholder plus [value, label] pairs.
function fillSelect(select, items, placeholder) {
  select.replaceChildren(
    new Option(placeholder, ""),
    ...items.map(([value, label]) => new Option(label, value)),
  );
}

// The index of the scan nearest `t`, or -1 if there are none.
function closest(scans, t) {
  let best = -1;
  scans.forEach((s, i) => {
    if (best < 0 || Math.abs(s.time - t) < Math.abs(scans[best].time - t)) best = i;
  });
  return best;
}

// ---- Bird profiles -------------------------------------------------------

function cell(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

// "rain 0.4 mm/h · 10 m wind 3.2 m/s toward NE", from the forcings.
function surfaceLine({ precip, u, v }) {
  const parts = [];
  if (precip != null) parts.push(`rain ${precip.toFixed(1)} mm/h${precip >= 0.1 ? " (may contaminate)" : ""}`);
  if (u != null && v != null) {
    const toward = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
    parts.push(`10 m wind ${Math.hypot(u, v).toFixed(1)} m/s toward ${compass(toward)}`);
  }
  return parts.length ? `Surface: ${parts.join(" · ")}` : null;
}

// Look up a radar's surface context in the forcings, then redraw the
// profiles. Quietly does nothing without forcings for its place and time.
async function refreshSurface(radar) {
  const volume = radar.volume;
  if (!volume?.profile) return;
  const surface = await surfaceAt(volume.site, volume.time).catch(() => null);
  if (radar.volume !== volume || !surface) return;
  volume.surface = surface;
  renderProfiles();
}

// One table per radar in bird mode: density and VAD per height bin, highest
// first, under a title flagging daytime scans and the surface context.
function profileTable({ icao, site, time, profile, surface }) {
  const root = document.createElement("div");
  root.className = "nexrad-profile";
  const sun = sunElevation(time, site.lat, site.lon);
  const title = `${icao} ${clock(time)} · sun ${sun.toFixed(0)}°${sun > -6 ? " (daytime: likely insects)" : ""}`;
  const table = document.createElement("table");
  const head = table.createTHead().insertRow();
  for (const h of ["km AGL", "birds/km³", "m/s", "toward"]) head.append(cell("th", h));
  const body = table.createTBody();
  for (const r of birdProfile(profile).reverse()) {
    const row = body.insertRow();
    row.append(
      cell("td", `${(r.bottom / 1000).toFixed(1)}–${(r.top / 1000).toFixed(1)}`),
      cell("td", r.density.toFixed(1)),
      cell("td", r.speed == null ? "–" : r.speed.toFixed(1)),
      cell("td", r.heading == null ? "–" : `${compass(r.heading)} ${r.heading.toFixed(0)}°`),
    );
  }
  root.append(cell("div", title), table);
  root.firstChild.className = "nexrad-profile-title";
  return root;
}

function renderProfiles() {
  $("nexradBirdProfiles").replaceChildren(
    ...radars.filter((r) => r.volume?.profile).map((r) => profileTable(r.volume)),
  );
}

// ---- Status --------------------------------------------------------------

function summary() {
  const date = $("nexradDate").value;
  const lines = radars
    .filter((r) => r.volume)
    .map(({ volume: { icao, site, time }, points }) => {
      const day = isoDate(time) === date ? "" : `${isoDate(time)} `;
      const k = Math.round((points?.count ?? 0) / 1000);
      return `${icao} ${day}${clock(time)} · VCP ${site.vcp} · ${k}k pts`;
    });
  if (lines.length) status("success", lines.join("\n"));
  else status("idle", radars.some((r) => r.icao) ? "Pick a scan time" : "Pick a station");
}

function renderStatus() {
  renderProfiles();
  if (progress.size) status("loading", [...progress.values()].join("\n"));
  else if (errors.size) status("error", [...errors.values()].join("\n"));
  else summary();
}

// ---- Listings ------------------------------------------------------------

// Fill a row's station picker, keeping its station even if it has no data on
// the picked date, so the row still says what it is.
function fillStations(radar) {
  const ids = !radar.icao || stations.includes(radar.icao) ? stations : [radar.icao, ...stations];
  const select = rows.get(radar.key).station;
  fillSelect(select, ids.map((s) => [s, s]), "Station…");
  select.value = radar.icao;
}

// List a radar's scans on the picked date. Leaves nothing picked (whatever
// is drawn stays drawn); resolves true if the listing is current.
async function refreshScans(radar) {
  const date = $("nexradDate").value;
  const { scan } = rows.get(radar.key);
  radar.scans = [];
  radar.index = -1;
  errors.delete(radar.key);
  fillSelect(scan, [], "Scan time…");
  if (!date || !radar.icao) return false;
  const seq = ++radar.listSeq;
  try {
    const found = await listScans(date, radar.icao);
    if (seq !== radar.listSeq || !live(radar)) return false;
    radar.scans = found;
    fillSelect(
      scan,
      found.map((s, i) => [String(i), clock(s.time)]),
      found.length ? "Scan time…" : "No scans",
    );
    return true;
  } catch (err) {
    if (seq === radar.listSeq) {
      errors.set(radar.key, `${radar.icao}: ${err.message}`);
      renderStatus();
    }
    return false;
  }
}

// List the stations on the picked date, then every row's scans. With
// `follow`, rows that had a scan picked move to the same UTC clock time on
// the new date (locked: the active row does, and the rest snap to it).
async function refreshStations({ follow = true } = {}) {
  const date = $("nexradDate").value;
  if (!date) return;
  const seq = ++listSeq;
  const prior = new Map(radars.map((r) => [r, timeOf(r)]));
  status("loading", "Listing stations…");
  try {
    const found = await listStations(date);
    if (seq !== listSeq) return;
    stations = found;
    for (const r of radars) fillStations(r);
    restyle();
    await Promise.all(radars.map(refreshScans));
    if (seq !== listSeq) return;
    if (!stations.length) status("idle", `No data on ${date}`);
    else renderStatus();
    if (!follow) return;
    const onDate = (t) => Date.parse(date) + (t % DAY_MS);
    if (nexradState.locked) {
      const lead = [active, ...radars].find((r) => r && prior.get(r) != null);
      if (lead) {
        pickScan(lead, closest(lead.scans, onDate(prior.get(lead))));
        syncTo(lead);
      }
    } else {
      for (const r of radars) {
        if (prior.get(r) != null) pickScan(r, closest(r.scans, onDate(prior.get(r))));
      }
    }
  } catch (err) {
    if (seq === listSeq) status("error", err.message);
  }
}

// ---- Loading -------------------------------------------------------------

// Rebuild the tilt picker from every loaded volume's angles, keeping the
// chosen tilt if any radar still has it. Returns true if the tilt changed
// (so every radar's points need rebuilding, not just one).
function syncTilts() {
  const angles = [];
  for (const r of radars) {
    for (const c of r.volume?.cuts ?? []) {
      if (!angles.some((a) => Math.abs(a - c.angle) < SAME_TILT_DEG)) angles.push(c.angle);
    }
  }
  angles.sort((a, b) => a - b);
  const select = $("nexradTilt");
  select.replaceChildren(
    new Option("All tilts", ""),
    ...angles.map((a) => new Option(`${a.toFixed(1)}°`, String(a))),
  );
  const { tilt } = nexradState;
  const match = tilt == null ? undefined : angles.find((a) => Math.abs(a - tilt) < SAME_TILT_DEG);
  select.value = match == null ? "" : String(match);
  if (tilt != null && match == null) {
    nexradState.tilt = null;
    return true;
  }
  return false;
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
  $("nexradBirdRangeRow").style.display = p.ranged ? "" : "none";
}

// Load `url` (one of the radar's scans) for the current product and draw
// it. The camera moves only for the first radar on screen.
async function showScan(radar, url) {
  const seq = ++radar.seq;
  const { icao } = radar;
  radar.loading = url;
  progress.set(radar.key, `${icao} downloading…`);
  renderStatus();
  try {
    const volume = await loadVolume(url, nexradState.product, (got, total) => {
      if (seq !== radar.seq) return;
      progress.set(
        radar.key,
        total && got >= total
          ? `${icao} decoding…`
          : `${icao} ${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ""} MB…`,
      );
      renderStatus();
    });
    if (seq !== radar.seq || !live(radar)) {
      // Removed or re-pointed meanwhile: don't keep its download cached.
      if (!radars.some((r) => r.icao === icao)) forgetStation(icao);
      return;
    }
    const first = !radars.some((r) => r.volume);
    radar.volume = volume;
    radar.url = url;
    errors.delete(radar.key);
    await rebuildNexrad(syncTilts() ? radars : [radar]);
    if (seq !== radar.seq) return;
    refreshSurface(radar);
    $("nexradControls").style.display = "";
    if (first) map.flyTo({ center: [volume.site.lon, volume.site.lat], zoom: 7, pitch: 60 });
  } catch (err) {
    if (seq === radar.seq) errors.set(radar.key, `${icao}: ${err.message}`);
  } finally {
    if (seq === radar.seq) {
      radar.loading = null;
      progress.delete(radar.key);
      if (live(radar)) renderStatus();
    }
  }
}

// Pick scan `i` in a radar's row, loading it unless it's already shown (or
// on its way).
function pickScan(radar, i) {
  const scan = radar.scans[i];
  if (!scan || !live(radar)) return;
  radar.index = i;
  rows.get(radar.key).scan.value = String(i);
  if (scan.url !== (radar.loading ?? radar.url)) showScan(radar, scan.url);
}

// Locked: move every other radar to its scan nearest `lead`'s picked time.
function syncTo(lead) {
  const t = timeOf(lead);
  if (!nexradState.locked || t == null) return;
  for (const r of radars) if (r !== lead) pickScan(r, closest(r.scans, t));
}

function step(radar, delta) {
  setActive(radar);
  const next = radar.index < 0 ? (delta > 0 ? 0 : radar.scans.length - 1) : radar.index + delta;
  if (!radar.scans[next]) return;
  pickScan(radar, next);
  syncTo(radar);
}

// ---- Rows ----------------------------------------------------------------

function setActive(radar) {
  active = radar;
  for (const r of radars) rows.get(r.key).root.classList.toggle("active", r === radar);
}

// Drop a radar's scan from the map (its row stays).
function unload(radar) {
  radar.seq++;
  radar.loading = null;
  radar.volume = null;
  radar.url = null;
  radar.points = null;
  progress.delete(radar.key);
  errors.delete(radar.key);
  if (radar.icao) forgetStation(radar.icao);
}

// After radars are dropped: retire the tilt they alone had, redraw, and hide
// the display controls once nothing is drawn.
function redrawAfterUnload() {
  if (syncTilts()) rebuildNexrad();
  else renderNexrad();
  if (!radars.some((r) => r.volume)) $("nexradControls").style.display = "none";
  restyle();
  saveStations();
  renderStatus();
}

// Point a row at station `id` and list its scans. Locked, it then joins the
// others at the scan nearest the active row's time.
async function setStation(radar, id) {
  const row = rows.get(radar.key);
  if (id && radars.some((r) => r !== radar && r.icao === id)) {
    status("error", `${id} is already shown`);
    row.station.value = radar.icao;
    return;
  }
  unload(radar);
  radar.icao = id;
  redrawAfterUnload();
  const at = stationCoords(id);
  if (at) map.easeTo({ center: at });
  if (!(await refreshScans(radar))) return;
  const lead = [active, ...radars].find((r) => r && r !== radar && timeOf(r) != null);
  if (nexradState.locked && lead) pickScan(radar, closest(radar.scans, timeOf(lead)));
  else renderStatus();
}

function removeRadar(radar) {
  unload(radar);
  radars.splice(radars.indexOf(radar), 1);
  rows.get(radar.key).root.remove();
  rows.delete(radar.key);
  if (active === radar) setActive(radars[0] ?? null);
  redrawAfterUnload();
}

function button(text, title, onClick, extra = "") {
  const b = document.createElement("button");
  b.className = `play-btn nexrad-step ${extra}`.trim();
  b.title = title;
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function addRadar(icao = "") {
  const radar = {
    key: nextKey++,
    icao,
    scans: [],
    index: -1,
    volume: null,
    url: null,
    points: null,
    loading: null, // the url of a load in flight
    seq: 0, // newer loads and listings supersede older ones
    listSeq: 0,
  };
  radars.push(radar);

  const root = document.createElement("div");
  root.className = "nexrad-row nexrad-radar";
  const station = document.createElement("select");
  station.className = "select nexrad-station";
  station.title = "Radar station";
  const scan = document.createElement("select");
  scan.className = "select";
  scan.title = "Volume scan (UTC)";
  station.addEventListener("change", () => setStation(radar, station.value));
  scan.addEventListener("change", () => {
    setActive(radar);
    pickScan(radar, Number(scan.value));
    syncTo(radar);
  });
  root.append(
    station,
    button("‹", "Previous scan", () => step(radar, -1)),
    scan,
    button("›", "Next scan", () => step(radar, 1)),
    button("×", "Remove this radar", () => removeRadar(radar), "nexrad-remove"),
  );
  rows.set(radar.key, { root, station, scan });
  $("nexradRadars").append(root);
  fillStations(radar);
  fillSelect(scan, [], "Scan time…");
  if (!active) setActive(radar);
  restyle();
  return radar;
}

// A station dot was clicked: select its row, else fill an empty row, else
// add one.
function pickStation(id) {
  if (!stations.includes(id)) {
    status("error", `No ${id} data on ${$("nexradDate").value}`);
    return;
  }
  const shown = radars.find((r) => r.icao === id);
  if (shown) {
    setActive(shown);
    return;
  }
  const radar = radars.find((r) => !r.icao) ?? addRadar();
  rows.get(radar.key).station.value = id;
  setStation(radar, id);
}

// Today's (UTC) newest scans, falling back to yesterday just after midnight.
// Locked, the active row takes its newest and the rest snap to it.
async function loadLatest() {
  if (!chosen().length) {
    status("error", "Pick a station first");
    return;
  }
  for (const daysBack of [0, 1]) {
    $("nexradDate").value = isoDate(Date.now() - daysBack * DAY_MS);
    await refreshStations({ follow: false });
    const listed = radars.filter((r) => r.scans.length);
    if (!listed.length) continue;
    if (nexradState.locked) {
      const lead = listed.includes(active) ? active : listed[0];
      pickScan(lead, lead.scans.length - 1);
      syncTo(lead);
    } else {
      for (const r of listed) pickScan(r, r.scans.length - 1);
    }
    return;
  }
}

function clear() {
  for (const r of [...radars]) removeRadar(r);
  addRadar();
  status("idle", "Cleared");
}

function setLocked(on) {
  nexradState.locked = on;
  const btn = $("nexradLockBtn");
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on
    ? "Locked: stepping one station moves the others to their nearest scan"
    : "Unlocked: each station steps on its own";
  $("nexradLockShackle").setAttribute("d", on ? LOCKED_SHACKLE : UNLOCKED_SHACKLE);
  if (on && active) syncTo(active);
}

// ---- Display controls ----------------------------------------------------

// Coalesce slider drags into one rebuild per frame.
let rebuildQueued = false;
function scheduleRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(async () => {
    rebuildQueued = false;
    await rebuildNexrad();
    renderStatus();
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

  const saved = savedStations();
  for (const id of saved) addRadar(id);
  if (!saved.length) addRadar();

  // Station dots show while the panel is open; stations are listed the
  // first time it opens (or now, if a shared link opened it).
  let listed = false;
  const onToggle = () => {
    const open = !panel.classList.contains("collapsed");
    showSites(open, pickStation);
    if (!open || listed) return;
    listed = true;
    refreshStations();
  };
  panel.querySelector(".panel-title").addEventListener("click", onToggle);
  onToggle();

  $("nexradDate").addEventListener("change", () => refreshStations());
  $("nexradLockBtn").addEventListener("click", () => setLocked(!nexradState.locked));
  $("nexradAddBtn").addEventListener("click", () => setActive(addRadar()));
  $("nexradLatestBtn").addEventListener("click", loadLatest);
  $("nexradClearBtn").addEventListener("click", clear);

  $("nexradProduct").addEventListener("change", (e) => {
    nexradState.product = e.target.value;
    nexradState.threshold = PRODUCTS[nexradState.product].threshold;
    syncProduct();
    for (const r of radars) {
      const url = r.loading ?? r.url;
      if (url) showScan(r, url);
    }
  });
  $("nexradTilt").addEventListener("change", (e) => {
    nexradState.tilt = e.target.value === "" ? null : Number(e.target.value);
    scheduleRebuild();
  });

  bindSlider("nexradThreshold", "threshold", (v) => `${v}`, scheduleRebuild);
  bindSlider("nexradBirdRange", "birdRange", (v) => `${v} km`, scheduleRebuild);
  bindSlider("nexradExaggeration", "exaggeration", (v) => `${v}×`, renderNexrad);
  bindSlider("nexradPointSize", "pointSize", (v) => `${v}px`, renderNexrad);
  bindSlider("nexradOpacity", "opacity", (v) => v.toFixed(2), renderNexrad);
  bindSlider("nexradFade", "fade", (v) => (v ? v.toFixed(2) : "off"), refadeNexrad);

  // Surface context needs the radar's catchment on screen and its forcings
  // loaded, so retry whenever either may have changed.
  const retrySurfaces = () => {
    for (const r of radars) if (r.volume?.profile && !r.volume.surface) refreshSurface(r);
  };
  map.on("moveend", retrySurfaces);
  onForcingChange(({ kind }) => {
    if (kind === "time") return;
    for (const r of radars) if (r.volume) r.volume.surface = null;
    retrySurfaces();
  });

  syncProduct();
}

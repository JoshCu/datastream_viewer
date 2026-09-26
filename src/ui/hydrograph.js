// ====================================================================
// Hydrograph dock: an interactive D3 time-series panel for one reach,
// charting every loaded run (data/sources.js) plus USGS observations when
// the reach carries a gage.
//
//   - legend click toggles a line; shift/ctrl-click isolates it
//   - wheel zooms time around the cursor, drag selects a range to zoom to,
//     shift-drag (or horizontal scroll) pans, double-click resets
//   - hover shows a crosshair + tooltip of every visible line at that time;
//     a plain click seeks the map to that timestep
//   - side panel: skill scores of every run against the observations, and
//     an A-vs-B compare (either may be the observations) with an optional
//     A − B diff strip under the main plot
//
// All metrics are computed over the visible time window, so zooming in on
// an event scores just that event. The y axis also auto-fits the window.
// d3 is a global provided by the CDN <script> in index.html.
// ====================================================================
import { state } from "../state.js";
import {
  VARIABLES,
  DIFF_PALETTE,
  SERIES_COLORS,
  SERIES_OVERFLOW_COLOR,
  OBS_COLOR,
  CURRENT_TIME_COLOR,
} from "../config.js";
import { seriesAt } from "../data/access.js";
import { listSources, onSourcesChange } from "../data/sources.js";
import { setTimeIndex } from "./time.js";
import { fetchGageFlow, fetchGageMeta } from "../data/usgs.js";
import {
  alignSeries,
  differenceSeries,
  computeMetrics,
  medianStep,
} from "../data/metrics.js";

const OBS_KEY = "obs";
const MARGIN = { top: 10, right: 16, bottom: 24, left: 60 };
const DIFF_GAP = 16; // vertical space between the main plot and the diff strip
const MIN_SPAN_MS = 30 * 60 * 1000;
const MIN_DOCK_PX = 220;
const METRICS_DEBOUNCE_MS = 120;
// A above B / A below B, taken from the map's diverging ramp so the strip and
// the map can't drift apart.
// Matches .hydro-key.diff / .hydro-diff-line in main.css.
const DIFF_LINE_COLOR = "#c3cad3";
const DIFF_POS_COLOR = DIFF_PALETTE[5];
const DIFF_NEG_COLOR = DIFF_PALETTE[1];

const view = {
  target: null, // { reachId, site }
  variable: "flow",
  series: [], // [{ key, label, kind: "model"|"obs", color, dashed, times, values, step }]
  obsStatus: "",
  hidden: new Set(),
  full: null, // [t0, t1] extent of every series (ms)
  domain: null, // zoomed x-domain (ms)
  logY: false,
  compareA: null,
  compareB: null,
  compareTouched: false, // user picked A/B, so don't re-default when obs lands
  showDiff: false,
  diff: null, // { times, values } of A − B when showDiff
};

let els = null; // cached DOM refs
let chart = null; // d3 selections for the SVG skeleton
let geom = null; // scales + sizes from the last render, for pointer handlers
let hoverPx = null; // pointer x within the plot, or null
let drag = null; // { mode: "brush"|"pan", x0, x1, domain0 }
let requestSeq = 0; // guards async obs fetches against a newer target
let renderQueued = false;
let metricsTimer = null;

const fmtTime = d3.utcFormat("%Y-%m-%d %H:%M UTC");
const fmtShortTime = d3.utcFormat("%m-%d %H:%M");
const fmtSI = d3.format(".3~s");
const fmtNum = d3.format(",.4~r");
const fmtHour = d3.utcFormat("%H:%M");
const fmtDay = d3.utcFormat("%b %d");

// Readouts (tooltip, error metrics): full digits up to the millions.
function fmtValue(v) {
  if (!Number.isFinite(v)) return "–";
  return Math.abs(v) >= 1e6 ? fmtSI(v) : fmtNum(v);
}

// Axis ticks: SI-abbreviated sooner so the y axis stays narrow.
function fmtTick(v) {
  return Math.abs(v) >= 1e4 ? fmtSI(v) : fmtNum(v);
}

// 24-hour clock, with the date at each midnight.
function fmtTimeTick(d) {
  return (d3.utcDay(d) < d ? fmtHour : fmtDay)(d);
}

// Skill scores are ~[-1, 1] when a run is any good; a hopeless one can run
// to -1e11, which is abbreviated so it doesn't blow out the table.
function fmtScore(v, digits = 2) {
  if (!Number.isFinite(v)) return "–";
  return Math.abs(v) < 100 ? v.toFixed(digits) : fmtSI(v);
}

// ---- Setup -----------------------------------------------------------

export function setupHydrograph() {
  const $ = (id) => document.getElementById(id);
  els = {
    dock: $("hydro-dock"),
    title: $("hydro-title"),
    subtitle: $("hydro-subtitle"),
    legend: $("hydro-legend"),
    chart: $("hydro-chart"),
    empty: $("hydro-empty"),
    tooltip: $("hydro-tooltip"),
    status: $("hydro-status"),
    logBtn: $("hydro-log"),
    resetBtn: $("hydro-reset"),
    obsSection: $("hydro-obs-section"),
    obsTable: $("hydro-obs-table"),
    window: $("hydro-window"),
    compareSection: $("hydro-compare-section"),
    compareHint: $("hydro-compare-hint"),
    selectA: $("hydro-compare-a"),
    selectB: $("hydro-compare-b"),
    diffToggle: $("hydro-diff-toggle"),
    compareTable: $("hydro-compare-table"),
  };

  buildSkeleton();

  $("hydro-close").addEventListener("click", closeHydrograph);
  $("hydro-fullscreen").addEventListener("click", () => setFullscreen(!isFullscreen()));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isFullscreen()) setFullscreen(false);
  });
  els.resetBtn.addEventListener("click", resetZoom);
  els.logBtn.addEventListener("click", () => {
    view.logY = !view.logY;
    els.logBtn.classList.toggle("active", view.logY);
    scheduleRender();
  });
  els.dock.querySelectorAll(".hydro-var-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (btn.dataset.var === view.variable) return;
      view.variable = btn.dataset.var;
      rebuild();
    }),
  );

  // Picking A/B and swapping them differ only in how the pair is set.
  const applyCompare = () => {
    view.compareTouched = true;
    updateDiff();
    renderCompareControls();
    scheduleRender();
    scheduleMetrics();
  };
  const onPick = () => {
    view.compareA = els.selectA.value || null;
    view.compareB = els.selectB.value || null;
    applyCompare();
  };
  els.selectA.addEventListener("change", onPick);
  els.selectB.addEventListener("change", onPick);
  $("hydro-swap").addEventListener("click", () => {
    [view.compareA, view.compareB] = [view.compareB, view.compareA];
    applyCompare();
  });
  els.diffToggle.addEventListener("change", () => {
    view.showDiff = els.diffToggle.checked;
    updateDiff();
    scheduleRender();
  });

  setupResizeHandle($("hydro-resize"));
  new ResizeObserver(scheduleRender).observe(els.chart);

  // A run loaded or removed while the dock is open: re-chart the same reach.
  onSourcesChange(() => {
    if (view.target) rebuild();
  });
}

function buildSkeleton() {
  const svg = d3.select(els.chart).append("svg").attr("class", "hydro-svg");
  const defs = svg.append("defs");
  const clipMain = defs.append("clipPath").attr("id", "hydro-clip-main").append("rect");
  const clipDiff = defs.append("clipPath").attr("id", "hydro-clip-diff").append("rect");
  const root = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  const main = root.append("g").attr("class", "hydro-plot");
  const mainGrid = main.append("g").attr("class", "hydro-axis hydro-axis-y");
  const mainLabel = main.append("text").attr("class", "hydro-axis-title");
  const mainLines = main.append("g").attr("clip-path", "url(#hydro-clip-main)");
  const mainNow = main.append("line").attr("class", "hydro-now");

  const diff = root.append("g").attr("class", "hydro-plot");
  const diffGrid = diff.append("g").attr("class", "hydro-axis hydro-axis-y");
  const diffLabel = diff.append("text").attr("class", "hydro-axis-title");
  const diffBody = diff.append("g").attr("clip-path", "url(#hydro-clip-diff)");
  const diffPos = diffBody.append("path").attr("fill", DIFF_POS_COLOR).attr("fill-opacity", 0.35);
  const diffNeg = diffBody.append("path").attr("fill", DIFF_NEG_COLOR).attr("fill-opacity", 0.35);
  const diffZero = diffBody.append("line").attr("class", "hydro-zero");
  const diffLine = diffBody.append("path").attr("class", "hydro-diff-line");
  const diffNow = diff.append("line").attr("class", "hydro-now");

  const xAxis = root.append("g").attr("class", "hydro-axis hydro-axis-x");

  const hover = root.append("g").attr("class", "hydro-hover").style("display", "none");
  const crosshair = hover.append("line").attr("class", "hydro-crosshair");
  const dots = hover.append("g");
  const brush = root.append("rect").attr("class", "hydro-brush").style("display", "none");
  const hit = root.append("rect").attr("class", "hydro-hit");

  chart = {
    svg, root, clipMain, clipDiff, main, mainGrid, mainLabel, mainLines, mainNow,
    diff, diffGrid, diffLabel, diffPos, diffNeg, diffZero, diffLine, diffNow,
    xAxis, hover, crosshair, dots, brush, hit,
  };

  hit
    .on("pointerdown", onPointerDown)
    .on("pointermove", onPointerMove)
    .on("pointerup", onPointerUp)
    .on("pointerleave", () => {
      if (!drag) {
        hoverPx = null;
        scheduleHover();
      }
    })
    .on("dblclick", resetZoom);
  svg.node().addEventListener("wheel", onWheel, { passive: false });
}

// ---- Open / close ----------------------------------------------------

// Chart `reachId` from every loaded run; `site` (USGS site number, or null)
// adds the gage's observed discharge and the vs-observed skill table.
export function openHydrograph({ reachId, site = null }) {
  view.target = { reachId, site };
  view.variable = site ? "flow" : state.variable;
  view.hidden.clear();
  view.domain = null;
  view.compareA = view.compareB = null;
  view.compareTouched = false;
  view.showDiff = false;
  els.diffToggle.checked = false;
  hoverPx = null;

  els.title.textContent = site ? `USGS-${site}` : `wb-${reachId}`;
  els.subtitle.textContent = site ? `wb-${reachId}` : "";
  if (site) {
    fetchGageMeta(site)
      .then((meta) => {
        if (view.target?.reachId !== reachId || !meta.name) return;
        els.subtitle.textContent = `${meta.name} · wb-${reachId}`;
      })
      .catch(() => {});
  }

  els.dock.classList.add("visible");
  document.body.classList.add("hydro-open");
  rebuild();
}

export function closeHydrograph() {
  view.target = null;
  requestSeq++;
  setFullscreen(false);
  els.dock.classList.remove("visible");
  document.body.classList.remove("hydro-open");
}

// Fullscreen fills the whole window (over the sidebar and map) so long
// records and the metrics side panel get room; the chart re-fits itself via
// its ResizeObserver.
function isFullscreen() {
  return els.dock.classList.contains("fullscreen");
}

function setFullscreen(on) {
  els.dock.classList.toggle("fullscreen", on);
  const btn = document.getElementById("hydro-fullscreen");
  btn.setAttribute("aria-pressed", String(on));
  btn.title = on ? "Exit fullscreen (Esc)" : "Fullscreen (Esc to exit)";
}

// Current-timestep marker follows the map's time slider (called from ui/time.js).
export function updateHydrographCursor() {
  if (view.target && geom) drawNowMarker();
}

// ---- Series assembly -------------------------------------------------

// What the obs line should say before any fetch resolves. Four independent
// cases, so they read as four returns rather than a nested ternary.
function obsStatusFor(site) {
  if (!site) return "";
  if (view.variable !== "flow") return "USGS observations are discharge only";
  return view.full ? "Fetching USGS observations…" : "";
}

async function rebuild() {
  const seq = ++requestSeq;
  const { reachId, site } = view.target;
  els.dock.querySelectorAll(".hydro-var-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.var === view.variable),
  );

  view.series = modelSeries(reachId, view.variable);
  view.full = extentOf(view.series);
  clampDomain();
  view.obsStatus = obsStatusFor(site);
  refreshAll();

  if (!site || view.variable !== "flow" || !view.full) return;
  let obs;
  try {
    obs = await fetchGageFlow(site, view.full[0], view.full[1]);
  } catch (err) {
    if (seq !== requestSeq) return;
    view.obsStatus = `USGS: ${err.message}`;
    renderStatus();
    return;
  }
  if (seq !== requestSeq) return;
  if (obs.times.length) {
    view.series.unshift({
      key: OBS_KEY,
      label: `USGS-${site} observed`,
      kind: "obs",
      color: OBS_COLOR,
      dashed: false,
      times: obs.times,
      values: obs.values,
      step: medianStep(obs.times),
    });
    view.obsStatus =
      `${obs.times.length.toLocaleString()} observations` +
      (obs.fromCache ? " (cached)" : "");
  } else {
    view.obsStatus = "No USGS observations in this window";
  }
  refreshAll();
}

// One series per loaded run that contains the reach, in epoch ms, with the
// fill value mapped to NaN. Runs whose clock can't be made absolute (a NetCDF
// with an unparseable reference time) can't share an axis and are skipped.
function modelSeries(reachId, variable) {
  const out = [];
  for (const src of listSources()) {
    // seriesAt returns null for a reach the run doesn't have, and for a run
    // with no absolute clock — neither can share this axis.
    const series = seriesAt(src.dataset, reachId, variable);
    if (!series) continue;
    const overflow = src.slot >= SERIES_COLORS.length;
    out.push({
      key: src.key,
      label: src.label,
      kind: "model",
      color: overflow ? SERIES_OVERFLOW_COLOR : SERIES_COLORS[src.slot],
      dashed: overflow,
      times: series.times,
      values: series.values,
      step: medianStep(series.times),
    });
  }
  return out;
}

function extentOf(series) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    if (!s.times.length) continue;
    lo = Math.min(lo, s.times[0]);
    hi = Math.max(hi, s.times[s.times.length - 1]);
  }
  if (!Number.isFinite(lo)) return null;
  // A single timestep still needs a non-zero span to draw an axis.
  return hi > lo ? [lo, hi] : [lo - MIN_SPAN_MS, hi + MIN_SPAN_MS];
}

const byKey = (key) => view.series.find((s) => s.key === key) || null;

function refreshAll() {
  pickCompareDefaults();
  updateDiff();
  renderLegend();
  renderStatus();
  renderCompareControls();
  scheduleRender();
  scheduleMetrics();
}

// Default compare: the first run vs the observations when there are any,
// else the first two runs. Kept once the user picks their own pair.
function pickCompareDefaults() {
  const keys = view.series.map((s) => s.key);
  if (!keys.includes(view.compareA)) view.compareA = null;
  if (!keys.includes(view.compareB)) view.compareB = null;
  if (view.compareTouched && view.compareA && view.compareB) return;
  const models = view.series.filter((s) => s.kind === "model").map((s) => s.key);
  const hasObs = keys.includes(OBS_KEY);
  view.compareA = models[0] ?? null;
  view.compareB = hasObs ? OBS_KEY : (models[1] ?? null);
}

function updateDiff() {
  const a = byKey(view.compareA);
  const b = byKey(view.compareB);
  view.diff = view.showDiff && a && b && a !== b ? differenceSeries(a, b) : null;
}

// ---- Legend, status, compare controls ---------------------------------

function renderLegend() {
  const items = view.series.map((s) => {
    const btn = document.createElement("button");
    btn.className = "hydro-legend-item" + (view.hidden.has(s.key) ? " off" : "");
    btn.title = "Click to toggle · shift-click to isolate";
    const key = document.createElement("span");
    key.className = "hydro-key" + (s.dashed ? " dashed" : "");
    key.style.setProperty("--key-color", s.color);
    const label = document.createElement("span");
    label.className = "hydro-legend-label";
    label.textContent = s.label;
    btn.append(key, label);
    btn.addEventListener("click", (e) => toggleSeries(s.key, e.shiftKey || e.ctrlKey || e.metaKey));
    return btn;
  });
  els.legend.replaceChildren(...items);

  const empty = view.series.length === 0;
  els.empty.style.display = empty ? "" : "none";
  if (empty) {
    els.empty.textContent = view.target
      ? `No loaded run contains wb-${view.target.reachId}`
      : "";
  }
}

// Plain click toggles one line. Isolate shows only this line, or everything
// again if it already was the only one showing.
function toggleSeries(key, isolate) {
  if (isolate) {
    const others = view.series.filter((s) => s.key !== key);
    const alreadyIsolated =
      !view.hidden.has(key) && others.every((s) => view.hidden.has(s.key));
    view.hidden.clear();
    if (!alreadyIsolated) others.forEach((s) => view.hidden.add(s.key));
  } else if (view.hidden.has(key)) {
    view.hidden.delete(key);
  } else {
    view.hidden.add(key);
  }
  renderLegend();
  scheduleRender();
  scheduleMetrics();
}

function renderStatus() {
  els.status.textContent = view.obsStatus;
}

function renderCompareControls() {
  const enough = view.series.length >= 2;
  els.compareHint.style.display = enough ? "none" : "";
  els.compareSection.classList.toggle("disabled", !enough);
  for (const [select, value] of [
    [els.selectA, view.compareA],
    [els.selectB, view.compareB],
  ]) {
    const options = view.series.map((s) => {
      const opt = document.createElement("option");
      opt.value = s.key;
      opt.textContent = s.label;
      return opt;
    });
    select.replaceChildren(...options);
    select.value = value ?? "";
    select.disabled = !enough;
  }
  els.diffToggle.disabled = !enough || view.compareA === view.compareB;
}

// ---- Zoom / pan --------------------------------------------------------

// Keep the zoom window inside the data and no narrower than MIN_SPAN_MS.
function clampDomain(domain = view.domain) {
  if (!view.full) {
    view.domain = null;
    return;
  }
  const [f0, f1] = view.full;
  if (!domain) {
    view.domain = [f0, f1];
    return;
  }
  const span = Math.min(Math.max(domain[1] - domain[0], MIN_SPAN_MS), f1 - f0);
  const d0 = Math.max(f0, Math.min(domain[0], f1 - span));
  view.domain = [d0, d0 + span];
}

function setDomain(domain) {
  clampDomain(domain);
  scheduleRender();
  scheduleMetrics();
}

function resetZoom() {
  if (!view.full) return;
  setDomain(view.full.slice());
}

function onWheel(e) {
  if (!geom) return;
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * scale;
  const dy = e.deltaY * scale;
  const [d0, d1] = view.domain;
  const span = d1 - d0;
  // Trackpad sideways swipe (or shift+wheel) pans; vertical wheel zooms.
  if (Math.abs(dx) > Math.abs(dy) || e.shiftKey) {
    const shift = ((e.shiftKey && !dx ? dy : dx) / geom.innerW) * span;
    setDomain([d0 + shift, d1 + shift]);
    return;
  }
  const [mx] = d3.pointer(e, chart.root.node());
  const t = geom.x.invert(Math.max(0, Math.min(geom.innerW, mx))).getTime();
  const k = Math.exp(dy * 0.002);
  setDomain([t - (t - d0) * k, t + (d1 - t) * k]);
}

function onPointerDown(e) {
  if (e.button !== 0 || !geom) return;
  const [mx] = d3.pointer(e, chart.root.node());
  drag = { mode: e.shiftKey ? "pan" : "brush", x0: mx, x1: mx, domain0: view.domain.slice() };
  e.currentTarget.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!geom) return;
  const [mx] = d3.pointer(e, chart.root.node());
  const cx = Math.max(0, Math.min(geom.innerW, mx));
  if (drag?.mode === "brush") {
    drag.x1 = cx;
    chart.brush
      .style("display", null)
      .attr("x", Math.min(drag.x0, cx))
      .attr("width", Math.abs(cx - drag.x0))
      .attr("y", 0)
      .attr("height", geom.plotH);
  } else if (drag?.mode === "pan") {
    const [d0, d1] = drag.domain0;
    const shift = ((drag.x0 - mx) / geom.innerW) * (d1 - d0);
    setDomain([d0 + shift, d1 + shift]);
  }
  hoverPx = cx;
  scheduleHover();
}

function onPointerUp() {
  if (!drag || !geom) return;
  const d = drag;
  drag = null;
  chart.brush.style("display", "none");
  if (d.mode !== "brush") return;
  if (Math.abs(d.x1 - d.x0) > 4) {
    const a = geom.x.invert(Math.min(d.x0, d.x1)).getTime();
    const b = geom.x.invert(Math.max(d.x0, d.x1)).getTime();
    setDomain([a, b]);
  } else {
    seekMap(geom.x.invert(d.x0).getTime());
  }
}

// Move the map's timestep to the one nearest `ms`.
function seekMap(ms) {
  if (!state.data || !state.data.timeAbsolute) return;
  const { time, nTimes } = state.data;
  let best = -1;
  let bestDt = Infinity;
  for (let i = 0; i < nTimes; i++) {
    const dt = Math.abs(time[i] - ms);
    if (dt < bestDt) {
      bestDt = dt;
      best = i;
    }
  }
  if (best >= 0) setTimeIndex(best);
}

// ---- Dock resize -------------------------------------------------------

function setupResizeHandle(handle) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = els.dock.getBoundingClientRect().height;
    const move = (ev) => {
      const max = window.innerHeight * 0.85;
      const h = Math.max(MIN_DOCK_PX, Math.min(max, startH + startY - ev.clientY));
      document.body.style.setProperty("--hydro-h", `${h}px`);
    };
    // pointercancel fires when capture is lost (a system gesture, a context
    // menu); without it the move/up pair leaked once per interrupted drag.
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// ---- Rendering ---------------------------------------------------------

// The hover readout rebuilds tooltip rows and then measures them, which forces
// a layout flush; at pointer rate that was one flush per move event. One per
// frame is plenty for a crosshair.
let hoverQueued = false;
function scheduleHover() {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => {
    hoverQueued = false;
    drawHover();
  });
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// Index range of `times` covering [d0, d1], widened by one point either side
// so lines run to the plot edge instead of stopping at the last inner point.
function windowRange(times, d0, d1) {
  const i0 = Math.max(0, d3.bisectLeft(times, d0) - 1);
  const i1 = Math.min(times.length, d3.bisectRight(times, d1) + 1);
  return [i0, i1];
}

function yExtent(list, [d0, d1], log) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of list) {
    const i0 = d3.bisectLeft(s.times, d0);
    const i1 = d3.bisectRight(s.times, d1);
    for (let i = i0; i < i1; i++) {
      const v = s.values[i];
      if (Number.isNaN(v) || (log && v <= 0)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return log ? [0.1, 1] : [0, 1];
  if (log) return [lo / 1.2, hi * 1.2];
  const pad = (hi - lo) * 0.06 || Math.abs(hi) * 0.1 || 1;
  // Non-negative data keeps a floor at zero rather than padding below it.
  return [lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad];
}

// Log axes get ticks only at 1/2/5 × 10ⁿ (or just decades when crowded).
function logTicks(y, count) {
  const ticks = y.ticks();
  const mant = (v) => v / 10 ** Math.floor(Math.log10(v) + 1e-9);
  const nice = ticks.filter((v) => [1, 2, 5].some((k) => Math.abs(mant(v) - k) < 1e-6));
  return nice.length > count ? ticks.filter((v) => Math.abs(mant(v) - 1) < 1e-6) : nice;
}

function render() {
  if (!view.target) return;
  const width = els.chart.clientWidth;
  const height = els.chart.clientHeight;
  const visible = view.series.filter((s) => !view.hidden.has(s.key));
  if (!width || !height || !view.full) {
    geom = null;
    chart.svg.style("display", "none");
    return;
  }
  chart.svg.style("display", null).attr("width", width).attr("height", height);

  const innerW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(40, height - MARGIN.top - MARGIN.bottom);
  const diff = view.diff;
  const diffH = diff ? Math.round((plotH - DIFF_GAP) * 0.32) : 0;
  const mainH = diff ? plotH - DIFF_GAP - diffH : plotH;
  const diffTop = mainH + DIFF_GAP;
  const { units, label } = VARIABLES[view.variable];

  const x = d3.scaleUtc().domain(view.domain).range([0, innerW]);
  const log = view.logY;
  const y = (log ? d3.scaleLog() : d3.scaleLinear())
    .domain(yExtent(visible, view.domain, log))
    .range([mainH, 0]);
  if (!log) y.nice();
  geom = { x, y, yDiff: null, innerW, plotH, mainH, diffTop, diffH, visible };

  chart.clipMain.attr("width", innerW).attr("height", mainH);
  chart.hit.attr("width", innerW).attr("height", plotH);

  // Main plot: horizontal gridlines via full-width tick lines.
  const yTickCount = Math.max(2, Math.floor(mainH / 48));
  const yAxis = d3.axisLeft(y).tickSize(-innerW).tickPadding(6).tickFormat(fmtTick);
  if (log) yAxis.tickValues(logTicks(y, yTickCount));
  else yAxis.ticks(yTickCount);
  chart.mainGrid.call(yAxis).call((g) => g.select(".domain").remove());
  chart.mainLabel
    .attr("transform", `translate(${-MARGIN.left + 12},${mainH / 2}) rotate(-90)`)
    .text(`${label} (${units})${log ? " · log" : ""}`);

  const [d0, d1] = view.domain;
  // Models first, observations on top so the reference is never buried.
  const drawOrder = [...visible].sort(
    (a, b) => (a.kind === "obs") - (b.kind === "obs"),
  );
  chart.mainLines
    .selectAll("path")
    .data(drawOrder, (s) => s.key)
    .join("path")
    .attr("class", "hydro-line")
    .attr("stroke", (s) => s.color)
    .attr("stroke-dasharray", (s) => (s.dashed ? "5 3" : null))
    .attr("d", (s) => {
      const [i0, i1] = windowRange(s.times, d0, d1);
      return d3
        .line()
        .defined((i) => !Number.isNaN(s.values[i]) && (!log || s.values[i] > 0))
        .x((i) => x(s.times[i]))
        .y((i) => y(s.values[i]))(indexRange(i0, i1));
    });

  // Diff strip (A − B), sharing the time axis.
  chart.diff.style("display", diff ? null : "none").attr("transform", `translate(0,${diffTop})`);
  if (diff) {
    const [i0, i1] = windowRange(diff.times, d0, d1);
    const idx = indexRange(i0, i1);
    const [lo, hi] = d3.extent(idx, (i) => diff.values[i]);
    const m = Math.max(Math.abs(lo ?? 0), Math.abs(hi ?? 0)) || 1;
    const yDiff = d3.scaleLinear().domain([-m * 1.08, m * 1.08]).range([diffH, 0]).nice();
    geom.yDiff = yDiff;
    chart.clipDiff.attr("width", innerW).attr("height", diffH);
    chart.diffGrid
      .call(d3.axisLeft(yDiff).ticks(Math.max(2, Math.floor(diffH / 30))).tickSize(-innerW).tickPadding(6).tickFormat(fmtTick))
      .call((g) => g.select(".domain").remove());
    const a = byKey(view.compareA);
    const b = byKey(view.compareB);
    chart.diffLabel
      .attr("transform", `translate(${-MARGIN.left + 12},${diffH / 2}) rotate(-90)`)
      .text("A − B") // replaces any previous <title> child
      .append("title")
      .text(`${a?.label} − ${b?.label}`);
    const area = (clampFn) =>
      d3
        .area()
        .x((i) => x(diff.times[i]))
        .y0(yDiff(0))
        .y1((i) => yDiff(clampFn(diff.values[i], 0)))(idx);
    chart.diffPos.attr("d", area(Math.max));
    chart.diffNeg.attr("d", area(Math.min));
    chart.diffZero.attr("x1", 0).attr("x2", innerW).attr("y1", yDiff(0)).attr("y2", yDiff(0));
    chart.diffLine.attr(
      "d",
      d3.line().x((i) => x(diff.times[i])).y((i) => yDiff(diff.values[i]))(idx),
    );
  }

  chart.xAxis
    .attr("transform", `translate(0,${plotH})`)
    .call(
      d3
        .axisBottom(x)
        .ticks(Math.max(2, Math.floor(innerW / 110)))
        .tickFormat(fmtTimeTick)
        .tickSizeOuter(0),
    );

  els.resetBtn.disabled = d0 <= view.full[0] && d1 >= view.full[1];
  drawNowMarker();
  drawHover();
}

function drawNowMarker() {
  const t = state.data?.timeAbsolute
    ? state.data.time[state.timeIndex]
    : undefined;
  const px = t === undefined ? null : geom.x(t);
  const show = px !== null && px >= 0 && px <= geom.innerW;
  chart.mainNow
    .style("display", show ? null : "none")
    .attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", geom.mainH)
    .attr("stroke", CURRENT_TIME_COLOR);
  chart.diffNow
    .style("display", show && view.diff ? null : "none")
    .attr("x1", px).attr("x2", px).attr("y1", 0).attr("y2", geom.diffH)
    .attr("stroke", CURRENT_TIME_COLOR);
}

// Index of the point in `times` nearest to `t`.
function nearestIndex(times, t) {
  const i = d3.bisectLeft(times, t);
  if (i <= 0) return 0;
  if (i >= times.length) return times.length - 1;
  return t - times[i - 1] <= times[i] - t ? i - 1 : i;
}

// Crosshair snapped to the nearest data time over the visible lines; each
// line reports its own nearest point if it has one within half a step.
// One grow-only index buffer shared by every line/area generator. Zoomed out
// over a full 15-minute observation record, d3.range(i0, i1) was allocating
// ~35k numbers per series per frame on a wheel/drag path.
let indexBuf = [];
function indexRange(i0, i1) {
  const n = Math.max(0, i1 - i0);
  if (indexBuf.length < n) indexBuf = new Array(n);
  else if (indexBuf.length > n) indexBuf.length = n;
  for (let k = 0; k < n; k++) indexBuf[k] = i0 + k;
  return indexBuf;
}

function hideHover() {
  chart.hover.style("display", "none");
  els.tooltip.classList.remove("visible");
}

function drawHover() {
  if (hoverPx == null || !geom || drag?.mode === "pan") return hideHover();
  const { x, y, visible } = geom;
  const t = x.invert(hoverPx).getTime();
  let snap = null;
  let snapDt = Infinity;
  const candidates = view.diff ? [...visible, view.diff] : visible;
  for (const s of candidates) {
    if (!s.times.length) continue;
    const i = nearestIndex(s.times, t);
    const dt = Math.abs(s.times[i] - t);
    if (dt < snapDt) {
      snapDt = dt;
      snap = s.times[i];
    }
  }
  if (snap === null) return hideHover();

  const valueAtSnap = (s, step) => {
    const i = nearestIndex(s.times, snap);
    const within = Math.abs(s.times[i] - snap) <= step / 2 + 1;
    return within ? { t: s.times[i], v: s.values[i] } : null;
  };
  const rows = visible.map((s) => ({ s, p: valueAtSnap(s, s.step) }));
  const diffPoint = view.diff ? valueAtSnap(view.diff, medianStep(view.diff.times)) : null;

  const sx = x(snap);
  chart.hover.style("display", null);
  chart.crosshair.attr("x1", sx).attr("x2", sx).attr("y1", 0).attr("y2", geom.plotH);
  const dots = rows
    .filter(({ p }) => p && Number.isFinite(p.v) && (!view.logY || p.v > 0))
    .map(({ s, p }) => ({ key: s.key, color: s.color, cx: x(p.t), cy: y(p.v) }));
  if (diffPoint && Number.isFinite(diffPoint.v) && geom.yDiff) {
    dots.push({
      key: "diff",
      color: DIFF_LINE_COLOR,
      cx: x(diffPoint.t),
      cy: geom.diffTop + geom.yDiff(diffPoint.v),
    });
  }
  chart.dots
    .selectAll("circle")
    .data(dots, (d) => d.key)
    .join("circle")
    .attr("class", "hydro-dot")
    .attr("r", 4)
    .attr("fill", (d) => d.color)
    .attr("cx", (d) => d.cx)
    .attr("cy", (d) => d.cy);

  renderTooltip(snap, rows, diffPoint, sx);
}

function renderTooltip(snap, rows, diffPoint, sx) {
  const { units } = VARIABLES[view.variable];
  const head = document.createElement("div");
  head.className = "hydro-tt-time";
  head.textContent = fmtTime(new Date(snap));
  const lines = rows.map(({ s, p }) => tooltipRow(s.color, p ? p.v : NaN, s.label, s.dashed));
  if (diffPoint) lines.push(tooltipRow(null, diffPoint.v, "A − B", false, true));
  const unitsEl = document.createElement("div");
  unitsEl.className = "hydro-tt-units";
  unitsEl.textContent = units;
  els.tooltip.replaceChildren(head, ...lines, unitsEl);
  els.tooltip.classList.add("visible");

  // Hang the tooltip right of the crosshair, flipping left near the edge.
  const box = els.chart.getBoundingClientRect();
  const tw = els.tooltip.offsetWidth;
  let left = MARGIN.left + sx + 14;
  if (left + tw > box.width - 4) left = MARGIN.left + sx - 14 - tw;
  els.tooltip.style.left = `${els.chart.offsetLeft + Math.max(4, left)}px`;
  els.tooltip.style.top = `${els.chart.offsetTop + MARGIN.top + 6}px`;
}

function tooltipRow(color, value, label, dashed, isDiff = false) {
  const row = document.createElement("div");
  row.className = "hydro-tt-row";
  const key = document.createElement("span");
  key.className = "hydro-key" + (dashed ? " dashed" : "") + (isDiff ? " diff" : "");
  if (color) key.style.setProperty("--key-color", color);
  const val = document.createElement("span");
  val.className = "hydro-tt-value";
  val.textContent = fmtValue(value);
  const name = document.createElement("span");
  name.className = "hydro-tt-label";
  name.textContent = label;
  row.append(key, val, name);
  return row;
}

// ---- Metrics -----------------------------------------------------------

function scheduleMetrics() {
  clearTimeout(metricsTimer);
  metricsTimer = setTimeout(renderMetrics, METRICS_DEBOUNCE_MS);
}

const METRIC_COLUMNS = [
  ["kge", "KGE", "Kling-Gupta efficiency (1 is perfect)", fmtScore],
  ["nse", "NSE", "Nash-Sutcliffe efficiency (1 is perfect)", fmtScore],
  ["r", "r", "Pearson correlation", fmtScore],
  ["pbias", "PBIAS", "Percent bias: + over-predicts, − under-predicts", (v) => (Number.isFinite(v) ? `${fmtScore(v, 1)}%` : "–")],
  ["rmse", "RMSE", "Root-mean-square error", fmtValue],
  ["n", "n", "Paired points in the visible window", (v) => v.toLocaleString()],
];
// The compare table shows everything the per-run table does, plus MAE. Spelled
// out rather than assembled by index surgery on METRIC_COLUMNS, which broke
// silently if anyone reordered that list.
const COMPARE_METRICS = [
  ["kge", "KGE", "Kling-Gupta efficiency (1 is perfect)", fmtScore],
  ["nse", "NSE", "Nash-Sutcliffe efficiency (1 is perfect)", fmtScore],
  ["r", "r", "Pearson correlation", fmtScore],
  ["pbias", "PBIAS", "Percent bias: + over-predicts, − under-predicts", (v) => (Number.isFinite(v) ? `${fmtScore(v, 1)}%` : "–")],
  ["rmse", "RMSE", "Root-mean-square error", fmtValue],
  ["mae", "MAE", "Mean absolute error", fmtValue],
  ["n", "n", "Paired points in the visible window", (v) => v.toLocaleString()],
];

function renderMetrics() {
  if (!view.target || !view.domain) return;
  const [d0, d1] = view.domain;
  els.window.textContent = `${fmtShortTime(new Date(d0))} → ${fmtShortTime(new Date(d1))} UTC`;

  const obs = byKey(OBS_KEY);
  els.obsSection.style.display = obs ? "" : "none";
  if (obs) {
    const rows = view.series
      .filter((s) => s.kind === "model")
      .map((s) => {
        const p = alignSeries(s, obs, d0, d1);
        return { s, m: computeMetrics(p.sim, p.ref) };
      });
    els.obsTable.replaceChildren(metricsHead(), ...rows.map(metricsRow));
  }

  const a = byKey(view.compareA);
  const b = byKey(view.compareB);
  if (a && b && a !== b) {
    const p = alignSeries(a, b, d0, d1);
    const m = computeMetrics(p.sim, p.ref);
    els.compareTable.replaceChildren(
      ...COMPARE_METRICS.map(([k, name, desc, fmt]) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.textContent = name;
        th.title = desc;
        const td = document.createElement("td");
        td.textContent = m ? fmt(m[k]) : "–";
        tr.append(th, td);
        return tr;
      }),
    );
  } else {
    els.compareTable.replaceChildren();
  }
}

function metricsHead() {
  const tr = document.createElement("tr");
  const first = document.createElement("th");
  first.textContent = "Run";
  tr.append(first);
  for (const [, name, desc] of METRIC_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = name;
    th.title = desc;
    tr.append(th);
  }
  return tr;
}

function metricsRow({ s, m }) {
  const tr = document.createElement("tr");
  if (view.hidden.has(s.key)) tr.className = "off";
  const name = document.createElement("td");
  name.className = "hydro-metric-name";
  const key = document.createElement("span");
  key.className = "hydro-key" + (s.dashed ? " dashed" : "");
  key.style.setProperty("--key-color", s.color);
  const label = document.createElement("span");
  label.textContent = s.label;
  name.title = s.label;
  name.append(key, label);
  tr.append(name);
  for (const [k, , , fmt] of METRIC_COLUMNS) {
    const td = document.createElement("td");
    td.textContent = m ? fmt(m[k]) : "–";
    tr.append(td);
  }
  return tr;
}

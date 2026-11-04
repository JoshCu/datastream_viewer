// ====================================================================
// The timeline dock along the bottom of the map: transport, a row per layer
// with its clip, a time ruler and the playhead. The model is ui/timeline.js.
//
// Scroll zooms around the cursor, shift-scroll / sideways scroll / shift-drag /
// middle-drag pan, drag seeks, double-click frames a clip or, off a clip, everything.
// The clips, ruler and playhead are one canvas; the rows' labels are DOM.
// ====================================================================
import { CURRENT_TIME_COLOR } from "../config.js";
import { state } from "../state.js";
import { isPanelLayerShowing, onPanelLayersSync, togglePanelLayer } from "./panellayers.js";
import {
  axisIsAbsolute,
  canStepTimeline,
  formatAxisTime,
  isHeld,
  nearestStep,
  onTimelineChange,
  pickTrackStep,
  playheadTime,
  seekTimeline,
  stepTimeline,
  timelineDomain,
  timelineTracks,
} from "./timeline.js";
import { togglePlay } from "./playback.js";

const RULER_H = 22;
const ROW_H = 22;
const CLIP_PAD = 3; // px between a clip and its row's edges
const MIN_CLIP_PX = 3; // a clip this short still shows at any zoom
const MIN_STEP_PX = 6; // draw a clip's step marks only when they're this far apart
const MIN_TICK_PX = 76; // ruler labels
const MIN_SPAN_MS = 30 * 60 * 1000;
const SINGLE_STEP_SPAN_MS = 2 * 3600 * 1000; // framing a layer with one step
const FIT_PADDING = 0.02;
const DRAG_PX = 3;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIXED_TICKS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY];
const MONTH_TICKS = [1, 3, 6, 12, 24, 60, 120];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const $ = (id) => document.getElementById(id);
const els = {};

let view = null; // [start, end] of the axis on screen, ms
let fitted = true; // following the whole domain, not zoomed
let width = 0;
let hoverX = null;
let hoverY = null;
let drawQueued = false;

// ---- Coordinates -----------------------------------------------------

const xOf = (ms) => ((ms - view[0]) / (view[1] - view[0])) * width;
const msAt = (x) => view[0] + (x / width) * (view[1] - view[0]);

function trackAt(y) {
  const row = Math.floor((y - RULER_H) / ROW_H);
  return row >= 0 ? (timelineTracks()[row] ?? null) : null;
}

function localPoint(e) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ---- The view --------------------------------------------------------

function paddedSpan([first, last]) {
  const span = last - first;
  const pad = span > 0 ? span * FIT_PADDING : SINGLE_STEP_SPAN_MS / 2;
  return [first - pad, last + pad];
}

function setView(start, end) {
  const [lo, hi] = paddedSpan(timelineDomain());
  let span = Math.max(Math.min(MIN_SPAN_MS, hi - lo), Math.min(end - start, hi - lo));
  if (span <= 0) span = hi - lo;
  let from = start + (end - start - span) / 2;
  from = Math.max(lo, Math.min(hi - span, from));
  view = [from, from + span];
  fitted = span >= (hi - lo) * 0.999;
  scheduleDraw();
}

function fitAll() {
  fitted = true;
  view = paddedSpan(timelineDomain());
  scheduleDraw();
}

// Zoom keeping the time under `x` where it is.
function zoomAt(x, factor) {
  const at = msAt(x);
  const [lo, hi] = paddedSpan(timelineDomain());
  const span = Math.max(Math.min(MIN_SPAN_MS, hi - lo), Math.min(hi - lo, (view[1] - view[0]) * factor));
  const start = at - (x / width) * span;
  setView(start, start + span);
}

function panBy(px) {
  const dt = (px / width) * (view[1] - view[0]);
  setView(view[0] + dt, view[1] + dt);
}

// Playback, or a seek from elsewhere, left the view: page it along.
function keepPlayheadInView() {
  const t = playheadTime();
  if (t === null || !view || (t >= view[0] && t <= view[1])) return;
  const span = view[1] - view[0];
  const start = t > view[1] ? t - span * 0.1 : t - span * 0.9;
  setView(start, start + span);
}

// ---- Ruler -----------------------------------------------------------

// The finest tick spacing whose labels have room: { ms } or { months }.
function chooseTick(span) {
  const perPx = span / width;
  for (const ms of FIXED_TICKS) if (ms / perPx >= MIN_TICK_PX) return { ms };
  for (const months of MONTH_TICKS) if ((months * 30.4 * DAY) / perPx >= MIN_TICK_PX) return { months };
  return { months: 240 };
}

function tickTimes(tick) {
  const out = [];
  if (tick.ms) {
    for (let t = Math.ceil(view[0] / tick.ms) * tick.ms; t <= view[1]; t += tick.ms) out.push(t);
    return out;
  }
  const d = new Date(view[0]);
  let m = d.getUTCFullYear() * 12 + d.getUTCMonth();
  m = Math.floor(m / tick.months) * tick.months;
  for (;;) {
    const t = Date.UTC(Math.floor(m / 12), m % 12, 1);
    if (t > view[1]) return out;
    if (t >= view[0]) out.push(t);
    m += tick.months;
  }
}

function tickLabel(t, tick) {
  if (!axisIsAbsolute()) return `T+${Math.round(t / HOUR)}h`;
  const d = new Date(t);
  const hhmm = d.toISOString().slice(11, 16);
  const monthDay = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (tick.months) return tick.months >= 12 ? String(d.getUTCFullYear()) : `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (tick.ms >= DAY) return monthDay;
  return t % DAY === 0 ? monthDay : hhmm;
}

// The part of the date the tick labels leave out, pinned at the ruler's left.
function rulerContext(tick) {
  if (!axisIsAbsolute() || (tick.months && tick.months >= 1)) return "";
  const iso = new Date(view[0]).toISOString();
  return tick.ms < DAY ? iso.slice(0, 10) : iso.slice(0, 4);
}

function drawRuler(ctx, height, colors) {
  const tick = chooseTick(view[1] - view[0]);
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textBaseline = "middle";
  const context = rulerContext(tick);
  const reserved = context ? ctx.measureText(context).width + 12 : 0;

  ctx.lineWidth = 1;
  for (const t of tickTimes(tick)) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 5);
    ctx.lineTo(x, height);
    ctx.stroke();
    if (x + 3 < reserved) continue;
    ctx.fillStyle = colors.muted;
    ctx.fillText(tickLabel(t, tick), x + 3, RULER_H / 2 - 1);
  }
  if (context) {
    ctx.fillStyle = colors.secondary;
    ctx.fillText(context, 4, RULER_H / 2 - 1);
  }
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(width, RULER_H - 0.5);
  ctx.stroke();
}

// ---- Clips -----------------------------------------------------------

function roundedClip(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(3, w / 2));
}

// The first index at or left of the view's start, and the last at or right of
// its end, so lines leave the edge of the canvas rather than stopping short.
function visibleRange(axis) {
  const n = axis.length;
  const from = Math.max(0, nearestStep(axis, view[0]) - 1);
  const to = Math.min(n - 1, nearestStep(axis, view[1]) + 1);
  return [from, to];
}

function drawWave(ctx, { axis }, { values, min, max }, top, bottom) {
  const [from, to] = visibleRange(axis);
  const stride = Math.max(1, Math.floor((to - from) / width));
  const range = max - min || 1;
  const y = (v) => bottom - ((v - min) / range) * (bottom - top);
  ctx.beginPath();
  for (let i = from; i <= to; i += stride) {
    const px = xOf(axis[i]);
    if (i === from) ctx.moveTo(px, y(values[i]));
    else ctx.lineTo(px, y(values[i]));
  }
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Whether a layer's steps are far enough apart on screen to draw one by one.
function stepsAreApart(axis, from, to) {
  return to > from && xOf(axis[to]) - xOf(axis[from]) >= (to - from) * MIN_STEP_PX;
}

function drawStepMarks(ctx, axis, top, bottom) {
  const [from, to] = visibleRange(axis);
  if (!stepsAreApart(axis, from, to)) return;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = from; i <= to; i++) {
    const x = Math.round(xOf(axis[i])) + 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  ctx.stroke();
}

function drawClip(ctx, track, top, colors) {
  const { axis, color } = track;
  const y0 = top + CLIP_PAD;
  const h = ROW_H - 2 * CLIP_PAD;
  const x0 = xOf(axis[0]);
  const w = Math.max(MIN_CLIP_PX, xOf(axis[axis.length - 1]) - x0);
  const showing = !track.panel || isPanelLayerShowing(track.panel);

  ctx.save();
  roundedClip(ctx, x0, y0, w, h);
  ctx.globalAlpha = showing ? 0.3 : 0.08;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = showing ? 1 : 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.35;
  drawStepMarks(ctx, axis, y0, y0 + h);
  const wave = showing ? track.wave?.() : null;
  if (wave) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.primary;
    drawWave(ctx, track, wave, y0 + 2, y0 + h - 2);
  }
  ctx.restore();

  // The step this layer has on show.
  const i = track.index();
  if (i >= 0 && i < axis.length) {
    ctx.fillStyle = color;
    ctx.globalAlpha = showing ? 1 : 0.5;
    ctx.fillRect(Math.round(xOf(axis[i])) - 1, y0 - 1, 3, h + 2);
    ctx.globalAlpha = 1;
  }
}

// A layer that ignores the playhead: one tick per available step, so what can
// be picked is visible, and a clip only joining them would claim more.
function drawTicks(ctx, track, top) {
  const { axis, color } = track;
  const y0 = top + CLIP_PAD;
  const h = ROW_H - 2 * CLIP_PAD;
  const [from, to] = visibleRange(axis);
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.6;
  drawStepMarks(ctx, axis, y0 + 3, y0 + h - 3);
  if (!stepsAreApart(axis, from, to)) {
    // Too dense for separate ticks: a band.
    const x0 = xOf(axis[from]);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(x0, y0 + 3, Math.max(MIN_CLIP_PX, xOf(axis[to]) - x0), h - 6);
  }
  ctx.globalAlpha = 1;
  const i = track.index();
  if (i >= 0 && i < axis.length) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(xOf(axis[i])) - 1, y0 - 1, 3, h + 2);
  }
}

// ---- Drawing ---------------------------------------------------------

function cssColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  return {
    primary: get("--text-primary"),
    secondary: get("--text-secondary"),
    muted: get("--text-muted"),
    border: get("--border-color"),
    grid: "rgba(255, 255, 255, 0.05)",
  };
}

function draw() {
  const list = timelineTracks();
  const canvas = els.canvas;
  width = canvas.clientWidth;
  if (!view || !width) return;
  const height = RULER_H + list.length * ROW_H;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const colors = cssColors();

  drawRuler(ctx, height, colors);
  list.forEach((track, row) => {
    const top = RULER_H + row * ROW_H;
    if (track.seek) drawClip(ctx, track, top, colors);
    else drawTicks(ctx, track, top);
  });

  if (hoverX !== null) {
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(hoverX) + 0.5, 0);
    ctx.lineTo(Math.round(hoverX) + 0.5, height);
    ctx.stroke();
  }

  const t = playheadTime();
  if (t !== null) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = CURRENT_TIME_COLOR;
    ctx.fillStyle = CURRENT_TIME_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 7);
    ctx.closePath();
    ctx.fill();
  }

  syncScrollbar();
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function syncScrollbar() {
  els.scroll.classList.toggle("zoomed", !fitted);
  if (fitted) return;
  const [lo, hi] = paddedSpan(timelineDomain());
  els.thumb.style.left = `${((view[0] - lo) / (hi - lo)) * 100}%`;
  els.thumb.style.width = `${((view[1] - view[0]) / (hi - lo)) * 100}%`;
}

// ---- Rows ------------------------------------------------------------

const EYE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

let rowEls = []; // parallel to timelineTracks()
let rowsKey = "";

function buildRows() {
  const list = timelineTracks();
  const key = list.map((tr) => `${tr.key}|${tr.label}|${tr.panel ?? ""}`).join(",");
  if (key === rowsKey) return;
  rowsKey = key;
  rowEls = list.map((track) => {
    const root = document.createElement("div");
    root.className = "tl-row";
    root.style.height = `${ROW_H}px`;
    const swatch = document.createElement("span");
    swatch.className = "tl-swatch";
    swatch.style.background = track.color;
    const name = document.createElement("span");
    name.className = "tl-name";
    name.textContent = track.label;
    const held = document.createElement("span");
    held.className = "tl-held";
    held.textContent = "held";
    root.append(swatch, name, held);
    let eye = null;
    if (track.panel) {
      eye = document.createElement("button");
      eye.type = "button";
      eye.className = "tl-eye";
      eye.innerHTML = EYE_ICON;
      eye.addEventListener("click", () => togglePanelLayer(track.panel));
      root.append(eye);
    }
    return { root, name, held, eye, panel: track.panel };
  });
  els.rows.replaceChildren(...rowEls.map((r) => r.root));
}

function syncRows() {
  timelineTracks().forEach((track, i) => {
    const row = rowEls[i];
    if (!row) return;
    const held = isHeld(track);
    row.root.classList.toggle("is-held", held);
    row.root.title = held
      ? `The playhead is outside ${track.label}: the map holds its nearest step`
      : (track.detail ?? track.label);
    if (row.eye) {
      const on = isPanelLayerShowing(track.panel);
      row.eye.classList.toggle("off", !on);
      row.eye.title = on ? `Hide ${track.label}` : `Show ${track.label}`;
    }
  });
}

function syncReadout() {
  const t = playheadTime();
  els.now.textContent = t === null ? "–" : formatAxisTime(t);
}

function syncTransport() {
  const can = canStepTimeline();
  for (const el of [els.play, els.back, els.fwd]) el.disabled = !can;
  const none = "Radar scans download one at a time: click a scan on its row to load it";
  els.play.title = !can ? none : state.isPlaying ? "Pause" : "Play";
}

// ---- Hover tip -------------------------------------------------------

function showTip(x, y) {
  const track = trackAt(y);
  let text = formatAxisTime(msAt(x));
  if (track) {
    const { axis } = track;
    const n = axis.length;
    const range = n > 1 ? `${formatAxisTime(axis[0])} → ${formatAxisTime(axis[n - 1])}` : formatAxisTime(axis[0]);
    const steps = `${n.toLocaleString()} ${track.seek ? "step" : "scan"}${n === 1 ? "" : "s"}`;
    text = `${text}\n${track.detail ?? track.label}\n${range} · ${steps}`;
    if (track.pick) text += "\nClick to load the nearest scan";
  }
  els.tip.textContent = text;
  els.tip.classList.add("visible");
  const room = width - els.tip.offsetWidth - 4;
  els.tip.style.left = `${Math.max(4, Math.min(room, x + 10))}px`;
}

function hideTip() {
  els.tip.classList.remove("visible");
}

// ---- Pointer ---------------------------------------------------------

function onPointerDown(e) {
  if (!view) return;
  e.preventDefault();
  const { x, y } = localPoint(e);
  const panning = e.button === 1 || e.shiftKey;
  if (!panning && e.button !== 0) return;
  els.canvas.setPointerCapture(e.pointerId);
  const pickable = !panning ? trackAt(y)?.pick && trackAt(y) : null;
  let lastX = x;
  let dragged = false;

  if (!panning && !pickable) seekTimeline(msAt(x));

  const move = (ev) => {
    const p = localPoint(ev);
    if (Math.abs(p.x - x) >= DRAG_PX) dragged = true;
    if (panning) panBy(lastX - p.x);
    else if (dragged || !pickable) seekTimeline(msAt(Math.max(0, Math.min(width, p.x))));
    lastX = p.x;
  };
  const up = (ev) => {
    els.canvas.removeEventListener("pointermove", move);
    els.canvas.removeEventListener("pointerup", up);
    els.canvas.removeEventListener("pointercancel", up);
    if (ev.type === "pointerup" && pickable && !dragged) {
      pickTrackStep(pickable, nearestStep(pickable.axis, msAt(x)));
    }
  };
  els.canvas.addEventListener("pointermove", move);
  els.canvas.addEventListener("pointerup", up);
  els.canvas.addEventListener("pointercancel", up);
}

function onWheel(e) {
  if (!view) return;
  e.preventDefault();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? width : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) panBy(Math.abs(dx) > Math.abs(dy) ? dx : dy);
  else zoomAt(localPoint(e).x, Math.exp(dy * 0.0015));
}

function onDoubleClick(e) {
  const { x, y } = localPoint(e);
  const track = trackAt(y);
  const axis = track?.axis;
  if (axis && x >= xOf(axis[0]) - MIN_CLIP_PX && x <= xOf(axis[axis.length - 1]) + MIN_CLIP_PX) {
    const [from, to] = paddedSpan([axis[0], axis[axis.length - 1]]);
    setView(from, to);
  } else {
    fitAll();
  }
}

function setupScrollbar() {
  els.thumb.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.thumb.setPointerCapture(e.pointerId);
    let last = e.clientX;
    const move = (ev) => {
      const [lo, hi] = paddedSpan(timelineDomain());
      const dt = ((ev.clientX - last) / els.scroll.clientWidth) * (hi - lo);
      last = ev.clientX;
      setView(view[0] + dt, view[1] + dt);
    };
    const up = () => {
      els.thumb.removeEventListener("pointermove", move);
      els.thumb.removeEventListener("pointerup", up);
      els.thumb.removeEventListener("pointercancel", up);
    };
    els.thumb.addEventListener("pointermove", move);
    els.thumb.addEventListener("pointerup", up);
    els.thumb.addEventListener("pointercancel", up);
  });
  // Click the trough: centre the view there.
  els.scroll.addEventListener("pointerdown", (e) => {
    const rect = els.scroll.getBoundingClientRect();
    const [lo, hi] = paddedSpan(timelineDomain());
    const at = lo + ((e.clientX - rect.left) / rect.width) * (hi - lo);
    const span = view[1] - view[0];
    setView(at - span / 2, at + span / 2);
  });
}

// ---- Setup -----------------------------------------------------------

function syncDockHeight() {
  const h = els.dock.classList.contains("visible") ? els.dock.offsetHeight + 8 : 0;
  document.documentElement.style.setProperty("--tl-h", `${h}px`);
}

function onChange(kind) {
  if (kind === "tracks") {
    const domain = timelineDomain();
    els.dock.classList.toggle("visible", !!domain);
    if (domain) {
      buildRows();
      els.canvas.style.height = `${RULER_H + timelineTracks().length * ROW_H}px`;
      width = els.canvas.clientWidth || width;
      if (!view || fitted) view = paddedSpan(domain);
      else setView(view[0], view[1]); // back inside a domain that shrank
    } else {
      view = null;
      fitted = true;
      rowsKey = "";
    }
    syncTransport();
    syncDockHeight();
  }
  if (!view) return;
  keepPlayheadInView();
  syncRows();
  syncReadout();
  scheduleDraw();
}

export function setupTimeline() {
  Object.assign(els, {
    dock: $("timeline"),
    play: $("tlPlay"),
    back: $("tlBack"),
    fwd: $("tlFwd"),
    now: $("tlNow"),
    speed: $("tlSpeed"),
    fit: $("tlFit"),
    collapse: $("tlCollapse"),
    rows: $("tlRows"),
    canvas: $("tlCanvas"),
    tip: $("tlTip"),
    scroll: $("tlScroll"),
    thumb: $("tlThumb"),
  });

  els.play.addEventListener("click", togglePlay);
  els.back.addEventListener("click", () => stepTimeline(-1));
  els.fwd.addEventListener("click", () => stepTimeline(1));
  els.speed.value = String(state.playSpeed);
  // The playback loop reads playSpeed each frame, so a change applies at once.
  els.speed.addEventListener("change", () => {
    state.playSpeed = Number(els.speed.value);
  });
  els.fit.addEventListener("click", () => view && fitAll());
  els.collapse.addEventListener("click", () => {
    const collapsed = els.dock.classList.toggle("collapsed");
    els.collapse.setAttribute("aria-pressed", String(collapsed));
    els.collapse.title = collapsed ? "Show the tracks" : "Hide the tracks";
    syncDockHeight();
    scheduleDraw();
  });

  els.canvas.addEventListener("pointerdown", onPointerDown);
  els.canvas.addEventListener("wheel", onWheel, { passive: false });
  els.canvas.addEventListener("dblclick", onDoubleClick);
  els.canvas.addEventListener("pointermove", (e) => {
    if (!view) return;
    ({ x: hoverX, y: hoverY } = localPoint(e));
    showTip(hoverX, hoverY);
    scheduleDraw();
  });
  els.canvas.addEventListener("pointerleave", () => {
    hoverX = hoverY = null;
    hideTip();
    scheduleDraw();
  });
  setupScrollbar();

  onTimelineChange(onChange);
  onPanelLayersSync(() => {
    if (!view) return;
    syncRows();
    scheduleDraw();
  });

  const observer = new ResizeObserver(() => {
    syncDockHeight();
    scheduleDraw();
  });
  observer.observe(els.dock);
  observer.observe(els.canvas);
}

// A loaded run's clip changed without its clock moving (another variable).
export const redrawTimeline = scheduleDraw;

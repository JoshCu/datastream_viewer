// ====================================================================
// Results overview sparkline (basin total per timestep) + click-to-seek
// ====================================================================
import { state } from "../state.js";
import { isValid, CURRENT_TIME_COLOR } from "../config.js";
import { derived } from "../data/access.js";
import { setTimeIndex } from "./time.js";

function resultTotals(dataset, variable) {
  const cache = derived(dataset, variable);
  if (cache.totals) return cache.totals;
  const { matrices, featureIds, nTimes } = dataset;
  const m = matrices[variable];
  const totals = new Float64Array(nTimes);
  for (let f = 0; f < featureIds.length; f++) {
    const base = f * nTimes;
    for (let t = 0; t < nTimes; t++) {
      const v = m[base + t];
      if (isValid(v)) totals[t] += v;
    }
  }
  cache.totals = totals;
  return totals;
}

// The sparkline itself only changes when the dataset, variable or canvas size
// does — but the marker moves on every seek. So the curve is rendered once to
// an offscreen canvas and blitted, and a seek costs a drawImage plus one line
// instead of a full rescan and re-stroke.
let sprite = null; // { canvas, key, w, h, dpr, totals, min, range }

function accentColor() {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-primary")
      .trim() || "#00d4ff"
  );
}

const PAD = 3;

function buildSprite(canvas) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const totals = resultTotals(state.data, state.variable);
  const key = `${state.variable}:${state.data.nTimes}:${w}x${h}@${dpr}`;
  if (sprite && sprite.key === key && sprite.dataset === state.data) return sprite;

  let min = Infinity;
  let max = -Infinity;
  for (const v of totals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;

  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.round(w * dpr));
  off.height = Math.max(1, Math.round(h * dpr));
  const ctx = off.getContext("2d");
  ctx.scale(dpr, dpr);

  const x = (t) =>
    totals.length > 1 ? PAD + (t / (totals.length - 1)) * (w - 2 * PAD) : w / 2;
  const y = (v) => h - PAD - ((v - min) / range) * (h - 2 * PAD);

  const accent = accentColor();
  ctx.beginPath();
  ctx.moveTo(x(0), y(totals[0]));
  for (let t = 1; t < totals.length; t++) ctx.lineTo(x(t), y(totals[t]));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.lineTo(x(totals.length - 1), h - PAD);
  ctx.lineTo(x(0), h - PAD);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.globalAlpha = 1;

  sprite = { canvas: off, key, dataset: state.data, w, h, dpr, totals, min, range };
  return sprite;
}

// Called when the loaded run changes, so the cached curve isn't reused for it.
export function invalidateOverview() {
  sprite = null;
}

export function drawResultsOverview() {
  const canvas = document.getElementById("results-overview");
  if (!state.data || canvas.clientWidth === 0) return;

  const s = buildSprite(canvas);
  const { w, h, dpr, totals } = s;
  if (canvas.width !== s.canvas.width || canvas.height !== s.canvas.height) {
    canvas.width = s.canvas.width;
    canvas.height = s.canvas.height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(s.canvas, 0, 0);
  ctx.scale(dpr, dpr);

  const markerX =
    totals.length > 1
      ? PAD + (state.timeIndex / (totals.length - 1)) * (w - 2 * PAD)
      : w / 2;
  ctx.strokeStyle = CURRENT_TIME_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(markerX, PAD);
  ctx.lineTo(markerX, h - PAD);
  ctx.stroke();
}

// Dragging the time slider fires `input` at pointer rate; coalescing to one
// draw per frame matches what scheduleFeatureStateUpdate() already does for the
// map, so a drag does one repaint per frame rather than one per event.
let drawQueued = false;
export function scheduleOverviewDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    drawResultsOverview();
  });
}

export function seekFromOverview(e) {
  if (!state.data) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  setTimeIndex(Math.round(fraction * (state.data.nTimes - 1)));
}

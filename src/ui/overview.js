// ====================================================================
// Results overview sparkline (basin total per timestep) + click-to-seek
// ====================================================================
import { state } from "../state.js";
import { scheduleFeatureStateUpdate } from "../map/paint.js";
import { refreshTooltip } from "../map/interactions.js";
import { updateTimeDisplay } from "./time.js";

function resultTotals() {
  const cached = state.data.totals[state.variable];
  if (cached) return cached;
  const { matrices, featureIds, nTimes } = state.data;
  const m = matrices[state.variable];
  const totals = new Float64Array(nTimes);
  for (let f = 0; f < featureIds.length; f++) {
    const base = f * nTimes;
    for (let t = 0; t < nTimes; t++) {
      const v = m[base + t];
      if (v > -9998) totals[t] += v;
    }
  }
  state.data.totals[state.variable] = totals;
  return totals;
}

export function drawResultsOverview() {
  const canvas = document.getElementById("results-overview");
  if (!state.data || canvas.clientWidth === 0) return;

  const totals = resultTotals();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  let min = Infinity;
  let max = -Infinity;
  for (const v of totals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;

  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-primary")
      .trim() || "#00d4ff";
  const pad = 3;
  const x = (t) =>
    totals.length > 1 ? pad + (t / (totals.length - 1)) * (w - 2 * pad) : w / 2;
  const y = (v) => h - pad - ((v - min) / range) * (h - 2 * pad);

  ctx.beginPath();
  ctx.moveTo(x(0), y(totals[0]));
  for (let t = 1; t < totals.length; t++) ctx.lineTo(x(t), y(totals[t]));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.lineTo(x(totals.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.globalAlpha = 1;

  const markerX = x(state.timeIndex);
  ctx.strokeStyle = "#ffba08";
  ctx.beginPath();
  ctx.moveTo(markerX, pad);
  ctx.lineTo(markerX, h - pad);
  ctx.stroke();
}

export function seekFromOverview(e) {
  if (!state.data) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  state.timeIndex = Math.max(
    0,
    Math.min(
      state.data.nTimes - 1,
      Math.round(fraction * (state.data.nTimes - 1)),
    ),
  );
  document.getElementById("timeSlider").value = state.timeIndex;
  scheduleFeatureStateUpdate();
  updateTimeDisplay();
  refreshTooltip();
}

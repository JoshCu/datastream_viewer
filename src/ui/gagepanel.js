// ====================================================================
// Gage click panel: fetches USGS observed discharge for the loaded run's
// time window and draws a mini hydrograph of observed vs. modelled flow on
// the gage's reach. Deliberately minimal — a stepping stone toward a full
// hydrograph viewer that can overlay several loaded runs.
// ====================================================================
import { state } from "../state.js";
import { valueAt, timeToMillis, dataTimeRangeMs } from "../data/access.js";
import { fetchGageFlow } from "../data/usgs.js";

// Bumped per click so a slow response for an earlier gage can't paint over
// the panel for the one clicked most recently.
let requestSeq = 0;

export async function showGageInfo(feature) {
  const site = String(feature.properties.hl_uri || "").replace(/^gages-/, "");
  const reachId = feature.properties.id;
  const row = state.data.index.get(reachId);
  const seq = ++requestSeq;

  document.getElementById("info-id").textContent = `USGS-${site}`;
  const content = document.getElementById("info-content");
  content.innerHTML = `
    <div class="info-row">
      <span class="info-label">Reach</span>
      <span class="info-value">wb-${reachId}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Observed</span>
      <span class="info-value" id="gage-status">Fetching…</span>
    </div>
    <div class="info-row" id="gage-stats" style="display:none">
      <span class="info-label">Obs range</span>
      <span class="info-value" id="gage-range"></span>
    </div>
    <div class="mini-chart hydrograph">
      <canvas id="gage-chart-canvas"></canvas>
      <div class="hydrograph-legend">
        <span class="hydrograph-key obs">observed</span>
        <span class="hydrograph-key model">modelled</span>
      </div>
    </div>`;
  document.getElementById("info-panel").classList.add("visible");
  state.selectedFeature = { id: reachId, row };

  const range = dataTimeRangeMs();
  const status = document.getElementById("gage-status");
  if (!range) {
    status.textContent = "No absolute time for this run";
    return;
  }

  let series;
  try {
    series = await fetchGageFlow(site, range.start, range.end);
  } catch (err) {
    if (seq !== requestSeq) return;
    status.textContent = `Error: ${err.message}`;
    console.error("USGS fetch error:", err);
    return;
  }
  if (seq !== requestSeq) return;

  status.textContent =
    `${series.times.length} points` + (series.fromCache ? " (cached)" : "");
  if (series.times.length) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of series.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    document.getElementById("gage-stats").style.display = "";
    document.getElementById("gage-range").textContent =
      `${min.toFixed(2)} – ${max.toFixed(2)} m³/s`;
  }
  drawHydrograph(series, row, range);
}

// Observed (cyan) and modelled flow (orange) on a shared absolute-time x axis
// spanning the loaded run, plus the current-timestep marker. Modelled flow
// is skipped for diff datasets, whose "flow" is a difference, not a flow.
function drawHydrograph(series, row, range) {
  const canvas = document.getElementById("gage-chart-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const model = [];
  if (row !== undefined && !state.data.isDiff) {
    for (let t = 0; t < state.data.nTimes; t++) {
      const v = valueAt("flow", row, t);
      const ms = timeToMillis(state.data.time[t]);
      if (v > -9998 && ms !== undefined) model.push([ms, v]);
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of series.values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  for (const [, v] of model) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return;
  const span = max - min || 1;
  const tSpan = range.end - range.start || 1;

  const w = rect.width;
  const h = rect.height;
  const pad = 8;
  const x = (ms) => pad + ((ms - range.start) / tSpan) * (w - 2 * pad);
  const y = (v) => h - pad - ((v - min) / span) * (h - 2 * pad);

  const trace = (pts, color) => {
    if (!pts.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach(([ms, v], i) => (i ? ctx.lineTo(x(ms), y(v)) : ctx.moveTo(x(ms), y(v))));
    ctx.stroke();
  };

  trace(model, "rgba(255, 107, 53, 0.9)");
  const obs = [];
  for (let i = 0; i < series.times.length; i++) obs.push([series.times[i], series.values[i]]);
  trace(obs, "rgba(0, 212, 255, 0.9)");

  const nowMs = timeToMillis(state.data.time[state.timeIndex]);
  if (nowMs !== undefined) {
    ctx.strokeStyle = "rgba(255, 186, 8, 0.8)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(nowMs), pad);
    ctx.lineTo(x(nowMs), h - pad);
    ctx.stroke();
  }
}

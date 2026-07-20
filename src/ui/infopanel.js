// ====================================================================
// Click info panel + per-reach mini time-series chart
// ====================================================================
import { state } from "../state.js";
import { VARIABLES } from "../config.js";
import { valueAt } from "../data/access.js";

export function showFeatureInfo(feature) {
  const id = feature.id;
  const row = state.data.index.get(id);
  document.getElementById("info-id").textContent = `wb-${id}`;

  let html = "";
  const { label, units } = VARIABLES[state.variable];
  const value =
    row === undefined
      ? undefined
      : valueAt(state.variable, row, state.timeIndex);
  html += `<div class="info-row">
                        <span class="info-label">${label}</span>
                        <span class="info-value">${value !== undefined && value > -9998 ? value.toFixed(4) + " " + units : "--"}</span>
                    </div>`;

  for (const [key, val] of Object.entries(feature.properties || {})) {
    if (["id"].includes(key)) continue;
    html += `<div class="info-row">
                        <span class="info-label">${key}</span>
                        <span class="info-value">${val}</span>
                    </div>`;
  }

  html +=
    '<div class="mini-chart"><canvas id="mini-chart-canvas"></canvas></div>';

  document.getElementById("info-content").innerHTML = html;
  document.getElementById("info-panel").classList.add("visible");

  if (row !== undefined) setTimeout(() => drawMiniChart(row), 0);
  state.selectedFeature = { id, row };
}

function drawMiniChart(row) {
  const canvas = document.getElementById("mini-chart-canvas");
  if (!canvas || row === undefined) return;

  const ctx = canvas.getContext("2d");
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * 2;
  canvas.height = rect.height * 2;
  ctx.scale(2, 2);

  const nTimes = state.data.nTimes;
  const values = [];
  for (let t = 0; t < nTimes; t++) values.push(valueAt(state.variable, row, t));

  const valid = values.filter((v) => v > -9998);
  if (valid.length === 0) return;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;

  const w = rect.width;
  const h = rect.height;
  const padding = 8;

  ctx.strokeStyle = "rgba(0, 212, 255, 0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v <= -9998) {
      started = false;
      return;
    }
    const x = padding + (i / (values.length - 1)) * (w - 2 * padding);
    const y = h - padding - ((v - min) / range) * (h - 2 * padding);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  const currentX =
    padding + (state.timeIndex / (values.length - 1)) * (w - 2 * padding);
  ctx.strokeStyle = "rgba(255, 186, 8, 0.8)";
  ctx.beginPath();
  ctx.moveTo(currentX, padding);
  ctx.lineTo(currentX, h - padding);
  ctx.stroke();
}

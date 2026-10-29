// ====================================================================
// A routed flow field (flowroute.js) packed for the particles
// (flow/particles.js). Pure, so the flow worker runs it when a field is
// built and the main thread reruns it only when the speed model or the
// colour-by changes.
//
// Speed is √(slope), times upstream area^FLOW_MANNING_EXP in Manning mode,
// scaled so the 90th percentile of the land cells (sampled) is 1, and
// clamped. Colour is a LUT index: upstream area (log) or speed.
// ====================================================================
import { FLOW_MANNING_EXP } from "../../config.js";

export const FLOW_LUT_SIZE = 256;
// Normalised speed range (1 = the field's 90th percentile).
const MIN_SPEED = 0.04;
const MAX_SPEED = 3;
const SAMPLE_CELLS = 20000; // cells sampled for the speed normalisation

// `f`: { w, h, dir, elev, sqrtSlope, acc, outlet }. Returns
//   cells   Float32Array(4wh)  per cell [dirX, dirY, ±speed, elev]: one
//           record, so a bilinear sample is two cache lines rather than one
//           per array per row. Speed is negated at outlets (it's ≥
//           MIN_SPEED, so the sign is free); elevation is 0 for no data.
//   colour  Uint8Array(wh)     LUT index
export function packFlowCells(f, speedModel, colorBy) {
  const { dir, elev, sqrtSlope, acc, outlet } = f;
  const n = f.w * f.h;
  const manning = speedModel === "manning";
  const speed = new Float32Array(n);
  for (let i = 0; i < n; i++) speed[i] = manning ? sqrtSlope[i] * acc[i] ** FLOW_MANNING_EXP : sqrtSlope[i];
  const every = Math.max(1, Math.floor(n / SAMPLE_CELLS));
  const vals = [];
  for (let i = 0; i < n; i += every) if (!outlet[i]) vals.push(speed[i]);
  vals.sort((a, b) => a - b);
  const norm = (vals.length && vals[Math.floor(vals.length * 0.9)]) || 1;

  const cells = new Float32Array(4 * n);
  for (let i = 0; i < n; i++) {
    const s = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed[i] / norm));
    speed[i] = s;
    const k = 4 * i;
    const e = elev[i];
    cells[k] = dir[2 * i];
    cells[k + 1] = dir[2 * i + 1];
    cells[k + 2] = outlet[i] ? -s : s;
    cells[k + 3] = e === e ? e : 0;
  }

  const colour = new Uint8Array(n);
  const top = FLOW_LUT_SIZE - 1;
  if (colorBy === "speed") {
    for (let i = 0; i < n; i++) colour[i] = Math.min(top, Math.round((speed[i] / 2) * top));
  } else {
    let maxAcc = 2;
    for (let i = 0; i < n; i++) if (acc[i] > maxAcc) maxAcc = acc[i];
    const k = top / Math.log(maxAcc);
    for (let i = 0; i < n; i++) colour[i] = Math.round(Math.log(acc[i]) * k);
  }
  return { cells, colour };
}

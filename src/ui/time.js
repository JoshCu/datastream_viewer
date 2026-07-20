// ====================================================================
// Time readout for the current timestep
// ====================================================================
import { state } from "../state.js";
import { drawResultsOverview } from "./overview.js";

function formatTime(t) {
  if (state.data.isParquet) {
    const d = new Date(t);
    return (
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
      `${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00Z`
    );
  }
  return `T+${Math.floor(t / 3600)}h`;
}

export function updateTimeDisplay() {
  if (!state.data) return;
  const t = state.data.time[state.timeIndex];
  if (t !== undefined) {
    document.getElementById("currentTime").textContent = formatTime(t);
  }
  drawResultsOverview();
}

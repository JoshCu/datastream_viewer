// ====================================================================
// The current timestep: the one place that changes it, and its readout.
// ====================================================================
import { state } from "../state.js";
import { scheduleFeatureStateUpdate } from "../map/paint.js";
import { scheduleOverviewDraw } from "./overview.js";
import { updateHydrographCursor } from "./hydrograph.js";

// Every seek goes through here — the slider, the transport buttons, the
// overview sparkline and the hydrograph. Before this existed each caller
// repeated the same repaint sequence by hand, and the hydrograph reached it by
// dispatching a synthetic "input" event at the slider.
//
// The tooltip is deliberately *not* refreshed here: updateFeatureStates() ends
// with refreshTooltip(), so doing it again would run it twice per step.
export function setTimeIndex(i) {
  if (!state.data) return;
  const clamped = Math.max(0, Math.min(state.data.nTimes - 1, i));
  if (clamped === state.timeIndex) return;
  state.timeIndex = clamped;
  document.getElementById("timeSlider").value = clamped;
  scheduleFeatureStateUpdate();
  updateTimeDisplay();
}

// Step `delta` timesteps, wrapping at either end (playback transport).
export function stepTime(delta) {
  if (!state.data) return;
  const n = state.data.nTimes;
  setTimeIndex((state.timeIndex + (delta % n) + n) % n);
}

// `time` is epoch ms for any run with an absolute clock (parsers normalize it);
// a run whose reference time was unparseable still carries raw seconds, and
// shows elapsed time instead.
function formatTime(t) {
  if (!state.data.timeAbsolute) return `T+${Math.floor(t / 3600)}h`;
  const d = new Date(t);
  return (
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00Z`
  );
}

// Reaction to the active run changing: the slider spans the new run's steps.
// Registered in map/init.js.
export function syncTimeToDataset({ data }) {
  if (!data) return;
  const slider = document.getElementById("timeSlider");
  slider.max = Math.max(0, data.nTimes - 1);
  slider.value = 0;
  updateTimeDisplay();
}

export function updateTimeDisplay() {
  if (!state.data) return;
  const t = state.data.time[state.timeIndex];
  if (t !== undefined) {
    document.getElementById("currentTime").textContent = formatTime(t);
  }
  scheduleOverviewDraw();
  updateHydrographCursor();
}

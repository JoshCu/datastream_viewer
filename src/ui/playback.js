// ====================================================================
// Timestep playback controls
// ====================================================================
import { state } from "../state.js";
import { scheduleFeatureStateUpdate } from "../map/paint.js";
import { refreshTooltip } from "../map/interactions.js";
import { updateTimeDisplay } from "./time.js";

const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <rect x="6" y="4" width="4" height="16"/>
                            <rect x="14" y="4" width="4" height="16"/>
                        </svg>`;

export function startPlayback() {
  state.isPlaying = true;
  const btn = document.getElementById("playBtn");
  btn.classList.add("active");
  btn.innerHTML = PAUSE_ICON;
  state.playInterval = setInterval(stepForward, 2500 / state.playSpeed);
}

export function stopPlayback() {
  state.isPlaying = false;
  const btn = document.getElementById("playBtn");
  btn.classList.remove("active");
  btn.innerHTML = PLAY_ICON;
  clearInterval(state.playInterval);
}

export function togglePlay() {
  if (!state.data) return;
  if (state.isPlaying) stopPlayback();
  else startPlayback();
}

export function stepForward() {
  if (!state.data) return;
  const steps = state.data.nTimes;
  state.timeIndex = (state.timeIndex + 1) % steps;
  document.getElementById("timeSlider").value = state.timeIndex;
  scheduleFeatureStateUpdate();
  updateTimeDisplay();
  refreshTooltip();
}

export function stepBackward() {
  if (!state.data) return;
  const steps = state.data.nTimes;
  state.timeIndex = (state.timeIndex - 1 + steps) % steps;
  document.getElementById("timeSlider").value = state.timeIndex;
  scheduleFeatureStateUpdate();
  updateTimeDisplay();
  refreshTooltip();
}

// ====================================================================
// Timestep playback controls
// ====================================================================
import { state } from "../state.js";
import { stepTime } from "./time.js";

const PLAY_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                            <rect x="6" y="4" width="4" height="16"/>
                            <rect x="14" y="4" width="4" height="16"/>
                        </svg>`;

// Playback runs off requestAnimationFrame against a wall clock rather than a
// setInterval. A timer fires regardless of what the map is doing, so it used to
// compete with tile queries during a pan — which is why the map had to pause
// and resume it around every camera gesture. rAF simply doesn't fire while the
// tab is busy or hidden, so frames are dropped instead, and the speed stays
// honest because the interval is measured against the clock, not counted.
let rafId = null;
let lastStepAt = 0;

function tick(now) {
  if (!state.isPlaying) return;
  if (now - lastStepAt >= 2500 / state.playSpeed) {
    lastStepAt = now;
    stepTime(1);
  }
  rafId = requestAnimationFrame(tick);
}

export function startPlayback() {
  if (state.isPlaying) return;
  state.isPlaying = true;
  const btn = document.getElementById("playBtn");
  btn.classList.add("active");
  btn.innerHTML = PAUSE_ICON;
  lastStepAt = performance.now();
  rafId = requestAnimationFrame(tick);
}

export function stopPlayback() {
  state.isPlaying = false;
  const btn = document.getElementById("playBtn");
  btn.classList.remove("active");
  btn.innerHTML = PLAY_ICON;
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

export function togglePlay() {
  if (!state.data) return;
  if (state.isPlaying) stopPlayback();
  else startPlayback();
}

export function stepForward() {
  stepTime(1);
}

export function stepBackward() {
  stepTime(-1);
}

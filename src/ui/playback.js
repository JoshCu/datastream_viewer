// ====================================================================
// The timeline's transport: play/pause. A step is the next step of any layer
// (ui/timeline.js), and state.playSpeed is steps per second.
// ====================================================================
import { state } from "../state.js";
import { canStepTimeline, onTimelineChange, stepTimeline } from "./timeline.js";

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
  if (now - lastStepAt >= 1000 / state.playSpeed) {
    lastStepAt = now;
    stepTimeline(1);
  }
  rafId = requestAnimationFrame(tick);
}

function syncButton() {
  const btn = document.getElementById("tlPlay");
  btn.classList.toggle("active", state.isPlaying);
  btn.innerHTML = state.isPlaying ? PAUSE_ICON : PLAY_ICON;
  btn.title = state.isPlaying ? "Pause" : "Play";
}

export function startPlayback() {
  if (state.isPlaying || !canStepTimeline()) return;
  state.isPlaying = true;
  syncButton();
  lastStepAt = performance.now();
  rafId = requestAnimationFrame(tick);
}

export function stopPlayback() {
  state.isPlaying = false;
  syncButton();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

export function togglePlay() {
  if (state.isPlaying) stopPlayback();
  else startPlayback();
}

// The last layer that could play was cleared.
onTimelineChange((kind) => {
  if (kind === "tracks" && state.isPlaying && !canStepTimeline()) stopPlayback();
});

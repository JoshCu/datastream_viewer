// ====================================================================
// The timeline's model: every layer with a clock, on one shared time axis,
// and the one playhead that drives them. ui/timelinedock.js draws it.
//
// A mode registers a function returning its tracks (nothing, while it has
// nothing loaded) and calls syncTimeline() when they change, as a panel does
// with registerPanelLayer. A track is:
//
//   key, label     identity, and the short name in its row
//   detail         longer description, for the hover tip (optional)
//   color          config.TIMELINE_COLORS entry
//   times          ascending; epoch ms, or seconds with `relative: true` (a
//                  run with no reference time)
//   index()        the step on show (-1: none)
//   seek(i)        seeks the layer. A track with this follows the playhead.
//   pick(i)        a track without seek: steps cost a download (NEXRAD), so it
//                  ignores the playhead and only moves when one is clicked
//   panel          its registerPanelLayer id, for the eye button (optional)
//   wave()         { values, min, max } to draw in the clip (optional)
//
// Each layer keeps its own clock (setTimeIndex and friends stay the only way
// to seek those). A seek from anywhere else, the hydrograph say, reaches here
// through trackMoved(), so the playhead and the other layers come along.
//
// A layer the playhead has left stays on its nearest step: the row says so
// (isHeld), but the layer stays on the map, so its toggle has one meaning.
// Imports nothing.
// ====================================================================

const providers = [];
const listeners = new Set();

let tracks = []; // the descriptors above plus `axis`: Float64Array of ms
let signatures = new Set();
let domain = null; // [first, last] over every track, ms
let absolute = true;
let playhead = null;
let seeking = false; // the playhead is moving the layers: ignore their echoes

export const timelineTracks = () => tracks;
export const timelineDomain = () => domain;
export const playheadTime = () => playhead;
const followers = () => tracks.filter((tr) => tr.seek);
export const canStepTimeline = () => tracks.some((tr) => tr.seek);

export function registerTimelineTracks(provider) {
  providers.push(provider);
}

// fn(kind): "tracks" when the set of tracks or their contents changed, "time"
// when only the playhead moved.
export function onTimelineChange(fn) {
  listeners.add(fn);
}

function emit(kind) {
  for (const fn of listeners) fn(kind);
}

// ---- Steps -----------------------------------------------------------

// The first index whose time is >= ms (axis.length if none).
function lowerBound(axis, ms) {
  let lo = 0;
  let hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function nearestStep(axis, ms) {
  const hi = lowerBound(axis, ms);
  if (hi === 0) return 0;
  if (hi === axis.length) return axis.length - 1;
  return ms - axis[hi - 1] <= axis[hi] - ms ? hi - 1 : hi;
}

// Half a typical step past either end still counts as inside the layer.
function covers({ axis }, ms) {
  const n = axis.length;
  const pad = n > 1 ? (axis[n - 1] - axis[0]) / (n - 1) / 2 : 0;
  return ms >= axis[0] - pad && ms <= axis[n - 1] + pad;
}

// The playhead is outside this layer, which is holding its nearest step.
export const isHeld = (track) => !!track.seek && playhead !== null && !covers(track, playhead);

// ---- Rebuilding the tracks -------------------------------------------

function buildTracks() {
  const raw = providers.flatMap((p) => p()).filter((tr) => tr.times?.length);
  const dated = raw.filter((tr) => !tr.relative);
  absolute = dated.length > 0 || raw.length === 0;
  // An undated run has no place on a dated axis: it starts where they do.
  const anchor = dated.length ? Math.min(...dated.map((tr) => tr.times[0])) : null;
  return raw.map((tr) => {
    const { times } = tr;
    const axis = !tr.relative
      ? Float64Array.from(times)
      : Float64Array.from(times, (v) => (anchor === null ? v * 1000 : anchor + (v - times[0]) * 1000));
    return { ...tr, axis };
  });
}

const signature = ({ key, axis }) => `${key}:${axis.length}:${axis[0]}:${axis[axis.length - 1]}`;

// A mode's tracks changed. A newly loaded layer the playhead isn't over pulls
// the playhead to its start: you loaded it to look at it.
export function syncTimeline() {
  tracks = buildTracks();
  const previous = signatures;
  signatures = new Set(tracks.map(signature));
  if (!tracks.length) {
    domain = null;
    playhead = null;
    emit("tracks");
    return;
  }
  domain = [
    Math.min(...tracks.map((tr) => tr.axis[0])),
    Math.max(...tracks.map((tr) => tr.axis[tr.axis.length - 1])),
  ];
  const fresh = followers().find((tr) => !previous.has(signature(tr)));
  if (playhead === null) {
    const first = fresh ?? tracks[0];
    playhead = first.axis[Math.max(0, first.index())];
  } else if (fresh && !covers(fresh, playhead)) {
    playhead = fresh.axis[0];
  }
  playhead = Math.max(domain[0], Math.min(domain[1], playhead));
  moveLayers();
  emit("tracks");
}

// ---- Seeking ---------------------------------------------------------

function moveLayers(except = null) {
  seeking = true;
  try {
    for (const tr of followers()) {
      if (tr !== except) tr.seek(nearestStep(tr.axis, playhead));
    }
  } finally {
    seeking = false;
  }
}

function setPlayhead(ms, except = null) {
  playhead = ms;
  moveLayers(except);
  emit("time");
}

// Seek to the step of any following layer nearest `ms`.
export function seekTimeline(ms) {
  if (!domain) return;
  let best = Math.max(domain[0], Math.min(domain[1], ms));
  let bestDt = Infinity;
  for (const { axis } of followers()) {
    const at = axis[nearestStep(axis, ms)];
    const dt = Math.abs(at - ms);
    if (dt < bestDt) {
      bestDt = dt;
      best = at;
    }
  }
  setPlayhead(best);
}

// Click a step of a track that doesn't follow: load it, and go there.
export function pickTrackStep(track, i) {
  track.pick(i);
  setPlayhead(track.axis[i]);
}

// Move to the next step of any following layer, wrapping at the ends. Going by
// steps, not by time, means a gap between two layers takes no time to play and
// the finest layer sets the pace.
export function stepTimeline(direction) {
  const list = followers();
  if (!list.length) return;
  let next = null;
  for (const { axis } of list) {
    const lo = lowerBound(axis, playhead);
    const at = direction > 0 ? axis[axis[lo] === playhead ? lo + 1 : lo] : axis[lo - 1];
    if (at === undefined) continue;
    if (next === null || (direction > 0 ? at < next : at > next)) next = at;
  }
  if (next === null) {
    next =
      direction > 0
        ? Math.min(...list.map((tr) => tr.axis[0]))
        : Math.max(...list.map((tr) => tr.axis[tr.axis.length - 1]));
  }
  setPlayhead(next);
}

// A layer's own clock was moved from outside the timeline.
export function trackMoved(key, i) {
  if (seeking) return;
  const track = tracks.find((tr) => tr.key === key);
  if (track && track.axis[i] !== undefined) setPlayhead(track.axis[i], track);
}

// ---- Labels ----------------------------------------------------------

export const axisIsAbsolute = () => absolute;

export function formatAxisTime(ms) {
  if (!absolute) return `T+${Math.floor(ms / 3600000)}h`;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

// ====================================================================
// The live-routing "paintbrush": a circular cursor over the map that holds
// lateral inflow on every reach it covers while the mouse button (or a
// finger) is down.
//
// Owns the cursor overlay, the diameter / qlat sliders, the hovered-reach
// readout and deposits; the water itself lives in sim/network.js. Holding
// the button keeps qlat at the slider value on the reaches under the brush;
// releasing lets it decay (SIM_QLAT_DECAY per routing step).
//
// Input goes through pointer events on the canvas container so mouse, pen and
// touch share one path. One finger paints; a second finger hands the gesture
// back to MapLibre's pinch zoom.
// ====================================================================
import { state, map } from "../state.js";
import { depositQlat, reachState, onSimUpdate } from "./network.js";

let diameterPx = 60;
let qlat = 1;
let painting = false;
let paintPointer = null; // pointerId of the pointer doing the painting
let paintRaf = null;
let cursor = null; // last map-relative pointer point (maplibregl.Point)
const touches = new Set(); // pointerIds of fingers currently down
let cursorIsTouch = false; // a touch cursor only shows the ring while held
let hitCache = null; // { x, y, ids } for the last picked point

// The qlat slider is logarithmic: 0..300 -> 0.1..100 m³/s.
const qlatFromSlider = (v) => 10 ** (v / 100 - 1);

// Reaches whose rendered line passes within the brush radius of `point`.
// The bbox query is coarse (any feature whose rendered box overlaps), so each
// candidate is checked against its projected segments.
function reachesUnderBrush(point) {
  if (hitCache && hitCache.x === point.x && hitCache.y === point.y) return hitCache.ids;
  const r = diameterPx / 2;
  const features = map.queryRenderedFeatures(
    [
      [point.x - r, point.y - r],
      [point.x + r, point.y + r],
    ],
    { layers: ["flowpaths"] },
  );
  const ids = new Set();
  for (const f of features) {
    if (ids.has(f.id)) continue;
    if (lineWithin(f.geometry, point, r)) ids.add(f.id);
  }
  hitCache = { x: point.x, y: point.y, ids };
  return ids;
}

function lineWithin(geometry, p, r) {
  const lines =
    geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
  const r2 = r * r;
  for (const line of lines) {
    let a = map.project(line[0]);
    if (dist2(p, a) <= r2) return true;
    for (let k = 1; k < line.length; k++) {
      const b = map.project(line[k]);
      if (segmentDist2(p, a, b) <= r2) return true;
      a = b;
    }
  }
  return false;
}

const dist2 = (p, a) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2;

function segmentDist2(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return dist2(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// While the button is held, deposit every frame (the cursor may sit still
// while the map zooms under it, and qlat decays each step otherwise).
function paintFrame() {
  if (!painting || !cursor) return;
  depositQlat(reachesUnderBrush(cursor), qlat);
  paintRaf = requestAnimationFrame(paintFrame);
}

function stopPainting() {
  painting = false;
  paintPointer = null;
  if (paintRaf !== null) cancelAnimationFrame(paintRaf);
  paintRaf = null;
}

// ---- Cursor overlay ---------------------------------------------------

function brushEl() {
  return document.getElementById("simBrush");
}

function positionBrush() {
  const el = brushEl();
  if (!cursor || !state.brushActive || (cursorIsTouch && !touches.size)) {
    el.classList.remove("visible");
    return;
  }
  el.style.width = el.style.height = `${diameterPx}px`;
  el.style.transform = `translate(${cursor.x - diameterPx / 2}px, ${cursor.y - diameterPx / 2}px)`;
  el.classList.add("visible");
  el.classList.toggle("painting", painting);
}

export function setBrushActive(on) {
  on = on && state.simActive;
  state.brushActive = on;
  stopPainting();
  // Left-drag / one-finger drag deposits water while the brush is on; wheel
  // and pinch zoom still work, and right-drag still rotates. Double-tap zoom
  // is off so quick dabs don't zoom the map.
  if (on) {
    map.dragPan.disable();
    map.doubleClickZoom.disable();
  } else {
    map.dragPan.enable();
    map.doubleClickZoom.enable();
  }
  map.getContainer().classList.toggle("sim-brush-on", on);
  for (const id of ["simBrushBtn", "simMapBrushBtn"]) {
    document.getElementById(id).classList.toggle("active", on);
  }
  positionBrush();
}

// ---- Hovered reach readout --------------------------------------------

function updateReadout(point) {
  const el = document.getElementById("simHover");
  if (!state.simActive || !point) {
    el.textContent = "Hover a reach to see its flow.";
    return;
  }
  const f = map.queryRenderedFeatures(point, { layers: ["flowpaths-hover"] })[0];
  const s = f && reachState(f.id);
  if (!s) {
    el.textContent = f ? `wb-${f.id}: not routed yet` : "Hover a reach to see its flow.";
    return;
  }
  el.textContent =
    `wb-${f.id}: ${s.q.toFixed(3)} m³/s · ${s.depth.toFixed(2)} m · ` +
    `${s.velocity.toFixed(2)} m/s` +
    (s.qlat > 1e-3 ? ` · qlat ${s.qlat.toFixed(2)}` : "");
}

// ---- Wiring --------------------------------------------------------------

export function setupBrush() {
  const diameter = document.getElementById("simDiameter");
  const diameterValue = document.getElementById("simDiameterValue");
  const applyDiameter = () => {
    diameterPx = parseInt(diameter.value, 10);
    diameterValue.textContent = `${diameterPx}px`;
    hitCache = null;
    positionBrush();
  };
  diameter.addEventListener("input", applyDiameter);
  applyDiameter();

  const qlatSlider = document.getElementById("simQlat");
  const qlatValue = document.getElementById("simQlatValue");
  const applyQlat = () => {
    qlat = qlatFromSlider(parseInt(qlatSlider.value, 10));
    qlatValue.textContent = qlat < 1 ? qlat.toFixed(2) : qlat.toFixed(1);
  };
  qlatSlider.addEventListener("input", applyQlat);
  applyQlat();

  for (const id of ["simBrushBtn", "simMapBrushBtn"]) {
    document
      .getElementById(id)
      .addEventListener("click", () => setBrushActive(!state.brushActive));
  }

  const container = map.getCanvasContainer();
  const pointOf = (e) => {
    const r = container.getBoundingClientRect();
    return new maplibregl.Point(e.clientX - r.left, e.clientY - r.top);
  };

  container.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && !touches.has(e.pointerId)) return;
    // Only the painting finger steers the brush during a touch.
    if (painting && e.pointerId !== paintPointer) return;
    cursor = pointOf(e);
    cursorIsTouch = e.pointerType === "touch";
    if (state.brushActive) positionBrush();
    if (state.simActive) updateReadout(cursor);
  });
  container.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      touches.add(e.pointerId);
      // Second finger: this is a pinch, not a stroke.
      if (touches.size > 1) {
        stopPainting();
        positionBrush();
        return;
      }
    }
    // A tap is the only "hover" a touch screen has, so it moves the readout.
    cursor = pointOf(e);
    cursorIsTouch = e.pointerType === "touch";
    if (state.simActive) updateReadout(cursor);
    if (!state.brushActive || e.button !== 0) return;
    painting = true;
    paintPointer = e.pointerId;
    positionBrush();
    paintFrame();
  });
  // Released anywhere, including off the map; cancel covers the browser
  // taking over a touch (e.g. the page scrolling).
  const release = (e) => {
    touches.delete(e.pointerId);
    if (painting && e.pointerId === paintPointer) stopPainting();
    // The ring hides once the last finger lifts (positionBrush), but the
    // cursor stays so the readout keeps showing the reach last touched.
    positionBrush();
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  container.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    cursor = null;
    stopPainting();
    positionBrush();
  });
  onSimUpdate(() => {
    if (!state.simActive && state.brushActive) setBrushActive(false);
    updateReadout(cursor);
  });
  // The camera moving under a still cursor changes what's beneath it.
  map.on("move", () => {
    hitCache = null;
  });
}

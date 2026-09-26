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
import { setBrushSphere } from "./sphere.js";

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

// The brush is a disk lying on the ground, so it tilts and turns with the
// camera. Its radius is set where the pointer is: diameterPx wide along the
// screen's horizontal there, which a pitched view doesn't foreshorten.
//
// With 3D terrain on it becomes a sphere centred where the pointer meets the
// terrain, drawn in 3D by sim/sphere.js so the ground swallows whatever part
// of it is buried, and it takes reaches by true 3D distance. Its radius comes
// from the zoom alone (diameterPx at the map's scale), so it's a fixed world
// size that shrinks into the distance through the camera like anything else.
//
// { center, radius, sphere }: center in MercatorCoordinate units, radius in
// the same units, and sphere { z, mpu } when terrain is on: the centre's
// elevation (m) and mercator units per metre. Null when the pointer is off
// the ground (e.g. in the sky of a pitched view).
const OUTLINE_POINTS = 48;
let footprintCache = null; // { x, y, fp } for the last computed point

function footprint(point) {
  if (footprintCache && footprintCache.x === point.x && footprintCache.y === point.y) {
    return footprintCache.fp;
  }
  const lngLat = map.unproject(point);
  const center = maplibregl.MercatorCoordinate.fromLngLat(lngLat);
  const z = map.getTerrain() ? map.queryTerrainElevation(lngLat) : null;
  let radius;
  if (z === null) {
    const edge = maplibregl.MercatorCoordinate.fromLngLat(
      map.unproject([point.x + diameterPx / 2, point.y]),
    );
    radius = Math.hypot(edge.x - center.x, edge.y - center.y);
  } else {
    // MapLibre's world is 512 · 2^zoom px wide in mercator's unit square.
    radius = diameterPx / 2 / (512 * 2 ** map.getZoom());
  }
  let fp = null;
  if (Number.isFinite(radius) && radius > 0) {
    const sphere = z === null ? null : { z, mpu: center.meterInMercatorCoordinateUnits() };
    fp = { center, radius, sphere };
  }
  footprintCache = { x: point.x, y: point.y, fp };
  return fp;
}

// The disk's rim projected to screen points: drawn for the disk, and it
// bounds the rendered-feature query for both forms (a sphere's shadow on the
// ground is its disk). Computed on first use and kept on the footprint.
function outlineOf(fp) {
  if (fp.outline) return fp.outline;
  const { center, radius } = fp;
  fp.outline = [];
  for (let k = 0; k < OUTLINE_POINTS; k++) {
    const t = (2 * Math.PI * k) / OUTLINE_POINTS;
    const rim = new maplibregl.MercatorCoordinate(
      center.x + radius * Math.cos(t),
      center.y + radius * Math.sin(t),
    );
    fp.outline.push(map.project(rim.toLngLat()));
  }
  return fp.outline;
}

// Reaches whose line passes within the brush disk. The bbox query is coarse
// (any feature whose rendered box overlaps the disk's screen outline), so
// each candidate is checked against its segments on the ground.
function reachesUnderBrush(point) {
  if (hitCache && hitCache.x === point.x && hitCache.y === point.y) return hitCache.ids;
  const ids = new Set();
  const fp = footprint(point);
  if (fp) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of outlineOf(fp)) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const features = map.queryRenderedFeatures(
      [
        [x0, y0],
        [x1, y1],
      ],
      { layers: ["flowpaths"] },
    );
    for (const f of features) {
      if (ids.has(f.id)) continue;
      if (lineWithin(f.geometry, fp)) ids.add(f.id);
    }
  }
  hitCache = { x: point.x, y: point.y, ids };
  return ids;
}

// Mercator is conformal, so a ground circle stays a circle in its units
// over a brush-sized area.
function lineWithin(geometry, fp) {
  const { center, radius } = fp;
  const lines =
    geometry.type === "MultiLineString" ? geometry.coordinates : [geometry.coordinates];
  if (fp.sphere) return lineWithinSphere(lines, fp);
  const r2 = radius * radius;
  for (const line of lines) {
    let a = maplibregl.MercatorCoordinate.fromLngLat(line[0]);
    if (dist2(center, a) <= r2) return true;
    for (let k = 1; k < line.length; k++) {
      const b = maplibregl.MercatorCoordinate.fromLngLat(line[k]);
      if (segmentDist2(center, a, b) <= r2) return true;
      a = b;
    }
  }
  return false;
}

// The sphere test, in metres relative to the centre. A segment is flat-
// checked first (a sphere's shadow is its disk), so only candidates near the
// centre pay for terrain lookups.
function lineWithinSphere(lines, { center, radius, sphere }) {
  const r2 = radius * radius;
  const rm2 = (radius / sphere.mpu) ** 2;
  const toLocal = (lngLat, m) => ({
    x: (m.x - center.x) / sphere.mpu,
    y: (m.y - center.y) / sphere.mpu,
    z: (map.queryTerrainElevation(lngLat) ?? sphere.z) - sphere.z,
  });
  for (const line of lines) {
    const merc = line.map((c) => maplibregl.MercatorCoordinate.fromLngLat(c));
    const local = new Array(line.length);
    const at = (k) => (local[k] ??= toLocal(line[k], merc[k]));
    if (merc.length === 1) {
      if (dist2(center, merc[0]) <= r2 && norm2(at(0)) <= rm2) return true;
      continue;
    }
    for (let k = 1; k < merc.length; k++) {
      if (segmentDist2(center, merc[k - 1], merc[k]) > r2) continue;
      if (segmentDist2Origin3(at(k - 1), at(k)) <= rm2) return true;
    }
  }
  return false;
}

const norm2 = (p) => p.x * p.x + p.y * p.y + p.z * p.z;

// Squared distance from the origin to segment ab, in 3D.
function segmentDist2Origin3(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy + a.z * dz) / len2)) : 0;
  return norm2({ x: a.x + t * dx, y: a.y + t * dy, z: a.z + t * dz });
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
  const fp =
    cursor && state.brushActive && !(cursorIsTouch && !touches.size) ? footprint(cursor) : null;
  const { center, radius, sphere } = fp ?? {};
  setBrushSphere(
    map,
    sphere
      ? { x: center.x, y: center.y, z: sphere.z * sphere.mpu, r: radius, painting }
      : null,
  );
  if (!fp || sphere) {
    el.classList.remove("visible");
    return;
  }
  const d = outlineOf(fp).map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  el.querySelector("path").setAttribute("d", `${d.join("")}Z`);
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
    hitCache = footprintCache = null;
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
  // The camera moving under a still cursor changes what's beneath it, and
  // tilts the disk.
  map.on("move", () => {
    hitCache = footprintCache = null;
    if (state.brushActive) positionBrush();
  });
  // Terrain toggled: the brush swaps between disk and sphere.
  map.on("terrain", () => {
    hitCache = footprintCache = null;
    positionBrush();
  });
}

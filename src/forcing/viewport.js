// ====================================================================
// What's in view: the VPUs (from the vpu tiles) and catchments (from the
// divides tiles) the forcing loader should fetch for.
// ====================================================================
import { map } from "../state.js";
import { FORCING_LAYER, VPU_LAYER } from "../config.js";

// The divides tiles start at this zoom; below it no catchments are rendered.
export const MIN_CATCHMENT_ZOOM = 4;

function vpuIds(features) {
  const out = new Set();
  for (const f of features) {
    if (f.properties?.vpuid) out.add(String(f.properties.vpuid));
  }
  return out;
}

export function vpusInView() {
  return vpuIds(map.queryRenderedFeatures({ layers: [VPU_LAYER] }));
}

// VPUs within `radius` px of a screen point. A box rather than the point
// itself: the VPU polygons are simplified at low zoom, so a catchment on a
// boundary can sit just inside its neighbour's polygon.
export function vpusNear(point, radius = 16) {
  return vpuIds(
    map.queryRenderedFeatures(
      [
        [point.x - radius, point.y - radius],
        [point.x + radius, point.y + radius],
      ],
      { layers: [VPU_LAYER] },
    ),
  );
}

// Numeric ids (cat-N → N) of the catchments rendered in the viewport.
export function catchmentsInView() {
  const ids = new Set();
  for (const f of map.queryRenderedFeatures({ layers: [FORCING_LAYER] })) {
    if (f.id != null) ids.add(f.id);
  }
  return ids;
}

// The catchment feature under a screen point, if any.
export function catchmentAt(point) {
  return map.queryRenderedFeatures(point, { layers: [FORCING_LAYER] })[0] ?? null;
}

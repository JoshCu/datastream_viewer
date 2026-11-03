// ====================================================================
// A gridded run's cells on the map (config.REACH_SETS.grid): one square
// polygon per cell the run has, in a GeoJSON source whose feature ids are the
// run's cell ids, so the ordinary feature-state painter (map/paint.js) colours
// them like reaches. Built when such a run becomes active and dropped when it
// goes; the layer sits under the reach lines.
// ====================================================================
import { map } from "../state.js";
import { REACH_SETS, NO_DATA_COLOR } from "../config.js";

const { source: SOURCE } = REACH_SETS.grid.feature;
const LAYER = REACH_SETS.grid.layer;
const BELOW = ["flowpaths", "nwm-flowlines"]; // drawn under the first present

let shownFor = null; // the dataset the source holds

// Cell edges from the centres: halfway between neighbours, half a step out
// at the ends.
function edges(centres) {
  const n = centres.length;
  const out = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) out[i] = (centres[i - 1] + centres[i]) / 2;
  out[0] = n > 1 ? centres[0] - (centres[1] - centres[0]) / 2 : centres[0] - 0.5;
  out[n] = n > 1 ? centres[n - 1] + (centres[n - 1] - centres[n - 2]) / 2 : centres[0] + 0.5;
  return out;
}

function cellsGeoJson(data) {
  const { lat, lon } = data.grid;
  const ye = edges(lat);
  const xe = edges(lon);
  const nLon = lon.length;
  const features = new Array(data.featureIds.length);
  for (let k = 0; k < data.featureIds.length; k++) {
    const id = data.featureIds[k];
    const r = Math.floor((id - 1) / nLon);
    const c = (id - 1) % nLon;
    const [w, e, s, n] = [xe[c], xe[c + 1], ye[r], ye[r + 1]];
    features[k] = {
      type: "Feature",
      id,
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    };
  }
  return { type: "FeatureCollection", features };
}

function removeLayer() {
  if (map.getLayer(LAYER)) map.removeLayer(LAYER);
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

function addLayer(data) {
  removeLayer();
  map.addSource(SOURCE, { type: "geojson", data: cellsGeoJson(data) });
  map.addLayer(
    {
      id: LAYER,
      type: "fill",
      source: SOURCE,
      paint: {
        "fill-color": NO_DATA_COLOR, // map/paint.js sets the run's colours
        "fill-opacity": 0.8,
        "fill-outline-color": [
          "case", ["boolean", ["feature-state", "hover"], false], "#ffffff", "rgba(0, 0, 0, 0)",
        ],
      },
    },
    BELOW.find((id) => map.getLayer(id)),
  );
}

// The cells' extent [[w, s], [e, n]] for a gridded run.
export function gridBounds(data) {
  const { lat, lon } = data.grid;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  const nLon = lon.length;
  for (const id of data.featureIds) {
    const y = lat[Math.floor((id - 1) / nLon)];
    const x = lon[(id - 1) % nLon];
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  }
  return w <= e ? [[w, s], [e, n]] : null;
}

// Reaction to the active run changing; registered in map/init.js before the
// paint subscriber, so the layer exists when the run is painted.
export function syncGridToDataset({ data }) {
  const grid = data?.reaches === "grid" && data.grid ? data : null;
  if (grid === shownFor && (!grid || map.getLayer(LAYER))) return;
  shownFor = grid;
  if (grid) addLayer(grid);
  else removeLayer();
}


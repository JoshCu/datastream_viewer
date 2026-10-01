// ====================================================================
// NEXRAD station dots + labels (WSR-88D and TDWR), from stations.json.
//
// Shown while the NEXRAD panel is open. Stations with scans on the picked
// date are bright, the rest grey; the chosen one is white. Clicking a dot
// hands its ICAO to `onPick`.
// ====================================================================
import { map } from "../state.js";
import { NEXRAD_SITE_LAYER } from "../config.js";
import stations from "./stations.json" with { type: "json" };

const SOURCE = "nexrad-sites";
const LABEL_LAYER = "nexrad-sites-label";

const coords = new Map(stations.features.map((f) => [f.properties.id, f.geometry.coordinates]));

// [lon, lat] of a station, or undefined if it isn't in the table.
export const stationCoords = (id) => coords.get(id);

let added = false;
let look = { available: [], selected: "" };

function addLayers(onPick) {
  map.addSource(SOURCE, { type: "geojson", data: stations });
  map.addLayer({
    id: NEXRAD_SITE_LAYER,
    type: "circle",
    source: SOURCE,
    paint: {
      "circle-radius": ["match", ["get", "kind"], "WSR-88D", 5, 3.5],
      "circle-stroke-color": "#0a0e14",
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: LABEL_LAYER,
    type: "symbol",
    source: SOURCE,
    minzoom: 4.5,
    layout: {
      "text-field": ["get", "id"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 11,
      "text-anchor": "top",
      "text-offset": [0, 0.6],
    },
    paint: {
      "text-color": "#e6edf5",
      "text-halo-color": "#0a0e14",
      "text-halo-width": 1.5,
    },
  });
  map.on("click", NEXRAD_SITE_LAYER, (e) => onPick(e.features[0].properties.id));
  map.on("mouseenter", NEXRAD_SITE_LAYER, () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", NEXRAD_SITE_LAYER, () => (map.getCanvas().style.cursor = ""));
  added = true;
}

function applyLook() {
  const id = ["get", "id"];
  const available = ["in", id, ["literal", look.available]];
  map.setPaintProperty(NEXRAD_SITE_LAYER, "circle-color", [
    "case",
    ["==", id, look.selected],
    "#ffffff",
    available,
    "#00d4ff",
    "#556677",
  ]);
  map.setPaintProperty(LABEL_LAYER, "text-opacity", ["case", available, 1, 0.5]);
  // Lower keys win label collisions: the chosen station, then WSR-88Ds.
  map.setLayoutProperty(LABEL_LAYER, "symbol-sort-key", [
    "case",
    ["==", id, look.selected],
    0,
    ["==", ["get", "kind"], "WSR-88D"],
    1,
    2,
  ]);
}

// Show or hide the dots. The layers are added on first show; a shared link
// can open the panel before the style has loaded, in which case adding them
// throws and is retried on the next styledata.
let visible = false;
export function showSites(on, onPick) {
  visible = on;
  if (!added) {
    if (!on) return;
    try {
      addLayers(onPick);
    } catch {
      map.once("styledata", () => showSites(visible, onPick));
      return;
    }
    applyLook();
  }
  for (const layer of [NEXRAD_SITE_LAYER, LABEL_LAYER]) {
    map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }
}

// Highlight the stations with data on the picked date and the chosen one.
export function styleSites(available, selected) {
  look = { available, selected };
  if (added) applyLook();
}

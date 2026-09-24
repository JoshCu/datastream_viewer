// ====================================================================
// Gage layer visibility: only gages sitting on a reach in the loaded run
// ====================================================================
import { state, map } from "../state.js";
import {
  HIDDEN_FILTER,
  GAGE_LAYER,
  GAGE_GLOW_LAYER,
  GAGE_LABEL_LAYER,
  GAGE_FEATURE,
} from "../config.js";

const LAYERS = [GAGE_LAYER, GAGE_GLOW_LAYER, GAGE_LABEL_LAYER];

// User toggles from GageControl. Labels only draw while gages are shown.
let gagesVisible = true;
let labelsVisible = false;

function applyGageVisibility() {
  const vis = (on) => (on ? "visible" : "none");
  map.setLayoutProperty(GAGE_LAYER, "visibility", vis(gagesVisible));
  map.setLayoutProperty(GAGE_GLOW_LAYER, "visibility", vis(gagesVisible));
  map.setLayoutProperty(
    GAGE_LABEL_LAYER,
    "visibility",
    vis(gagesVisible && labelsVisible),
  );
}

export function setGagesVisible(on) {
  gagesVisible = on;
  if (map.getLayer(GAGE_LAYER)) applyGageVisibility();
}

export function setGageLabelsVisible(on) {
  labelsVisible = on;
  if (map.getLayer(GAGE_LAYER)) applyGageVisibility();
}

// Show the gages whose flowpath (`id` property) is in the loaded dataset, or
// hide the layer entirely when nothing is loaded. `match` is used rather than
// `in` because MapLibre compiles its label list into a hash lookup, which
// keeps a CONUS-sized id list cheap to evaluate per feature.
export function updateGageFilter() {
  if (!map.getLayer(GAGE_LAYER)) return;
  // index keys are de-duplicated; match rejects repeated labels.
  const filter = state.data
    ? ["match", ["get", "id"], Array.from(state.data.index.keys()), true, false]
    : HIDDEN_FILTER;
  for (const layer of LAYERS) map.setFilter(layer, filter);
  // Catch up on any toggle clicked before the style finished loading.
  applyGageVisibility();
}

// USGS site number of a gage sitting on `reachId`, or null. Only gage tiles
// already loaded can be searched, which is fine for a reach just clicked on
// screen: its gage (if any) is drawn in the same view.
export function gageSiteForReach(reachId) {
  if (!map.getSource(GAGE_FEATURE.source)) return null;
  const hits = map.querySourceFeatures(GAGE_FEATURE.source, {
    sourceLayer: GAGE_FEATURE.sourceLayer,
    filter: ["==", ["get", "id"], reachId],
  });
  const uri = hits[0]?.properties.hl_uri;
  return uri ? String(uri).replace(/^gages-/, "") : null;
}

// ---- Map control: show/hide gages, show/hide gage id labels -----------

const SVG_NS = "http://www.w3.org/2000/svg";

function iconButton(className, title, pathD) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `maplibregl-ctrl-gage ${className}`;
  button.title = title;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathD);
  svg.appendChild(path);
  const icon = document.createElement("span");
  icon.className = "maplibregl-ctrl-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.appendChild(svg);
  button.appendChild(icon);
  return button;
}

export class GageControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";

    // Dot with a ring: a gage marker.
    this._gageBtn = iconButton(
      "maplibregl-ctrl-gage-toggle",
      "Show gages",
      "M12,9a3,3,0,1,0,3,3A3,3,0,0,0,12,9ZM12,5a7,7,0,1,0,7,7A7,7,0,0,0,12,5Z",
    );
    // Dot beside a text line: a labelled gage.
    this._labelBtn = iconButton(
      "maplibregl-ctrl-gage-labels",
      "Show gage id labels",
      "M7,12a2,2,0,1,0-2,2A2,2,0,0,0,7,12ZM11,9h9M11,12h9M11,15h6",
    );

    this._gageBtn.onclick = () => {
      setGagesVisible(!gagesVisible);
      this._sync();
    };
    this._labelBtn.onclick = () => {
      setGageLabelsVisible(!labelsVisible);
      this._sync();
    };

    this._container.append(this._gageBtn, this._labelBtn);
    this._sync();
    return this._container;
  }

  _sync() {
    this._gageBtn.classList.toggle("active", gagesVisible);
    this._gageBtn.title = gagesVisible ? "Hide gages" : "Show gages";
    this._labelBtn.classList.toggle("active", gagesVisible && labelsVisible);
    this._labelBtn.disabled = !gagesVisible;
    this._labelBtn.title = labelsVisible
      ? "Hide gage id labels"
      : "Show gage id labels";
  }

  onRemove() {
    this._container.remove();
  }
}

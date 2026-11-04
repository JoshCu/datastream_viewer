// ====================================================================
// HUC Boundaries panel: show/hide per level. The title icon hides every level
// and brings the same set back. The layers are map/huc.js.
// ====================================================================
import { HUC_LEVELS } from "../config.js";
import { setHucLevel, shownHucLevels } from "../map/huc.js";
import { layerOn, onLayerChange, saveLayer } from "../map/layerprefs.js";
import { registerPanelLayer } from "./panellayers.js";

const DEFAULT_LEVELS = ["huc2", "huc4", "huc8"];

function setLevel(key, on) {
  setHucLevel(key, on);
  saveLayer(key, on);
}

function hideAll() {
  HUC_LEVELS.forEach(({ key }) => setLevel(key, false));
}

export function setupHucPanel() {
  let lastShown = DEFAULT_LEVELS;
  registerPanelLayer("hucPanel", {
    name: "HUC boundaries",
    isShowing: () => shownHucLevels().length > 0,
    toggle: () => {
      const shown = shownHucLevels().map(({ key }) => key);
      if (shown.length) {
        lastShown = shown;
        hideAll();
      } else {
        lastShown.forEach((key) => setLevel(key, true));
      }
    },
    stop: hideAll,
  });

  const checkboxes = HUC_LEVELS.map(({ key, label, name, minzoom, color }) => {
    const row = document.createElement("label");
    row.className = "usgs-type";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => setLevel(key, checkbox.checked));
    const swatch = document.createElement("span");
    swatch.className = "usgs-swatch";
    swatch.style.background = color;
    const text = document.createElement("span");
    text.className = "usgs-type-name";
    text.textContent = `${label} · ${name}`;
    const zoom = document.createElement("span");
    zoom.className = "usgs-type-count";
    zoom.textContent = minzoom ? `z${minzoom}+` : "";
    zoom.title = minzoom ? `In the tiles from zoom ${minzoom}` : "";
    row.append(checkbox, swatch, text, zoom);
    document.getElementById("hucLevels").append(row);
    return { key, checkbox };
  });

  const sync = () => {
    for (const { key, checkbox } of checkboxes) checkbox.checked = layerOn(key);
  };
  onLayerChange(sync);
  sync();
}

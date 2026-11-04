// ====================================================================
// A panel's title icon as the switch for what that panel draws on the map:
// it glows while the layer is showing, and a click toggles the layer without
// opening or closing the panel.
//
// Each panel registers its own layer, since what "hide" means differs (a paint
// opacity, a layer's visibility, stopping the particles). While there's nothing
// to toggle (`canToggle` false: no data loaded yet) a click falls through to the
// title and opens the panel, which is where the data is loaded from.
//
// Changes made from code call syncPanelLayers(). Toggles of the map's layer
// buttons (map/layerprefs.js) are picked up here.
// ====================================================================
import { onLayerChange } from "../map/layerprefs.js";

const entries = [];

function syncEntry({ button, name, offVerb, isShowing, canToggle }) {
  const can = canToggle();
  const on = can && isShowing();
  button.classList.toggle("can-toggle", can);
  button.classList.toggle("on", on);
  button.setAttribute("aria-pressed", String(on));
  button.title = !can ? "" : on ? `${offVerb} ${name}` : `Show ${name}`;
}

// `name` is what the button's title calls the layer ("Hide <name>", or `offVerb`
// instead of "Hide"). `stop`, for a layer that normally ends with its panel,
// turns it off when the panel is taken out of the sidebar (ui/panelsettings.js).
export function registerPanelLayer(panelId, { name, offVerb = "Hide", isShowing, canToggle = () => true, toggle, stop }) {
  const icon = document.querySelector(`#${panelId} > .panel-title > svg`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "panel-layer-toggle";
  icon.replaceWith(button);
  button.append(icon);
  button.addEventListener("click", (e) => {
    if (!canToggle()) return;
    e.stopPropagation(); // not a click on the title: the panel stays as it is
    toggle();
    syncPanelLayers();
  });
  const entry = { panelId, button, name, offVerb, isShowing, canToggle, toggle, stop };
  entries.push(entry);
  syncEntry(entry);
}

export function syncPanelLayers() {
  entries.forEach(syncEntry);
  for (const fn of syncListeners) fn();
}

// For the timeline's eye buttons, which are the same switch as the panel icon.
const syncListeners = new Set();
export function onPanelLayersSync(fn) {
  syncListeners.add(fn);
}

export function isPanelLayerShowing(panelId) {
  const entry = entries.find((e) => e.panelId === panelId);
  return !entry || (entry.canToggle() && entry.isShowing());
}

export function togglePanelLayer(panelId) {
  const entry = entries.find((e) => e.panelId === panelId);
  if (!entry?.canToggle()) return;
  entry.toggle();
  syncPanelLayers();
}

export function stopPanelLayer(panelId) {
  entries.find((e) => e.panelId === panelId)?.stop?.();
  syncPanelLayers();
}

onLayerChange(syncPanelLayers);

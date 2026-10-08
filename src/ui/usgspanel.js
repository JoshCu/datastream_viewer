// ====================================================================
// USGS Gages panel: the catalog's load status, and show/hide per
// observation type (with each type's colour and site count) plus the
// "reporting recently" switch. The layer itself is map/usgssites.js.
// ====================================================================
import { USGS_OBS_TYPES, USGS_ACTIVE_WINDOW_MS } from "../config.js";
import { onCatalogChange, getCatalog, catalogStatus, loadUsgsCatalog } from "../data/usgscatalog.js";
import {
  isTypeShown,
  activeOnly,
  setTypeShown,
  setAllTypesShown,
  setActiveOnly,
  onSiteFilterChange,
} from "../map/usgssites.js";
import { setStatus } from "./panels.js";

const $ = (id) => document.getElementById(id);

const rows = []; // per type: { checkbox, count }

export function setupUsgsPanel() {
  const days = Math.round(USGS_ACTIVE_WINDOW_MS / 86400000);
  $("usgsActiveOnlyText").textContent = `Only sites reporting in the last ${days} days`;

  const list = $("usgsTypes");
  USGS_OBS_TYPES.forEach((type, i) => {
    const label = document.createElement("label");
    label.className = "usgs-type";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("change", () => setTypeShown(i, checkbox.checked));
    const swatch = document.createElement("span");
    swatch.className = "usgs-swatch";
    swatch.style.background = type.color;
    const name = document.createElement("span");
    name.className = "usgs-type-name";
    name.textContent = type.label;
    const count = document.createElement("span");
    count.className = "usgs-type-count";
    label.append(checkbox, swatch, name, count);
    list.append(label);
    rows.push({ checkbox, count });
  });

  $("usgsActiveOnly").addEventListener("change", (e) => setActiveOnly(e.target.checked));
  $("usgsAllBtn").addEventListener("click", () => setAllTypesShown(true));
  $("usgsNoneBtn").addEventListener("click", () => setAllTypesShown(false));
  $("usgsRefreshBtn").addEventListener("click", () => loadUsgsCatalog({ force: true }));

  onSiteFilterChange(sync);
  onCatalogChange((_, status) => {
    setStatus(status.kind, status.text, "usgs");
    $("usgsRefreshBtn").disabled = status.kind === "loading";
    sync();
  });
  const { kind, text } = catalogStatus();
  if (text) setStatus(kind, text, "usgs");
  sync();
}

function sync() {
  const active = activeOnly();
  $("usgsActiveOnly").checked = active;
  const counts = new Array(USGS_OBS_TYPES.length).fill(0);
  for (const site of getCatalog()?.sites ?? []) {
    const mask = active ? site.activeMask : site.mask;
    for (let i = 0; i < counts.length; i++) if (mask & (1 << i)) counts[i]++;
  }
  rows.forEach(({ checkbox, count }, i) => {
    checkbox.checked = isTypeShown(i);
    count.textContent = getCatalog() ? counts[i].toLocaleString() : "";
  });
}

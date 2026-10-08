// ====================================================================
// USGS Gages panel: the catalog's load status, and show/hide per
// observation type (with each type's colour and site count), and which
// series count: a period (reporting recently / any time / a date range), a
// minimum record length and a drainage-area range, plus copying/saving the
// shown sites as a table. The layer itself is map/usgssites.js.
// ====================================================================
import { USGS_OBS_TYPES, USGS_ACTIVE_WINDOW_MS } from "../config.js";
import { onCatalogChange, getCatalog, catalogStatus, loadUsgsCatalog } from "../data/usgscatalog.js";
import {
  isTypeShown,
  periodSettings,
  filteredMasks,
  shownSites,
  setTypeShown,
  setAllTypesShown,
  setPeriod,
  onSiteFilterChange,
} from "../map/usgssites.js";
import { setStatus } from "./panels.js";

const $ = (id) => document.getElementById(id);

const rows = []; // per type: { checkbox, count }

export function setupUsgsPanel() {
  const days = Math.round(USGS_ACTIVE_WINDOW_MS / 86400000);
  $("usgsRecentOption").textContent = `Reporting in the last ${days} days`;

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

  $("usgsPeriod").addEventListener("change", (e) => setPeriod({ period: e.target.value }));
  $("usgsFrom").addEventListener("change", (e) => setPeriod({ from: e.target.value }));
  $("usgsTo").addEventListener("change", (e) => setPeriod({ to: e.target.value }));
  $("usgsCover").addEventListener("change", (e) => setPeriod({ cover: e.target.checked }));
  $("usgsMinYears").addEventListener("change", (e) => setPeriod({ minYears: e.target.value }));
  $("usgsMinArea").addEventListener("change", (e) => setPeriod({ minArea: e.target.value }));
  $("usgsMaxArea").addEventListener("change", (e) => setPeriod({ maxArea: e.target.value }));
  $("usgsCopyBtn").addEventListener("click", copyList);
  $("usgsSaveBtn").addEventListener("click", saveList);
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
  const { period, from, to, cover, minYears, minArea, maxArea } = periodSettings();
  $("usgsPeriod").value = period;
  $("usgsRange").hidden = period !== "range";
  $("usgsFrom").value = from;
  $("usgsTo").value = to;
  $("usgsCover").checked = cover;
  $("usgsMinYears").value = minYears || "";
  $("usgsMinArea").value = minArea ?? "";
  $("usgsMaxArea").value = maxArea ?? "";

  const masks = filteredMasks();
  const counts = new Array(USGS_OBS_TYPES.length).fill(0);
  let shownTypes = 0;
  rows.forEach((_, i) => {
    if (isTypeShown(i)) shownTypes |= 1 << i;
  });
  let shown = 0;
  for (const mask of masks ?? []) {
    for (let i = 0; i < counts.length; i++) if (mask & (1 << i)) counts[i]++;
    if (mask & shownTypes) shown++;
  }
  rows.forEach(({ checkbox, count }, i) => {
    checkbox.checked = isTypeShown(i);
    count.textContent = masks ? counts[i].toLocaleString() : "";
  });
  $("usgsShown").textContent = masks ? `${shown.toLocaleString()} sites shown` : "";
  $("usgsCopyBtn").disabled = $("usgsSaveBtn").disabled = !shown;
}

// ---- Export ---------------------------------------------------------------

const COLUMNS = [
  "site_id", "site_no", "name", "state", "site_type",
  "latitude", "longitude", "drainage_area_mi2", "types",
];

// The shown sites as rows of strings, header first.
function listRows() {
  const rows = [COLUMNS];
  for (const { site, types } of shownSites()) {
    rows.push([
      site.id,
      site.no,
      site.name,
      site.state,
      site.siteType ?? "",
      String(site.lat),
      String(site.lon),
      site.area == null ? "" : String(site.area),
      types.map((t) => USGS_OBS_TYPES[t].label).join("; "),
    ]);
  }
  return rows;
}

function csvField(v) {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Briefly replace the "N sites shown" line with a result.
let flashTimer = 0;
function flash(text) {
  $("usgsShown").textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(sync, 2000);
}

// Tab-separated, so it pastes into spreadsheet columns.
async function copyList() {
  const rows = listRows();
  const text = rows.map((r) => r.map((v) => v.replace(/[\t\r\n]/g, " ")).join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    flash(`Copied ${(rows.length - 1).toLocaleString()} sites`);
  } catch (err) {
    flash(`Copy failed: ${err.message}`);
  }
}

function saveList() {
  const rows = listRows();
  const csv = rows.map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `usgs-sites-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  flash(`Saved ${(rows.length - 1).toLocaleString()} sites`);
}

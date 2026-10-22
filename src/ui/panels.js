// ====================================================================
// Sidebar panels: data info summary, legend, scale picker, status lines
// ====================================================================
import { state } from "../state.js";
import { VARIABLES, SCALE_LABELS } from "../config.js";
import { colormapGradient } from "../color/colormaps.js";
import { fillColormapSelect, runColormapId, runColors } from "./colormap.js";
import { initialOpenPanels, syncUrl } from "./url.js";

// Makes the whole title bar of every panel that has a `.panel-collapse-toggle`
// button collapse/expand its ancestor `.panel` (data-source panels like S3
// browse and file upload). The button is inside the title, so one listener
// on the title covers clicks on the arrow too.
//
// Panels named in the URL's `open` list start expanded, with a brief aura so
// whoever followed the link sees what they were sent to; toggling rewrites
// the URL so the current layout is always shareable.
export function initCollapsiblePanels() {
  const toOpen = initialOpenPanels();
  document.querySelectorAll(".panel-collapse-toggle").forEach((btn) => {
    const title = btn.closest(".panel-title");
    const panel = title.closest(".panel");
    if (toOpen.has(panel.dataset.urlKey)) {
      panel.classList.remove("collapsed");
      highlightPanel(panel);
    }
    title.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      panel.classList.remove("url-highlight");
      syncUrl();
    });
  });
  // No syncUrl() here: setupS3Browser still has to read bucket/path, and its
  // first breadcrumb update normalizes the URL.
}

function highlightPanel(panel) {
  panel.classList.add("url-highlight");
  // animationend bubbles, and children (spinners, status dots) animate too.
  const done = (e) => {
    if (e.target !== panel) return;
    panel.classList.remove("url-highlight");
    panel.removeEventListener("animationend", done);
  };
  panel.addEventListener("animationend", done);
  panel.scrollIntoView({ block: "nearest" });
}

// ---- Status lines ---------------------------------------------------

// The dot class per status, shared by the sidebar status lines and the
// per-row dots in the upload list.
export const STATUS_DOT_CLASS = {
  pending: "",
  idle: "",
  loading: "loading",
  loaded: "success",
  success: "success",
  error: "error",
};

// Update a "<dot> <text>" status line. `prefix` selects which one: "" is the
// S3/load status, "diff" is the upload panel's diff status.
export function setStatus(kind, text, prefix = "") {
  const id = (suffix) =>
    prefix ? `${prefix}Status${suffix}` : `status${suffix}`;
  const dot = document.getElementById(id("Dot"));
  const label = document.getElementById(id("Text"));
  if (dot) dot.className = `status-dot ${STATUS_DOT_CLASS[kind] ?? ""}`.trim();
  if (label) label.textContent = text;
}

// ---- Panel visibility ------------------------------------------------

const DATA_PANEL_IDS = ["dataPanel", "varPanel", "timePanel"];

export function setDataPanels(on) {
  for (const id of DATA_PANEL_IDS) {
    document.getElementById(id).style.display = on ? "block" : "none";
  }
}

// ---- Readouts --------------------------------------------------------

export function updateDataInfo() {
  const refTime = state.data.refTime || "N/A";
  document.getElementById("featureCount").textContent =
    state.data.featureIds.length;
  document.getElementById("timeSteps").textContent = state.data.nTimes;
  document.getElementById("refTime").textContent =
    typeof refTime === "string" ? refTime.substring(0, 10) : "N/A";
}

export function updateLegend() {
  if (!state.data) return;
  const bounds = state.data.bounds[state.variable];
  const { label, units } = VARIABLES[state.variable];

  document.getElementById("legendGradient").style.background =
    colormapGradient(runColors());

  const scaleNote =
    state.scale === "linear" ? "" : ` · ${SCALE_LABELS[state.scale]}`;
  document.getElementById("legendTitle").textContent = state.data.isDiff
    ? `${label} diff (${units})${scaleNote} — ${state.data.diffLabel}`
    : `${label} (${units})${scaleNote}`;
  document.getElementById("legendMin").textContent = bounds.min.toFixed(2);
  document.getElementById("legendMax").textContent = bounds.max.toFixed(2);
}

// Every colour map is offered to every run; a diff lists the diverging ones
// first and keeps its own choice (state.diffColormap).
function syncColormapSelect(data) {
  fillColormapSelect(
    document.getElementById("colormapSelect"),
    !!data?.isDiff,
    runColormapId(data),
  );
}

// Reaction to the active run changing. Registered in map/init.js.
export function syncPanelsToDataset({ data }) {
  syncColormapSelect(data);
  setDataPanels(!!data);
  if (!data) return;
  updateDataInfo();
  updateLegend();
}

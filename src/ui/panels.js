// ====================================================================
// Sidebar panels: data info summary, legend, scale picker, status lines
// ====================================================================
import { state } from "../state.js";
import { VARIABLES, SCALE_LABELS, PALETTE, DIFF_PALETTE } from "../config.js";

// Makes the whole title bar of every panel that has a `.panel-collapse-toggle`
// button collapse/expand its ancestor `.panel` (data-source panels like S3
// browse and file upload). The button is inside the title, so one listener
// on the title covers clicks on the arrow too.
export function initCollapsiblePanels() {
  document.querySelectorAll(".panel-collapse-toggle").forEach((btn) => {
    const title = btn.closest(".panel-title");
    title.addEventListener("click", () => {
      title.closest(".panel").classList.toggle("collapsed");
    });
  });
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
    `linear-gradient(to right, ${(state.data.isDiff ? DIFF_PALETTE : PALETTE).join(", ")})`;

  if (state.data.isDiff) {
    document.getElementById("legendTitle").textContent =
      `${label} diff (${units}) — ${state.data.diffLabel}`;
  } else {
    const scaleNote =
      state.scale === "linear" ? "" : ` · ${SCALE_LABELS[state.scale]}`;
    document.getElementById("legendTitle").textContent =
      `${label} (${units})${scaleNote}`;
  }
  document.getElementById("legendMin").textContent = bounds.min.toFixed(2);
  document.getElementById("legendMax").textContent = bounds.max.toFixed(2);
}

// A diff only permits the linear scale (its signed, symmetric values don't
// suit the magnitude-oriented transforms). That's a property of the dataset,
// so the picker reads it rather than the loader reaching in to set it.
function applyScaleAvailability(data) {
  const scaleSelect = document.getElementById("scaleSelect");
  const linearOnly = !!data?.isDiff;
  if (linearOnly) scaleSelect.value = "linear";
  scaleSelect.disabled = linearOnly;
}

// Reaction to the active run changing. Registered in map/init.js.
export function syncPanelsToDataset({ data }) {
  applyScaleAvailability(data);
  setDataPanels(!!data);
  if (!data) return;
  updateDataInfo();
  updateLegend();
}

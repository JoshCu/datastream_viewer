// ====================================================================
// Sidebar panels: data info summary + legend
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

export function showDataPanels() {
  document.getElementById("dataPanel").style.display = "block";
  document.getElementById("varPanel").style.display = "block";
  document.getElementById("timePanel").style.display = "block";
}

// Reverse of showDataPanels(), used when the active dataset is cleared
// (e.g. its source file was removed from the upload list).
export function hideDataPanels() {
  document.getElementById("dataPanel").style.display = "none";
  document.getElementById("varPanel").style.display = "none";
  document.getElementById("timePanel").style.display = "none";
}

export function updateDataInfo() {
  const refTime = state.data.refTime || "N/A";
  document.getElementById("featureCount").textContent =
    state.data.featureIds.length;
  document.getElementById("timeSteps").textContent = state.data.nTimes;
  document.getElementById("matchedCount").textContent =
    state.data.featureIds.length;
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

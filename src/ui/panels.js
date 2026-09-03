// ====================================================================
// Sidebar panels: data info summary + legend
// ====================================================================
import { state } from "../state.js";
import { VARIABLES, SCALE_LABELS } from "../config.js";

// Wires every `.panel-collapse-toggle` button to collapse/expand its
// ancestor `.panel` (data-source panels like S3 browse and file upload).
export function initCollapsiblePanels() {
  document.querySelectorAll(".panel-collapse-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".panel").classList.toggle("collapsed");
    });
  });
}

export function showDataPanels() {
  document.getElementById("dataPanel").style.display = "block";
  document.getElementById("varPanel").style.display = "block";
  document.getElementById("timePanel").style.display = "block";
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
  const scaleNote =
    state.scale === "linear" ? "" : ` · ${SCALE_LABELS[state.scale]}`;
  document.getElementById("legendTitle").textContent =
    `${label} (${units})${scaleNote}`;
  document.getElementById("legendMin").textContent = bounds.min.toFixed(2);
  document.getElementById("legendMax").textContent = bounds.max.toFixed(2);
}

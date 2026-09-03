// ====================================================================
// Local file upload panel: drag-drop or browse for a NetCDF/Parquet file,
// then hand it to data/loader.js's local-file path.
// ====================================================================
import { loadLocalFile } from "../data/loader.js";

let pendingFile = null;

export function setupUploadPanel() {
  const zone = document.getElementById("uploadZone");
  const fileInput = document.getElementById("fileInput");
  const loadBtn = document.getElementById("uploadLoadBtn");
  const removeBtn = document.getElementById("fileRemove");

  zone.addEventListener("click", () => fileInput.click());

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files.length) selectFile(e.target.files[0]);
  });

  loadBtn.addEventListener("click", () => {
    if (pendingFile) loadLocalFile(pendingFile);
  });

  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    clearFile();
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function selectFile(file) {
  pendingFile = file;

  document.getElementById("fileInfo").style.display = "flex";
  document.getElementById("fileName").textContent = file.name;
  document.getElementById("fileSize").textContent = formatFileSize(file.size);
  document.getElementById("uploadZone").style.display = "none";
  document.getElementById("uploadLoadBtn").disabled = false;

  document.getElementById("uploadStatusDot").className = "status-dot";
  document.getElementById("uploadStatusText").textContent =
    "File selected — click Load";
}

function clearFile() {
  pendingFile = null;

  document.getElementById("fileInfo").style.display = "none";
  document.getElementById("uploadZone").style.display = "";
  document.getElementById("fileInput").value = "";
  document.getElementById("uploadLoadBtn").disabled = true;

  document.getElementById("uploadStatusDot").className = "status-dot";
  document.getElementById("uploadStatusText").textContent =
    "Upload a NetCDF or Parquet file to begin";
}

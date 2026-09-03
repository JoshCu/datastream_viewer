// ====================================================================
// Local file upload panel: drag-drop or browse for one or many NetCDF/
// Parquet files, queue them in a list, and load/remove them individually.
//
// Uploaded files are kept around (not cleared on load) so several local
// runs — and eventually the S3 source too — can sit side by side as the
// user switches which one is painted on the map. Only one dataset is ever
// "active" (painted) at a time today; `activeId` just tracks which row that
// is so the list reflects it, laying the groundwork for a future multi-
// source comparison view.
// ====================================================================
import { loadLocalFile } from "../data/loader.js";

let files = []; // { id, file, status: "pending"|"loading"|"loaded"|"error", message }
let activeId = null;
let nextId = 1;

export function setupUploadPanel() {
  const zone = document.getElementById("uploadZone");
  const fileInput = document.getElementById("fileInput");

  zone.addEventListener("click", () => fileInput.click());

  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    addFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener("change", (e) => {
    addFiles(e.target.files);
    fileInput.value = ""; // allow re-adding a file with the same name later
  });

  // Event delegation: rows are re-rendered wholesale on every change, so
  // listeners are bound once on the container rather than per-row.
  document.getElementById("uploadFileList").addEventListener("click", (e) => {
    const row = e.target.closest(".upload-file-item");
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest(".upload-file-load")) loadEntry(id);
    else if (e.target.closest(".upload-file-remove")) removeFile(id);
  });
}

function addFiles(fileList) {
  for (const file of fileList) {
    files.push({ id: nextId++, file, status: "pending", message: "Ready to load" });
  }
  render();
}

function removeFile(id) {
  files = files.filter((f) => f.id !== id);
  if (activeId === id) activeId = null;
  render();
}

async function loadEntry(id) {
  const entry = files.find((f) => f.id === id);
  if (!entry || entry.status === "loading") return;

  entry.status = "loading";
  entry.message =
    "Loading " + (entry.file.name.endsWith(".parquet") ? "Parquet" : "NetCDF") + "...";
  render();

  try {
    await loadLocalFile(entry.file);
    entry.status = "loaded";
    entry.message = "Active on map";
    activeId = id;
  } catch (error) {
    entry.status = "error";
    entry.message = `Error: ${error.message}`;
    console.error("Load error:", error);
  }
  render();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

const STATUS_DOT_CLASS = {
  pending: "",
  loading: "loading",
  loaded: "success",
  error: "error",
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function render() {
  const list = document.getElementById("uploadFileList");

  // A load in progress owns the shared in-memory dataset; block other rows
  // from starting a concurrent load that would race it.
  const anyLoading = files.some((f) => f.status === "loading");

  if (files.length === 0) {
    list.innerHTML = '<div class="upload-file-empty">No files added yet</div>';
    return;
  }

  list.innerHTML = files
    .map((entry) => {
      const isActive = entry.id === activeId;
      const dotClass = STATUS_DOT_CLASS[entry.status];
      return `
        <div class="upload-file-item${isActive ? " active" : ""}" data-id="${entry.id}">
          <span class="status-dot${dotClass ? " " + dotClass : ""}"></span>
          <div class="upload-file-meta">
            <span class="upload-file-name">${escapeHtml(entry.file.name)}</span>
            <span class="upload-file-sub">${formatFileSize(entry.file.size)} · ${escapeHtml(entry.message)}</span>
          </div>
          <button class="upload-file-load" title="Load onto map" ${anyLoading ? "disabled" : ""}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
            </svg>
          </button>
          <button class="upload-file-remove" title="Remove">&times;</button>
        </div>
      `;
    })
    .join("");
}

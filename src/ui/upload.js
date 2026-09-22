// ====================================================================
// Local file upload panel: drag-drop or browse for one or many NetCDF/
// Parquet files, queue them in a list, load/remove them individually, and
// diff any two loaded files against each other.
//
// Uploaded files are kept around (not cleared on load) so several local
// runs can sit side by side as the user switches which one is painted on
// the map. Each successfully loaded entry caches its normalized dataset
// (the same shape as state.data) so re-selecting it or diffing it against
// another entry never needs to re-parse the file.
// ====================================================================
import { loadLocalFile, showDiff, clearData } from "../data/loader.js";
import { fitToData } from "../map/paint.js";
import { diffDatasets } from "../data/diff.js";
import { registerSource, unregisterSource, renameSource } from "../data/sources.js";

let files = []; // { id, file, nickname, status: "pending"|"loading"|"loaded"|"error", message, dataset }
let nextId = 1;

// Row whose name is being edited inline (rename button / double-click), if any.
let editingId = null;
let rerendering = false;

// The nickname if one was given, else the file name. The same label names the
// run in the diff pickers and the hydrograph.
const displayName = (entry) => entry.nickname || entry.file.name;

// Which row (if any) is the one currently painted on the map, and whether
// what's painted is instead a computed diff of two rows.
let activeFileId = null;
let diffActive = false;

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
  const list = document.getElementById("uploadFileList");
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".upload-file-item");
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest(".upload-file-load")) loadEntry(id);
    else if (e.target.closest(".upload-file-fit")) fitEntry(id);
    else if (e.target.closest(".upload-file-rename")) startRename(id);
    else if (e.target.closest(".upload-file-remove")) removeFile(id);
  });
  list.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".upload-file-item");
    if (row && e.target.closest(".upload-file-name")) startRename(Number(row.dataset.id));
  });
  // Enter commits, Escape cancels; clicking away (blur) commits too.
  list.addEventListener("keydown", (e) => {
    if (!e.target.matches(".upload-file-name-input")) return;
    if (e.key === "Enter") e.target.blur();
    else if (e.key === "Escape") {
      editingId = null;
      renderList();
    }
  });
  list.addEventListener("focusout", (e) => {
    if (e.target.matches(".upload-file-name-input") && !rerendering) {
      commitRename(e.target.value);
    }
  });

  document.getElementById("diffASelect").addEventListener("change", updateDiffButton);
  document.getElementById("diffBSelect").addEventListener("change", updateDiffButton);
  document.getElementById("diffBtn").addEventListener("click", runDiff);
  document.getElementById("diffClearBtn").addEventListener("click", () => {
    diffActive = false;
    clearData();
    renderList();
    renderDiffControls();
  });
}

function addFiles(fileList) {
  for (const file of fileList) {
    files.push({ id: nextId++, file, status: "pending", message: "Ready to load" });
  }
  renderList();
  renderDiffControls();
}

function removeFile(id) {
  files = files.filter((f) => f.id !== id);
  unregisterSource(`upload:${id}`);
  if (activeFileId === id) {
    activeFileId = null;
    diffActive = false;
    clearData();
  }
  renderList();
  renderDiffControls();
}

async function loadEntry(id) {
  const entry = files.find((f) => f.id === id);
  if (!entry || entry.status === "loading") return;

  entry.status = "loading";
  entry.message =
    "Loading " + (entry.file.name.endsWith(".parquet") ? "Parquet" : "NetCDF") + "...";
  renderList();

  try {
    // Loads never move the camera; the per-row fit button does that on demand.
    entry.dataset = await loadLocalFile(entry.file, { fitView: false });
    entry.status = "loaded";
    entry.message = "Loaded";
    registerSource(`upload:${id}`, displayName(entry), entry.dataset);
    activeFileId = id;
    diffActive = false;
  } catch (error) {
    entry.status = "error";
    entry.message = `Error: ${error.message}`;
    console.error("Load error:", error);
  }
  renderList();
  renderDiffControls();
}

// Frame the map on the reaches this entry covers (its dataset must be
// loaded, but it needn't be the one currently painted).
function fitEntry(id) {
  const entry = files.find((f) => f.id === id);
  if (entry?.dataset) fitToData(entry.dataset);
}

function runDiff() {
  const aId = Number(document.getElementById("diffASelect").value);
  const bId = Number(document.getElementById("diffBSelect").value);
  const aEntry = files.find((f) => f.id === aId);
  const bEntry = files.find((f) => f.id === bId);
  if (!aEntry?.dataset || !bEntry?.dataset || aId === bId) return;

  const statusEl = document.getElementById("diffStatus");
  const statusDot = document.getElementById("diffStatusDot");
  const statusText = document.getElementById("diffStatusText");
  statusEl.style.display = "flex";
  statusDot.className = "status-dot loading";
  statusText.textContent = "Computing diff...";

  try {
    const diff = diffDatasets(aEntry.dataset, bEntry.dataset);
    diff.diffLabel = `${displayName(aEntry)} − ${displayName(bEntry)}`;
    showDiff(diff, { fitView: false });
    activeFileId = null;
    diffActive = true;
    statusDot.className = "status-dot success";
    statusText.textContent = `Showing ${diff.featureIds.length} features × ${diff.nTimes} shared steps`;
  } catch (error) {
    statusDot.className = "status-dot error";
    statusText.textContent = `Error: ${error.message}`;
    console.error("Diff error:", error);
  }
  renderList();
  renderDiffControls();
}

function startRename(id) {
  editingId = id;
  renderList();
  document.querySelector(".upload-file-name-input")?.select();
}

// An empty name clears the nickname, falling back to the file name.
function commitRename(value) {
  if (editingId === null) return;
  const entry = files.find((f) => f.id === editingId);
  editingId = null;
  if (entry) {
    entry.nickname = value.trim() || null;
    renameSource(`upload:${entry.id}`, displayName(entry));
  }
  renderList();
  renderDiffControls();
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

function renderList() {
  const list = document.getElementById("uploadFileList");

  // A load in progress owns the shared in-memory dataset; block other rows
  // from starting a concurrent load that would race it.
  const anyLoading = files.some((f) => f.status === "loading");

  if (files.length === 0) {
    list.innerHTML = '<div class="upload-file-empty">No files added yet</div>';
    return;
  }

  // Replacing the rows removes a focused rename input, which can fire
  // focusout; `rerendering` keeps that from committing a half-typed name.
  const draft = list.querySelector(".upload-file-name-input")?.value ?? null;
  rerendering = true;
  list.innerHTML = files
    .map((entry) => {
      const isActive = !diffActive && entry.id === activeFileId;
      const dotClass = STATUS_DOT_CLASS[entry.status];
      const name = escapeHtml(displayName(entry));
      const title = entry.nickname
        ? `${escapeHtml(entry.nickname)} (${escapeHtml(entry.file.name)})`
        : name;
      const nameEl =
        entry.id === editingId
          ? `<input class="upload-file-name-input" type="text" value="${name}"
                    placeholder="${escapeHtml(entry.file.name)}" aria-label="Nickname" />`
          : `<span class="upload-file-name" title="${title} · double-click to rename">${name}</span>`;
      return `
        <div class="upload-file-item${isActive ? " active" : ""}" data-id="${entry.id}">
          <div class="upload-file-head">
            <span class="status-dot${dotClass ? " " + dotClass : ""}"></span>
            ${nameEl}
          </div>
          <div class="upload-file-row">
            <span class="upload-file-sub">${formatFileSize(entry.file.size)} · ${escapeHtml(entry.message)}${isActive ? " · Active on map" : ""}</span>
            <button class="upload-file-load" title="Load onto map" ${anyLoading ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button class="upload-file-fit" title="Fit map to data" ${entry.dataset ? "" : "disabled"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            </button>
            <button class="upload-file-rename" title="Rename (nickname shown in the hydrograph)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </button>
            <button class="upload-file-remove" title="Remove">&times;</button>
          </div>
        </div>
      `;
    })
    .join("");

  // A re-render mid-edit (another file finishing its load) rebuilt the input:
  // carry over what was typed so far and keep the caret in it.
  const input = list.querySelector(".upload-file-name-input");
  if (input) {
    if (draft !== null) input.value = draft;
    input.focus();
  }
  rerendering = false;
}

function updateDiffButton() {
  const aId = document.getElementById("diffASelect").value;
  const bId = document.getElementById("diffBSelect").value;
  document.getElementById("diffBtn").disabled = !aId || !bId || aId === bId;
}

// Rebuilds the A/B option lists from the currently loaded entries, trying to
// keep whatever was already selected if it's still valid.
function renderDiffControls() {
  const section = document.getElementById("diffSection");
  const loaded = files.filter((f) => f.status === "loaded" && f.dataset);

  const hint = document.getElementById("diffHint");
  const controls = document.getElementById("diffControls");
  if (loaded.length < 2) {
    hint.style.display = "block";
    controls.style.display = "none";
    document.getElementById("diffStatus").style.display = "none";
    document.getElementById("diffClearBtn").style.display = "none";
    return;
  }
  hint.style.display = "none";
  controls.style.display = "flex";

  const aSelect = document.getElementById("diffASelect");
  const bSelect = document.getElementById("diffBSelect");
  const prevA = aSelect.value;
  const prevB = bSelect.value;

  const options = loaded
    .map((f) => `<option value="${f.id}">${escapeHtml(displayName(f))}</option>`)
    .join("");
  aSelect.innerHTML = '<option value="">A: source</option>' + options;
  bSelect.innerHTML = '<option value="">B: source</option>' + options;

  if (loaded.some((f) => String(f.id) === prevA)) aSelect.value = prevA;
  if (loaded.some((f) => String(f.id) === prevB)) bSelect.value = prevB;

  updateDiffButton();
  document.getElementById("diffClearBtn").style.display = diffActive ? "flex" : "none";
}

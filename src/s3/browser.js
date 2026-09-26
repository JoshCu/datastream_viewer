// ====================================================================
// S3 browser UI: bucket/folder navigation, breadcrumb, file picker.
// ====================================================================
import { s3State } from "../state.js";
import { fetchS3Folders, listTrouteFileUrls } from "./client.js";
import { loadFile } from "../data/loader.js";
import { setStatus } from "../ui/panels.js";
import { escapeHtml } from "../ui/dom.js";
import { syncUrl } from "../ui/url.js";

// Reset the file picker back to "nothing chosen". Four call sites used to
// inline these three steps, and one of them had already drifted (it left the
// Load button enabled).
function clearFileSelection() {
  document.getElementById("fileSection").style.display = "none";
  document.getElementById("loadBtn").disabled = true;
  s3State.selectedFile = null;
}

// "Load latest" needs a model subfolder selected (outputs/<model>/…) to anchor
// the search from; it's disabled at the bucket/outputs root.
function canLoadLatest() {
  return s3State.pathSegments[0] === "outputs" && s3State.pathSegments.length >= 2;
}

export function setupS3Browser() {
  const urlParams = new URLSearchParams(window.location.search);
  const bucket = urlParams.get("bucket");
  const path = urlParams.get("path");

  document
    .getElementById("bucketSelect")
    .addEventListener("change", function () {
      s3State.used = true;
      s3State.currentBucket = this.value;
      s3State.pathSegments = ["outputs"];
      s3State.currentPath = "outputs/";
      clearFileSelection();
      setConusEnabled(false);

      if (s3State.currentBucket) {
        listS3Folder("outputs/");
      } else {
        renderFolderList([]);
        updateBreadcrumb();
      }
    });

  document.getElementById("fileSelect").addEventListener("change", (e) => {
    s3State.selectedFile = e.target.value;
    document.getElementById("loadBtn").disabled = !s3State.selectedFile;
  });

  document.getElementById("loadBtn").addEventListener("click", () => {
    if (s3State.selectedFile) loadFile(s3State.selectedFile);
  });

  document
    .getElementById("latestShortBtn")
    .addEventListener("click", () => loadLatest("short", "short range"));
  document
    .getElementById("latestMediumBtn")
    .addEventListener("click", () => loadLatest("medium", "medium range"));
  document
    .getElementById("latestAnalysisBtn")
    .addEventListener("click", () => loadLatest("analysis", "analysis assim"));

  if (bucket && path) {
    s3State.used = true;
    const cleanPath = path.replace(/\/$/, "");
    s3State.currentBucket = bucket;
    s3State.pathSegments = cleanPath.split("/");
    s3State.currentPath = cleanPath;
    clearFileSelection();
    handleFolderClick(path.replace(/\/?$/, "/"), "");
  } else if (s3State.currentBucket) {
    listS3Folder("outputs/");
  }
}

async function listS3Folder(prefix) {
  if (s3State.isLoading) return;

  s3State.isLoading = true;
  s3State.currentPath = prefix;
  setConusEnabled(false);

  const folderList = document.getElementById("folderList");
  folderList.innerHTML =
    '<div class="folder-loading"><div class="spinner"></div>Loading...</div>';

  updateBreadcrumb();

  try {
    const folders = await fetchS3Folders(prefix);
    renderFolderList(folders);
    setStatus("idle", `Found ${folders.length} folders`);
  } catch (error) {
    console.error("Error listing S3:", error);
    folderList.innerHTML =
      '<div class="folder-empty">Error loading folder</div>';
    setStatus("error", `Error: ${error.message}`);
  } finally {
    s3State.isLoading = false;
  }
}

async function listTrouteFiles(vpuPath) {
  setStatus("loading", "Loading T-Route files...");

  try {
    const urls = await listTrouteFileUrls(vpuPath);
    const files = urls.map((u) => ({ name: u.split("/").pop(), url: u }));

    const fileSection = document.getElementById("fileSection");
    const fileSelect = document.getElementById("fileSelect");
    const fileCount = document.getElementById("fileCount");

    fileSelect.innerHTML = '<option value="">Select a file...</option>';
    files.forEach((f) => {
      const option = document.createElement("option");
      option.value = f.url;
      option.textContent = f.name;
      fileSelect.appendChild(option);
    });

    if (files.length === 1) {
      fileSelect.value = files[0].url;
      document.getElementById("loadBtn").disabled = false;
      s3State.selectedFile = files[0].url;
    }

    fileCount.textContent = `${files.length} files`;
    fileSection.style.display = "block";

    setStatus("success", `Found ${files.length} T-Route files`);
  } catch (error) {
    console.error("Error listing T-Route files:", error);
    setStatus("error", `Error loading files: ${error.message}`);
  }
}

function renderFolderList(folders) {
  const folderList = document.getElementById("folderList");

  // A folder listing made entirely of VPU_* folders means we're at a cycle
  // level; enable the CONUS button to load them all at once.
  const vpuFolders = folders.filter((f) => /^VPU[_-]/i.test(f.name));
  if (folders.length > 0 && vpuFolders.length === folders.length) {
    s3State.vpuFolders = vpuFolders;
    setConusEnabled(true);
  } else {
    setConusEnabled(false);
  }

  if (folders.length === 0) {
    folderList.innerHTML = '<div class="folder-empty">No folders found</div>';
    return;
  }

  folderList.innerHTML = folders
    .map(
      (f) => `
                    <div class="folder-item folder" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                        </svg>
                        <span class="folder-item-name">${escapeHtml(f.name)}</span>
                    </div>
                `,
    )
    .join("");

  folderList.querySelectorAll(".folder-item").forEach((item) => {
    item.addEventListener("click", () => {
      s3State.used = true;
      handleFolderClick(item.dataset.path, item.dataset.name);
    });
  });
}

function handleFolderClick(path, name) {
  const pathParts = path.replace(/\/$/, "").split("/");
  const currentDepth = pathParts.length - 1;

  s3State.pathSegments = pathParts;
  const currentSegment = pathParts[currentDepth];

  if (currentSegment.split("_")[0] === "VPU") {
    // VPU level: list its t-route files.
    listTrouteFiles(path);
    document.getElementById("folderList").innerHTML =
      '<div class="folder-empty">VPU selected - choose a file above</div>';
    s3State.currentPath = path;
    updateBreadcrumb();
  } else {
    clearFileSelection();
    listS3Folder(path);
  }
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById("breadcrumb");

  if (!s3State.currentBucket) {
    breadcrumb.innerHTML =
      '<span class="breadcrumb-item active">Select a bucket</span>';
    setLatestEnabled(false);
    syncUrl();
    return;
  }

  setLatestEnabled(canLoadLatest());

  let html = `<span class="breadcrumb-item" data-index="0">${s3State.currentBucket}</span>`;
  s3State.pathSegments.forEach((segment, index) => {
    html += '<span class="breadcrumb-sep">/</span>';
    const isLast = index === s3State.pathSegments.length - 1;
    html += `<span class="breadcrumb-item ${isLast ? "active" : ""}" data-index="${index}">${segment}</span>`;
  });

  syncUrl();

  breadcrumb.innerHTML = html;

  breadcrumb
    .querySelectorAll(".breadcrumb-item:not(.active)")
    .forEach((item) => {
      item.addEventListener("click", () => {
        s3State.used = true;
        const index = parseInt(item.dataset.index, 10);
        s3State.pathSegments = s3State.pathSegments.slice(0, index + 1);
        s3State.currentPath = s3State.pathSegments.join("/") + "/";
        clearFileSelection();
        listS3Folder(s3State.currentPath);
      });
    });
}

function setConusEnabled(enabled) {
  document.getElementById("conusBtn").disabled = !enabled;
  if (!enabled) s3State.vpuFolders = [];
}

const LATEST_BTN_IDS = [
  "latestShortBtn",
  "latestMediumBtn",
  "latestAnalysisBtn",
];

function setLatestEnabled(enabled) {
  LATEST_BTN_IDS.forEach((id) => {
    document.getElementById(id).disabled = !enabled;
  });
}

// Folder-name classifiers for the run tree
//   outputs/<model>/<hydrofabric>/ngen.YYYYMMDD/<range>/<cycle>/VPU_*/
const isDateFolder = (name) => /\d{8}/.test(name); // ngen.20260720
const isRangeFolder = (name) => /_range$/i.test(name) || /^analysis/i.test(name);
const isCycleFolder = (name) => /^\d+$/.test(name); // 00, 06, 18
const isVpuFolder = (name) => /^VPU[_-]/i.test(name);
const dateKey = (name) => {
  const m = name.match(/(\d{8})/);
  return m ? parseInt(m[1], 10) : 0;
};

// "Load latest": from the selected model, drill to the most recent date, the
// requested forecast range, and its highest cycle, then land on that cycle's
// folder (which lists the VPUs and enables the CONUS button).
async function loadLatest(rangeKey, label) {
  if (s3State.isLoading) return;

  s3State.used = true;
  setLatestEnabled(false);
  setStatus("loading", `Finding latest ${label} run...`);

  try {
    const cyclePath = await resolveLatestCycle(rangeKey);
    const name = cyclePath.replace(/\/$/, "").split("/").pop();
    handleFolderClick(cyclePath, name);
  } catch (error) {
    console.error("Load latest error:", error);
    setStatus("error", `Error: ${error.message}`);
    // Re-enable if we're still at a model subfolder.
    setLatestEnabled(canLoadLatest());
  }
}

// Resolve the deepest cycle folder for `rangeKey`, starting from the selected
// model. Trailing run-specific segments (date/range/cycle/VPU) are trimmed off
// the current path first so re-clicking from a deep folder still re-resolves
// cleanly while honouring the chosen model + hydrofabric.
async function resolveLatestCycle(rangeKey) {
  const segs = s3State.pathSegments.slice();
  while (
    segs.length > 2 &&
    (isDateFolder(segs[segs.length - 1]) ||
      isRangeFolder(segs[segs.length - 1]) ||
      isCycleFolder(segs[segs.length - 1]) ||
      isVpuFolder(segs[segs.length - 1]))
  ) {
    segs.pop();
  }

  // Descend model → hydrofabric → date folders until a level that lists the
  // forecast-range folders (i.e. we're inside a specific ngen.YYYYMMDD).
  let prefix = segs.join("/") + "/";
  let dateContainer = null;
  for (let depth = 0; depth <= s3State.maxNavigationDepth; depth++) {
    const folders = await fetchS3Folders(prefix);
    if (folders.length === 0)
      throw new Error("No folders found while searching for runs");

    if (folders.some((f) => isRangeFolder(f.name))) {
      dateContainer = prefix;
      break;
    }

    const dates = folders.filter((f) => isDateFolder(f.name));
    if (dates.length) {
      dates.sort((a, b) => dateKey(a.name) - dateKey(b.name));
      prefix = dates[dates.length - 1].path;
      continue;
    }

    // Intermediate level (e.g. the hydrofabric folder): prefer a *_hydrofabric
    // entry, otherwise take the last folder alphabetically.
    const hf = folders.filter((f) => /_hydrofabric$/i.test(f.name));
    const pool = (hf.length ? hf : folders).slice();
    pool.sort((a, b) => a.name.localeCompare(b.name));
    prefix = pool[pool.length - 1].path;
  }
  if (!dateContainer)
    throw new Error("Could not locate dated run folders for this model");

  const ranges = await fetchS3Folders(dateContainer);
  const range = ranges.find((f) => f.name.toLowerCase().startsWith(rangeKey));
  if (!range)
    throw new Error(`No ${rangeKey} range in the latest run`);

  const cycles = (await fetchS3Folders(range.path)).filter((f) =>
    isCycleFolder(f.name),
  );
  if (cycles.length === 0)
    throw new Error(`No cycles found under ${range.name}`);
  cycles.sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10));
  const cyclePath = cycles[cycles.length - 1].path;

  // Medium range nests an ensemble-member folder (e.g. "1") between the cycle
  // and the VPUs. If the cycle folder doesn't list VPUs directly, drop into the
  // highest-numbered member (there's only one member running for now).
  const cycleFolders = await fetchS3Folders(cyclePath);
  if (cycleFolders.some((f) => isVpuFolder(f.name))) return cyclePath;
  const members = cycleFolders.filter((f) => isCycleFolder(f.name));
  if (members.length) {
    members.sort((a, b) => parseInt(a.name, 10) - parseInt(b.name, 10));
    return members[members.length - 1].path;
  }
  return cyclePath;
}

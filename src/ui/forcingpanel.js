// ====================================================================
// Forcings sidebar panel: pick a source (an S3 forcing cycle, or dropped
// files), load rows on demand, and drive the variable / scale / timestep of
// the catchment colouring.
//
// The panel owns only its DOM: it calls into forcing/loader.js and reacts to
// onForcingChange, the same way the t-route panels react to the active run.
// ====================================================================
import { forcingState, map } from "../state.js";
import {
  FORCING_BUCKET,
  FORCING_CONFIRM_BYTES,
  FORCING_CONFIRM_REQUESTS,
  FORCING_ROOT,
  PALETTE,
  SCALE_LABELS,
  forcingMeta,
  isValid,
} from "../config.js";
import { fetchS3Folders, listS3Level } from "../s3/client.js";
import {
  clearForcings,
  hasForcingSource,
  planViewportLoad,
  planVpuLoad,
  runLoadPlan,
  setForcingCycle,
  setForcingFiles,
  vpuFromName,
} from "../forcing/loader.js";
import { onForcingChange } from "../forcing/store.js";
import { applyForcingPaint, setForcingTimeIndex } from "../forcing/paint.js";
import { MIN_CATCHMENT_ZOOM } from "../forcing/viewport.js";
import { setStatus } from "./panels.js";
import { escapeHtml } from "./dom.js";

const PLAY_STEP_MS = 400;

const $ = (id) => document.getElementById(id);
let browsePath = FORCING_ROOT;
let listed = false;
let playTimer = null;

const status = (kind, text) => setStatus(kind, text, "forcing");

export function setupForcingPanel() {
  // List the bucket the first time the panel is opened (or straight away if
  // a link opened it), not on every page load.
  const panel = $("forcingPanel");
  const listOnce = () => {
    if (listed || panel.classList.contains("collapsed")) return;
    listed = true;
    browse(FORCING_ROOT);
  };
  panel.querySelector(".panel-title").addEventListener("click", () => setTimeout(listOnce));
  listOnce();

  panel.querySelectorAll("[data-forcing-latest]").forEach((btn) =>
    btn.addEventListener("click", () => loadLatest(btn.dataset.forcingLatest, btn.textContent.trim())),
  );

  const zone = $("forcingDrop");
  const input = $("forcingFileInput");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("dragover");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    useFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => {
    useFiles(input.files);
    input.value = "";
  });

  $("forcingViewportBtn").addEventListener("click", () =>
    runLoad(planViewportLoad, "catchments in view"),
  );
  $("forcingVpuBtn").addEventListener("click", () => runLoad(planVpuLoad, "VPU files in view"));
  $("forcingClearBtn").addEventListener("click", () => {
    clearForcings();
    status("idle", "Idle");
  });

  $("forcingVarSelect").addEventListener("change", (e) => {
    forcingState.variable = e.target.value;
    applyForcingPaint();
    updateLegend();
    updateHover();
  });
  $("forcingScaleSelect").addEventListener("change", (e) => {
    forcingState.scale = e.target.value;
    applyForcingPaint();
    updateLegend();
  });
  $("forcingTimeSlider").addEventListener("input", (e) =>
    setForcingTimeIndex(parseInt(e.target.value, 10)),
  );
  $("forcingStepBackBtn").addEventListener("click", () => step(-1));
  $("forcingStepFwdBtn").addEventListener("click", () => step(1));
  $("forcingPlayBtn").addEventListener("click", togglePlay);

  map.on("zoomend", syncButtons);
  onForcingChange(({ kind }) => {
    if (kind === "sources") {
      renderSource();
      syncButtons();
    } else if (kind === "run") {
      syncRun();
    } else if (kind === "rows") {
      updateLegend();
      renderSource();
      updateHover();
    } else if (kind === "time") {
      syncTime();
      updateHover();
    }
  });
  renderSource();
  syncButtons();
}

// ---- Sources -----------------------------------------------------------

async function useFiles(fileList) {
  const files = [...fileList].filter((f) => /\.(nc4?|h5|hdf5)$/i.test(f.name));
  if (!files.length) return;
  status("loading", `Reading ${files.length} file layout${files.length > 1 ? "s" : ""}…`);
  try {
    await setForcingFiles(files);
    const unknown = files.filter((f) => !vpuFromName(f.name)).length;
    status(
      "success",
      `${files.length} local file${files.length > 1 ? "s" : ""} ready` +
        (unknown ? ` (${unknown} without a VPU in the name)` : ""),
    );
  } catch (err) {
    console.error("Forcing file error:", err);
    status("error", `Error: ${err.message}`);
  }
}

// A readable name for a cycle folder: the path after the hydrofabric folder.
function cycleLabel(prefix) {
  const segs = prefix.split("/").filter(Boolean);
  const i = segs.findIndex((s) => /^ngen\.\d{8}$/.test(s));
  return (i >= 0 ? segs.slice(i) : segs.slice(1)).join("/");
}

async function browse(prefix) {
  browsePath = prefix;
  renderBreadcrumb();
  const list = $("forcingFolderList");
  list.innerHTML = '<div class="folder-loading"><div class="spinner"></div>Loading...</div>';
  try {
    const { folders, files } = await listS3Level(prefix, FORCING_BUCKET);
    if (browsePath !== prefix) return;
    // The ngen.YYYYMMDD folders list oldest first; newest on top is handier.
    if (folders.some((f) => /^ngen\.\d{8}$/.test(f.name))) folders.reverse();
    const vpuFiles = files.filter((f) => vpuFromName(f.name));
    renderFolders(folders, vpuFiles.length);
    if (vpuFiles.length) {
      const n = setForcingCycle(cycleLabel(prefix), vpuFiles.map((f) => f.url));
      status("success", `Cycle selected: ${n} VPU files. Load the viewport or a VPU.`);
    }
  } catch (err) {
    console.error("Forcing listing error:", err);
    list.innerHTML = '<div class="folder-empty">Error loading folder</div>';
    status("error", `Error: ${err.message}`);
  }
}

function renderBreadcrumb() {
  const segs = browsePath.split("/").filter(Boolean);
  const crumb = $("forcingBreadcrumb");
  crumb.innerHTML = segs
    .map((seg, i) => {
      const last = i === segs.length - 1;
      const path = segs.slice(0, i + 1).join("/") + "/";
      return (
        (i ? '<span class="breadcrumb-sep">/</span>' : "") +
        `<span class="breadcrumb-item${last ? " active" : ""}" data-path="${escapeHtml(path)}">${escapeHtml(seg)}</span>`
      );
    })
    .join("");
  crumb.querySelectorAll(".breadcrumb-item:not(.active)").forEach((el) =>
    el.addEventListener("click", () => browse(el.dataset.path)),
  );
}

function renderFolders(folders, vpuFileCount) {
  const list = $("forcingFolderList");
  const note = vpuFileCount
    ? `<div class="folder-empty">${vpuFileCount} VPU forcing files in this cycle</div>`
    : "";
  if (!folders.length) {
    list.innerHTML = note || '<div class="folder-empty">No folders found</div>';
    return;
  }
  list.innerHTML =
    note +
    folders
      .map(
        (f) => `
          <div class="folder-item folder" data-path="${escapeHtml(f.path)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span class="folder-item-name">${escapeHtml(f.name)}</span>
          </div>`,
      )
      .join("");
  list.querySelectorAll(".folder-item").forEach((el) =>
    el.addEventListener("click", () => browse(el.dataset.path)),
  );
}

const isDate = (name) => /^ngen\.\d{8}$/.test(name);
const isNumber = (name) => /^\d+$/.test(name);
const byNumberDesc = (a, b) => parseInt(b.name, 10) - parseInt(a.name, 10);

// forcings/<hydrofabric>/ngen.YYYYMMDD/forcing_<range>/<cycle>/[member/]
// → the newest cycle of `range` in the newest hydrofabric, looking back a few
// days in case today's run hasn't started that range yet.
async function resolveLatest(range) {
  const hfs = (await fetchS3Folders(FORCING_ROOT, FORCING_BUCKET))
    .filter((f) => /_hydrofabric$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!hfs.length) throw new Error("No hydrofabric folders under forcings/");
  const dates = (await fetchS3Folders(hfs.at(-1).path, FORCING_BUCKET))
    .filter((f) => isDate(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const date of dates.slice(0, 3)) {
    const ranges = await fetchS3Folders(date.path, FORCING_BUCKET);
    const r = ranges.find((f) => f.name === `forcing_${range}`);
    if (!r) continue;
    const cycles = (await fetchS3Folders(r.path, FORCING_BUCKET)).filter((f) => isNumber(f.name));
    for (const cycle of cycles.sort(byNumberDesc)) {
      const level = await listS3Level(cycle.path, FORCING_BUCKET);
      if (level.files.some((f) => vpuFromName(f.name))) return cycle.path;
      // An ensemble-member folder between the cycle and the files.
      const member = level.folders.filter((f) => isNumber(f.name)).sort(byNumberDesc)[0];
      if (member) return member.path;
    }
  }
  throw new Error(`No recent forcing_${range} cycle found`);
}

// Resolves true once the cycle is selected as the forcing source.
async function loadLatest(range, label) {
  status("loading", `Finding the latest ${label} forcing cycle…`);
  try {
    await browse(await resolveLatest(range));
  } catch (err) {
    console.error("Latest forcing error:", err);
    status("error", `Error: ${err.message}`);
  }
  return hasForcingSource();
}

// For the live sim's rain mode (sim/rain.js), which loads through this panel
// so its status line and buttons stay in step with the load.
export const loadLatestShortRange = () => loadLatest("short_range", "Short");
export const loadViewportForcings = (opts) => runLoad(planViewportLoad, "catchments in view", opts);

function renderSource() {
  const el = $("forcingSource");
  if (!hasForcingSource()) {
    el.textContent = "No forcing source selected";
    return;
  }
  const n = forcingState.files.size;
  const run = forcingState.run;
  const loaded = run ? ` · ${run.count.toLocaleString()} catchments loaded` : "";
  el.textContent = `${forcingState.sourceLabel} (${n} file${n > 1 ? "s" : ""})${loaded}`;
  el.title = forcingState.sourceLabel;
}

function syncButtons() {
  const has = hasForcingSource();
  const zoomOk = map.getZoom() >= MIN_CATCHMENT_ZOOM;
  const vp = $("forcingViewportBtn");
  vp.disabled = !has || forcingState.busy || !zoomOk;
  vp.title = zoomOk
    ? "Fetch the catchments currently on screen"
    : `Zoom in to level ${MIN_CATCHMENT_ZOOM} or closer to load catchments`;
  $("forcingVpuBtn").disabled = !has || forcingState.busy;
  $("forcingClearBtn").disabled = !has;
}

// ---- Loading -----------------------------------------------------------

function fmtBytes(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

const NOTHING = { rows: 0, requests: 0, bytes: 0 };

// Plan a load, check its size with the user when it's big, then run it.
// With `ask: false` a big load is skipped instead of asked about. Resolves
// true when the load ran (even if there was nothing new to fetch).
async function runLoad(makePlan, what, { ask = true } = {}) {
  if (forcingState.busy) return false;
  forcingState.busy = true;
  syncButtons();
  status("loading", `Planning ${what}…`);
  try {
    const plan = await makePlan();
    const big = plan.bytes > FORCING_CONFIRM_BYTES || plan.requests > FORCING_CONFIRM_REQUESTS;
    if (big && !ask) {
      status("idle", `Skipped loading ${what}: ${fmtBytes(plan.bytes)} is too much to fetch unasked`);
      return false;
    }
    if (
      big &&
      !confirm(
        `Loading ${what} means downloading about ${fmtBytes(plan.bytes)} in ` +
          `${plan.requests.toLocaleString()} requests. Continue?`,
      )
    ) {
      status("idle", "Load cancelled");
      return false;
    }
    status(
      "loading",
      plan.requests
        ? `Loading ${what}: ${fmtBytes(plan.bytes)} in ${plan.requests.toLocaleString()} requests…`
        : `Loading ${what}…`,
    );
    const s = plan.plans.length ? await runLoadPlan(plan) : { ...NOTHING, unmatched: plan.unmatched };
    const parts = [
      s.rows ? `${s.rows.toLocaleString()} catchments` : "nothing new to load",
      s.requests ? `${s.requests.toLocaleString()} requests` : null,
      s.bytes ? fmtBytes(s.bytes) : null,
    ].filter(Boolean);
    status("success", `Loaded ${parts.join(" · ")}` + (s.unmatched ? ` (${s.unmatched} not in any file)` : ""));
    return true;
  } catch (err) {
    console.error("Forcing load error:", err);
    status("error", `Error: ${err.message}`);
    return false;
  } finally {
    forcingState.busy = false;
    syncButtons();
  }
}

// ---- Run controls --------------------------------------------------------

function syncRun() {
  const run = forcingState.run;
  $("forcingControls").style.display = run ? "block" : "none";
  renderSource();
  if (!run) {
    stopPlay();
    return;
  }
  const select = $("forcingVarSelect");
  select.replaceChildren(
    ...run.variables.map((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      const { label, units } = forcingMeta(v);
      opt.textContent = units ? `${label} (${units})` : label;
      return opt;
    }),
  );
  select.value = forcingState.variable;
  $("forcingScaleSelect").value = forcingState.scale;
  $("forcingTimeSlider").max = Math.max(0, run.nTimes - 1);
  syncTime();
  updateLegend();
}

function syncTime() {
  const run = forcingState.run;
  if (!run) return;
  $("forcingTimeSlider").value = forcingState.timeIndex;
  const d = new Date(run.time[forcingState.timeIndex]);
  $("forcingTime").textContent = d.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function step(delta) {
  const run = forcingState.run;
  if (!run) return;
  const n = run.nTimes;
  setForcingTimeIndex((forcingState.timeIndex + delta + n) % n);
}

function togglePlay() {
  if (playTimer) stopPlay();
  else {
    playTimer = setInterval(() => step(1), PLAY_STEP_MS);
    $("forcingPlayBtn").classList.add("active");
  }
}

function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $("forcingPlayBtn").classList.remove("active");
}

// Legend bounds are shown in display units (the map works in file units).
function updateLegend() {
  const { run, variable, scale } = forcingState;
  if (!run || !variable) return;
  const meta = forcingMeta(variable);
  const b = run.bounds[variable];
  const show = (v) => (v * meta.scale + meta.offset).toFixed(2);
  const scaleNote = scale === "linear" ? "" : ` · ${SCALE_LABELS[scale]}`;
  $("forcingLegendTitle").textContent = `${meta.label}${meta.units ? ` (${meta.units})` : ""}${scaleNote}`;
  $("forcingLegendGradient").style.background = `linear-gradient(to right, ${PALETTE.join(", ")})`;
  $("forcingLegendMin").textContent = b ? show(b.min) : "–";
  $("forcingLegendMax").textContent = b ? show(b.max) : "–";
}

// ---- Hover readout -------------------------------------------------------

let hoveredId = null;

export function onForcingHover(e) {
  hoveredId = e.features?.[0]?.id ?? null;
  updateHover();
}

export function onForcingLeave() {
  hoveredId = null;
  updateHover();
}

function updateHover() {
  const el = $("forcingHover");
  const { run, variable, timeIndex } = forcingState;
  if (!run || hoveredId == null) {
    el.textContent = "Hover a catchment to read its value.";
    return;
  }
  const slot = run.index.get(hoveredId);
  const v = slot === undefined ? undefined : run.matrices[variable][slot * run.nTimes + timeIndex];
  const meta = forcingMeta(variable);
  el.textContent =
    v !== undefined && isValid(v)
      ? `cat-${hoveredId}: ${(v * meta.scale + meta.offset).toFixed(3)} ${meta.units}`
      : `cat-${hoveredId}: not loaded`;
}

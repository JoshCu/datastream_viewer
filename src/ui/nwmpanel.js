// ====================================================================
// NWM Forecast panel: pick a configuration / cycle (/ member), then load
// the reaches in view or all of CONUS as the active run (on the NWM
// flowlines). The file logic is in data/nwm.js; this owns the DOM.
//
// Each configuration's time stride and analysis window are its defaults in
// config.NWM_CONFIGS, not panel options. A viewport load takes whatever
// reaches the view's tiles hold, and the tiles already thin by stream order
// with zoom, so there's no order option either.
//
// URL: nwm=<config>/<YYYYMMDDHH>[/<member>]
// ====================================================================
import { map } from "../state.js";
import { NWM_CONFIGS, NWM_CONFIRM_BYTES, REACH_SETS } from "../config.js";
import { latestNwmCycle, loadNwmRun, nwmFiles, planNwmLoad } from "../data/nwm.js";
import { setNwmVisible } from "../map/interactions.js";
import { setStatus } from "./panels.js";
import { setUrlParam } from "./url.js";

const $ = (id) => document.getElementById(id);
const status = (kind, text) => setStatus(kind, text, "nwm");
// Above this much matrix memory, ask even when the download is small.
const CONFIRM_MEMORY_BYTES = 1024 * 1024 * 1024;

let busy = false;
let opened = false;

const pad = (n) => String(n).padStart(2, "0");

function fmtBytes(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// ---- Controls ↔ settings --------------------------------------------------

function config() {
  return NWM_CONFIGS[$("nwmConfig").value];
}

function cycleDate() {
  const day = $("nwmDate").value; // YYYY-MM-DD, UTC
  if (!day) return null;
  const d = new Date(`${day}T${pad(Number($("nwmHour").value))}:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function setCycle(d) {
  $("nwmDate").value = d.toISOString().slice(0, 10);
  $("nwmHour").value = String(d.getUTCHours());
}

function settings() {
  const cfg = config();
  return {
    config: $("nwmConfig").value,
    cycle: cycleDate(),
    member: cfg.members ? Number($("nwmMember").value) : 1,
    stride: cfg.stride,
    hours: cfg.hours,
    variables: $("nwmVelocity").checked ? ["flow", "velocity"] : ["flow"],
  };
}

// Rebuild the controls that depend on the configuration.
function syncConfigControls() {
  const cfg = config();
  $("nwmMemberRow").hidden = !cfg.members;
  if (cfg.members) {
    const current = $("nwmMember").value;
    $("nwmMember").replaceChildren(
      ...Array.from({ length: cfg.members }, (_, i) => new Option(`${i + 1}`, String(i + 1))),
    );
    if (Number(current) <= cfg.members) $("nwmMember").value = current;
  }
  $("nwmCycleLabel").textContent = cfg.analysis ? "Ending" : "Cycle";
  const hour = $("nwmHour").value;
  $("nwmHour").replaceChildren(
    ...Array.from({ length: 24 / cfg.every }, (_, i) => {
      const h = i * cfg.every;
      return new Option(`${pad(h)}z`, String(h));
    }),
  );
  const h = Number(hour);
  $("nwmHour").value = String(Number.isFinite(h) ? h - (h % cfg.every) : 0);
}

function writeUrl() {
  const s = settings();
  if (!s.cycle) return;
  const c = s.cycle;
  const stamp = `${c.getUTCFullYear()}${pad(c.getUTCMonth() + 1)}${pad(c.getUTCDate())}${pad(c.getUTCHours())}`;
  const member = config().members ? [s.member] : [];
  setUrlParam("nwm", [s.config, stamp, ...member].join("/"));
}

function readUrl() {
  const raw = new URLSearchParams(window.location.search).get("nwm");
  if (!raw) return false;
  const [key, stamp, member] = raw.split("/");
  if (!NWM_CONFIGS[key] || !/^\d{10}$/.test(stamp ?? "")) return false;
  $("nwmConfig").value = key;
  syncConfigControls();
  const d = new Date(
    Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10)),
  );
  setCycle(d);
  if (member) $("nwmMember").value = member;
  return true;
}

// ---- Actions ----------------------------------------------------------------

async function findLatest() {
  if (busy) return;
  const s = settings();
  busy = true;
  syncButtons();
  status("loading", `Looking for the newest ${config().label} cycle…`);
  try {
    const cycle = await latestNwmCycle(s.config, s.member);
    if (!cycle) {
      status("error", "No complete cycle found in the last few");
      return;
    }
    setCycle(cycle);
    writeUrl();
    status("idle", `Newest complete cycle: ${cycle.toISOString().slice(0, 13)}z`);
  } finally {
    busy = false;
    syncButtons();
  }
}

// Make sure the NWM flowline tiles for the view are loaded (turning the
// layer on, without saving that as the user's choice), then collect the
// COMIDs in them.
async function viewComids() {
  const { layer, feature } = REACH_SETS.nwm;
  const wasHidden = map.getLayoutProperty(layer, "visibility") === "none";
  if (wasHidden) setNwmVisible(true);
  if (wasHidden || !map.isSourceLoaded(feature.source) || !map.areTilesLoaded()) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30000);
      map.once("idle", () => {
        clearTimeout(timer);
        resolve();
      });
      map.triggerRepaint();
    });
  }
  const ids = new Set();
  for (const f of map.querySourceFeatures(feature.source, { sourceLayer: feature.sourceLayer })) {
    if (f.id != null) ids.add(f.id);
  }
  return [...ids];
}

function runLabel(s) {
  const cfg = NWM_CONFIGS[s.config];
  const when = s.cycle.toISOString().slice(0, 13).replace("T", " ") + "z";
  const member = cfg.members ? ` m${s.member}` : "";
  return `NWM ${s.config}${member} ${when}`;
}

// `scope` is "view" (the reaches in the view's tiles) or "conus" (all).
async function load(scope) {
  if (busy) return;
  const s = settings();
  if (!s.cycle) {
    status("error", "Pick a cycle first (or press Latest)");
    return;
  }
  writeUrl();
  busy = true;
  syncButtons();
  try {
    const files = nwmFiles(s);
    let comids = null;
    if (scope === "view") {
      status("loading", "Collecting the reaches in view…");
      comids = await viewComids();
      if (!comids.length) throw new Error("No NWM reaches in view");
    }
    status("loading", "Reading the reach list and file layout…");
    const plan = await planNwmLoad({ files, variables: s.variables, comids });
    const summary =
      `${files.length} files, about ${fmtBytes(plan.bytes)} to download and ` +
      `${fmtBytes(plan.memoryBytes)} in memory for ${plan.comids.length.toLocaleString()} reaches`;
    if (
      (plan.bytes > NWM_CONFIRM_BYTES || plan.memoryBytes > CONFIRM_MEMORY_BYTES) &&
      !confirm(`Loading ${runLabel(s)} means ${summary}. Continue?`)
    ) {
      status("idle", "Load cancelled");
      return;
    }
    status("loading", `Loading ${summary}…`);
    const r = await loadNwmRun(plan, {
      label: runLabel(s),
      fitView: false,
      onProgress: (done, total, bytes) =>
        status("loading", `Loading files ${done} / ${total} · ${fmtBytes(bytes)}`),
    });
    // The run is painted on the NWM flowlines: make sure they're showing.
    setNwmVisible(true);
    status(
      "success",
      `Loaded ${r.nRows.toLocaleString()} reaches × ${r.nTimes} steps · ${fmtBytes(r.bytes)}` +
        (r.missing ? ` (${r.missing} files missing)` : ""),
    );
  } catch (err) {
    console.error("NWM load error:", err);
    status("error", `Error: ${err.message}`);
  } finally {
    busy = false;
    syncButtons();
  }
}

function syncButtons() {
  $("nwmViewBtn").disabled = busy;
  $("nwmConusBtn").disabled = busy;
  $("nwmLatestBtn").disabled = busy;
}

export function setupNwmPanel() {
  $("nwmConfig").replaceChildren(
    ...Object.entries(NWM_CONFIGS).map(([key, cfg]) => new Option(cfg.label, key)),
  );
  syncConfigControls();
  const fromUrl = readUrl();

  $("nwmConfig").addEventListener("change", () => {
    syncConfigControls();
    writeUrl();
  });
  for (const id of ["nwmMember", "nwmDate", "nwmHour"]) {
    $(id).addEventListener("change", writeUrl);
  }
  $("nwmLatestBtn").addEventListener("click", findLatest);
  $("nwmViewBtn").addEventListener("click", () => load("view"));
  $("nwmConusBtn").addEventListener("click", () => load("conus"));

  // Find the newest cycle the first time the panel opens, unless a link
  // already named one.
  const panel = $("nwmPanel");
  const onOpen = () => {
    if (opened || panel.classList.contains("collapsed")) return;
    opened = true;
    if (!fromUrl && !cycleDate()) findLatest();
  };
  panel.querySelector(".panel-title").addEventListener("click", () => setTimeout(onOpen));
  onOpen();
}

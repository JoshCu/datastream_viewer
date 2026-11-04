// ====================================================================
// The sidebar's panel settings menu: show/hide each panel and rearrange them.
//
// The layout is saved in a cookie as the panel ids in display order, hidden
// ones prefixed with "-" (dataPanel.-varPanel.s3Panel...). No cookie means the
// order in index.html, all shown. The DOM is the live state: the menu's rows
// are rebuilt from it on opening, and saving reads it back.
//
// Hiding is a preference, not a lock. A hidden collapsible panel that something
// opens (a link's `open=`, the context menu's winds, erosion opening flow) shows
// while it's open, and goes away again when collapsed; see .panel-hidden in
// main.css. The checkbox keeps showing the preference.
// ====================================================================
import { stopPanelLayer } from "./panellayers.js";

const COOKIE = "panelLayout";
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const HIDDEN = "panel-hidden";

const $ = (id) => document.getElementById(id);

let container;
let defaultOrder; // Panel ids as index.html has them.

const panelElements = () => [...container.children].filter((el) => el.classList.contains("panel"));

// ---- Cookie ----------------------------------------------------------

function readCookie() {
  const prefix = `${COOKIE}=`;
  const entry = document.cookie.split("; ").find((c) => c.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function saveLayout() {
  const layout = panelElements()
    .map((el) => (el.classList.contains(HIDDEN) ? "-" : "") + el.id)
    .join(".");
  document.cookie = `${COOKIE}=${layout}; max-age=${COOKIE_MAX_AGE_S}; SameSite=Lax`;
}

// Saved ids in order, without any panel that no longer exists. A panel newer
// than the cookie goes after whichever panel it follows in index.html.
function savedOrder(tokens) {
  const order = tokens.map((t) => t.replace(/^-/, "")).filter((id) => defaultOrder.includes(id));
  defaultOrder.forEach((id, i) => {
    if (!order.includes(id)) order.splice(order.indexOf(defaultOrder[i - 1]) + 1, 0, id);
  });
  return order;
}

// ---- Applying a layout -----------------------------------------------

// Moves only the panels that have to move: moving a node resets any scrolled
// list inside it.
function applyOrder(ids) {
  let cursor = panelElements()[0];
  for (const id of ids) {
    const el = $(id);
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
}

function applySavedLayout() {
  const raw = readCookie();
  if (!raw) return;
  const tokens = raw.split(".");
  applyOrder(savedOrder(tokens));
  for (const token of tokens) {
    if (token.startsWith("-")) $(token.slice(1))?.classList.add(HIDDEN);
  }
  // Browsers cap a script-set cookie's lifetime (Brave 180 days, below the
  // max-age asked for), so renew it on each visit rather than only on a change.
  saveLayout();
}

function setPanelShown(panel, shown) {
  // Through the title, so the panel's own close handling runs (flow particles
  // stop, the flood map clears) rather than leaving it on with no way to reach it.
  if (!shown && panel.dataset.urlKey && !panel.classList.contains("collapsed")) {
    panel.querySelector(".panel-title").click();
  }
  // Started from its icon, it can be running with the panel collapsed.
  if (!shown) stopPanelLayer(panel.id);
  panel.classList.toggle(HIDDEN, !shown);
}

// ---- The menu --------------------------------------------------------

// The title's own text, leaving out its icon and collapse button.
function panelName(panel) {
  const title = panel.querySelector(".panel-title");
  const text = [...title.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  return text ? text.textContent.trim() : panel.id;
}

function buildRow(panel) {
  const name = panelName(panel);

  const row = document.createElement("li");
  row.className = "panel-settings-row";
  row.dataset.panel = panel.id;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "panel-settings-handle";
  handle.title = "Drag to move (or focus and use the arrow keys)";
  handle.setAttribute("aria-label", `Move ${name}`);
  handle.textContent = "⠿";
  setupRowMoves(row, handle);

  const label = document.createElement("label");
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = !panel.classList.contains(HIDDEN);
  check.addEventListener("change", () => {
    setPanelShown(panel, check.checked);
    saveLayout();
  });
  const icon = panel.querySelector(".panel-title svg").cloneNode(true);
  const text = document.createElement("span");
  text.textContent = name;
  label.append(check, icon, text);

  row.append(handle, label);
  return row;
}

function commitRowOrder() {
  applyOrder([...$("panelSettingsList").children].map((row) => row.dataset.panel));
  saveLayout();
}

// Rows move by moving their neighbours around the dragged one: taking the
// dragged row itself out of the DOM would release its pointer capture.
function setupRowMoves(row, handle) {
  const midY = (el) => {
    const box = el.getBoundingClientRect();
    return box.top + box.height / 2;
  };

  const onMove = (e) => {
    let next;
    while ((next = row.nextElementSibling) && e.clientY > midY(next)) row.before(next);
    let prev;
    while ((prev = row.previousElementSibling) && e.clientY < midY(prev)) row.after(prev);
  };
  const onEnd = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onEnd);
    handle.removeEventListener("pointercancel", onEnd);
    row.classList.remove("dragging");
    commitRowOrder();
  };
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.focus();
    handle.setPointerCapture(e.pointerId);
    row.classList.add("dragging");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  });

  handle.addEventListener("keydown", (e) => {
    const swap =
      e.key === "ArrowUp" ? row.previousElementSibling : e.key === "ArrowDown" ? row.nextElementSibling : null;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
    if (!swap) return;
    if (e.key === "ArrowUp") row.after(swap);
    else row.before(swap);
    commitRowOrder();
  });
}

function buildRows() {
  $("panelSettingsList").replaceChildren(...panelElements().map(buildRow));
}

function setMenuOpen(open) {
  if (open) buildRows();
  $("panelSettings").hidden = !open;
  $("panelSettingsBtn").setAttribute("aria-expanded", String(open));
}

function resetLayout() {
  document.cookie = `${COOKIE}=; max-age=0; SameSite=Lax`;
  applyOrder(defaultOrder);
  for (const panel of panelElements()) setPanelShown(panel, true);
  buildRows();
}

// Called first thing in init(), so the saved layout is in place before anything
// looks at the panels.
export function setupPanelSettings() {
  container = document.querySelector(".sidebar-content");
  defaultOrder = panelElements().map((el) => el.id);

  applySavedLayout();
  // Set by the inline script in index.html when there's a cookie to apply.
  document.documentElement.classList.remove("panel-layout-pending");

  const menu = $("panelSettings");
  const button = $("panelSettingsBtn");
  button.addEventListener("click", () => setMenuOpen(menu.hidden));
  $("panelSettingsReset").addEventListener("click", resetLayout);

  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) setMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || menu.hidden) return;
    setMenuOpen(false);
    button.focus();
  });
}

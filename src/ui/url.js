// ====================================================================
// Shareable URL: ?open=<panel keys>&bucket=<name>&path=<prefix>
//                &map=<zoom>/<lat>/<lng>[/<bearing>[/<pitch>]]&layers=<keys>
//
// `open` lists the collapsible panels (by their `data-url-key`) that are
// expanded, so a link reopens the same panels. `bucket`/`path` are only
// written while the S3 panel is open and the user has actually navigated it,
// so a plain visit doesn't pick up the default bucket. `map` is the camera,
// written after each move (MapLibre's own hash format); `layers` is owned by
// map/layerprefs.js.
// ====================================================================
import { s3State } from "../state.js";

const params = () => new URLSearchParams(window.location.search);

// Panel keys to open on load. A legacy `?bucket=&path=` link implies the S3
// panel, since that's what it was pointing at.
export function initialOpenPanels() {
  const p = params();
  const keys = new Set((p.get("open") || "").split(",").filter(Boolean));
  if (p.get("bucket") && p.get("path")) keys.add("s3");
  return keys;
}

// Rewrite the query string from the current panel + S3 state. replaceState,
// not pushState: nothing handles popstate, so history entries would only make
// the back button appear to do nothing.
export function syncUrl() {
  const url = new URL(window.location.href);
  const p = url.searchParams;

  const open = [
    ...document.querySelectorAll(".panel[data-url-key]:not(.collapsed)"),
  ].map((el) => el.dataset.urlKey);
  if (open.length) p.set("open", open.join(","));
  else p.delete("open");

  if (open.includes("s3") && s3State.used && s3State.currentBucket) {
    p.set("bucket", s3State.currentBucket);
    p.set("path", s3State.currentPath);
  } else {
    p.delete("bucket");
    p.delete("path");
  }

  replaceUrl(url);
}

// Set (or, for null, delete) one query parameter, leaving the rest alone.
export function setUrlParam(name, value) {
  const url = new URL(window.location.href);
  if (value == null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  replaceUrl(url);
}

function replaceUrl(url) {
  // Keep lists readable (open=s3,sim rather than open=s3%2Csim), and the
  // camera's slashes too.
  url.search = url.searchParams.toString().replace(/%2C/g, ",").replace(/%2F/g, "/");
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url);
  }
}

// ---- Camera ----------------------------------------------------------

// Map options for the camera in `map=`, or {} when it's absent or malformed.
export function initialMapView() {
  const raw = params().get("map");
  if (!raw) return {};
  const [zoom, lat, lng, bearing = 0, pitch = 0] = raw.split("/").map(Number);
  const ok = [zoom, lat, lng, bearing, pitch].every(Number.isFinite);
  if (!ok || Math.abs(lat) > 90) return {};
  return { zoom, center: [lng, lat], bearing, pitch };
}

export function syncMapView(map) {
  const zoom = map.getZoom();
  const { lng, lat } = map.getCenter().wrap();
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  // Enough decimals for about a pixel at this zoom (as MapLibre's hash does).
  const digits = Math.max(0, Math.ceil((zoom * Math.LN2 + Math.log(512 / 360 / 0.5)) / Math.LN10));
  const parts = [zoom.toFixed(2), lat.toFixed(digits), lng.toFixed(digits)];
  const round = (v) => String(Math.round(v * 10) / 10);
  if (bearing || pitch) parts.push(round(bearing));
  if (pitch) parts.push(round(pitch));
  setUrlParam("map", parts.join("/"));
}

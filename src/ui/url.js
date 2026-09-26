// ====================================================================
// Shareable URL: ?open=<panel keys>&bucket=<name>&path=<prefix>
//
// `open` lists the collapsible panels (by their `data-url-key`) that are
// expanded, so a link reopens the same panels. `bucket`/`path` are only
// written while the S3 panel is open and the user has actually navigated it,
// so a plain visit doesn't pick up the default bucket.
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

  // Keep the panel list readable (open=s3,sim rather than open=s3%2Csim).
  url.search = p.toString().replace(/%2C/g, ",");
  if (url.href !== window.location.href) {
    window.history.replaceState(window.history.state, "", url);
  }
}

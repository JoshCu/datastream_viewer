// ====================================================================
// S3 listing client — fetch + XML parsing only, no DOM.
// ====================================================================
import { s3State } from "../state.js";

// List the "folders" (CommonPrefixes) directly under a prefix.
export async function fetchS3Folders(prefix) {
  const url = `https://${s3State.currentBucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`;
  const response = await fetch(url);
  const text = await response.text();
  const xml = new DOMParser().parseFromString(text, "text/xml");

  const prefixes = xml.querySelectorAll("CommonPrefixes > Prefix");
  const folders = Array.from(prefixes).map((p) => {
    const fullPath = p.textContent;
    const parts = fullPath.replace(/\/$/, "").split("/");
    return { name: parts[parts.length - 1], path: fullPath, type: "folder" };
  });

  // The ngen.YYYYMMDD date folders directly under a hydrofabric folder come
  // back oldest-first (lexicographic); reverse so the most recent run is at
  // the top.
  const parentSegment = prefix.replace(/\/$/, "").split("/").pop();
  if (folders.length > 1 && /_hydrofabric$/i.test(parentSegment)) {
    folders.reverse();
  }

  return folders;
}

// List the .nc/.parquet t-route output file URLs under one VPU folder.
export async function listTrouteFileUrls(vpuPath) {
  const troutePath = vpuPath + "ngen-run/outputs/troute/";
  const url = `https://${s3State.currentBucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(troutePath)}`;
  const response = await fetch(url);
  const text = await response.text();
  const xml = new DOMParser().parseFromString(text, "text/xml");
  return Array.from(xml.querySelectorAll("Contents > Key"))
    .map((k) => k.textContent)
    .filter((f) => f.endsWith(".nc") || f.endsWith(".parquet"))
    .map((f) => `https://${s3State.currentBucket}.s3.amazonaws.com/${f}`);
}

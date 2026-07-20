// ====================================================================
// S3 listing client — fetch + XML parsing only, no DOM.
//
// Two endpoint kinds, because they have different constraints:
//
// * Object downloads (the heavy parquet/nc fetches) go through the CloudFront
//   distribution in CLOUDFRONT_BASE when one fronts the bucket. CloudFront
//   speaks HTTP/2, so every download multiplexes over a single connection with
//   no per-origin 6-socket cap — no domain sharding needed — and edge caching
//   makes repeat loads faster still. Buckets with no distribution fall back to
//   S3 (path-style REST endpoint).
//
// * Listings (?list-type=2) must go to the S3 REST endpoint: the CloudFront
//   origin is the S3 *website* endpoint, which serves objects only and returns
//   an HTML page for the ListBucket query, not ListBucketResult XML. Listings
//   still round-robin across a couple of distinct S3 hostnames (each gets its
//   own browser 6-socket pool) so the many small list requests during a CONUS
//   load don't serialize behind one origin's cap. S3 is HTTP/1.1 only.
// ====================================================================
import { s3State } from "../state.js";

// CloudFront distributions fronting a bucket (object downloads only). Anything
// not listed here falls back to S3.
const CLOUDFRONT_BASE = {
  "ciroh-community-ngen-datastream": "https://datastream.ciroh.org",
};

// Base URL for downloading a single object from `bucket`: CloudFront (HTTP/2)
// when available, else the S3 REST endpoint. `${base}/${key}` is the object.
function objectBase(bucket) {
  return CLOUDFRONT_BASE[bucket] ?? `https://s3.us-east-1.amazonaws.com/${bucket}`;
}

// S3 REST hostnames for listings. Distinct hosts → separate browser connection
// pools; `${base}/?<query>` is a listing.
function listBases(bucket) {
  return [
    `https://s3.us-east-1.amazonaws.com/${bucket}`,
    `https://s3.amazonaws.com/${bucket}`,
  ];
}

let shardCounter = 0;

// Next listing base in the round-robin for the current bucket.
function nextListBase() {
  const bases = listBases(s3State.currentBucket);
  return bases[shardCounter++ % bases.length];
}

// List the "folders" (CommonPrefixes) directly under a prefix.
export async function fetchS3Folders(prefix) {
  const url = `${nextListBase()}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`;
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

// List the .nc/.parquet t-route output file URLs under one VPU folder. The
// listing hits S3; the returned download URLs point at CloudFront (or the S3
// fallback) for the current bucket.
export async function listTrouteFileUrls(vpuPath) {
  const troutePath = vpuPath + "ngen-run/outputs/troute/";
  const url = `${nextListBase()}/?list-type=2&prefix=${encodeURIComponent(troutePath)}`;
  const response = await fetch(url);
  const text = await response.text();
  const xml = new DOMParser().parseFromString(text, "text/xml");
  const base = objectBase(s3State.currentBucket);
  return Array.from(xml.querySelectorAll("Contents > Key"))
    .map((k) => k.textContent)
    .filter((f) => f.endsWith(".nc") || f.endsWith(".parquet"))
    .map((f) => `${base}/${f}`);
}

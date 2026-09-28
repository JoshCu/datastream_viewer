// ====================================================================
// Forcing file layouts: which bytes hold which catchment rows.
//
// A layout ({ ids, variables }) is scanned once per file in a worker
// (data/workers/hdf5layout.js, ~1–2 MB of range reads) and cached in memory
// and IndexedDB keyed by the file URL. Offsets differ between files, even
// between forecast cycles of the same VPU, so the URL is the only safe key.
// Dropped local files are scanned every time (it's a local read).
// ====================================================================
import { runTask } from "../data/loader.js";

const DB_NAME = "datastream-viewer";
const STORE = "forcing-layouts";
// Each layout is mostly its id list (~300 kB for a VPU), so cap the cache.
const MAX_CACHED = 120;

const memory = new Map(); // url -> Promise<layout>

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE);
        store.createIndex("savedAt", "savedAt");
      };
      req.onsuccess = () => resolve(req.result);
      // No IndexedDB (private mode, blocked): just don't persist.
      req.onerror = () => resolve(null);
    });
  }
  return dbPromise;
}

async function dbGet(url) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
}

async function dbPut(url, layout) {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  store.put({ ids: layout.ids, variables: layout.variables, savedAt: Date.now() }, url);
  // Evict the oldest entries past the cap.
  const count = store.count();
  count.onsuccess = () => {
    let excess = count.result - MAX_CACHED;
    if (excess <= 0) return;
    store.index("savedAt").openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || excess-- <= 0) return;
      cursor.delete();
      cursor.continue();
    };
  };
}

async function scan(source) {
  const { ids, variables, skipped } = await runTask({ type: "forcingLayout", source });
  if (skipped.length) {
    console.warn("Forcing variables not range-readable (skipped):", skipped);
  }
  if (!Object.keys(variables).length) {
    throw new Error("No range-readable forcing variables in this file");
  }
  return { ids, variables };
}

function layoutFor(source) {
  if (source.file) return scan(source);
  let p = memory.get(source.url);
  if (!p) {
    p = (async () => {
      const cached = await dbGet(source.url);
      if (cached) return { ids: cached.ids, variables: cached.variables };
      const layout = await scan(source);
      dbPut(source.url, layout).catch(() => {});
      return layout;
    })();
    // A failed scan shouldn't poison the cache for a retry.
    p.catch(() => memory.delete(source.url));
    memory.set(source.url, p);
  }
  return p;
}

// Fill in a file entry's layout plus its lookup tables:
//   rowOf:  catchment id (number) -> row in the file
//   catIds: row -> catchment id (Int32Array)
//   loaded: per-row state, 0 = not loaded, 1 = in flight, 2 = loaded
// Ids that aren't "cat-<n>" can't match a map feature; they're counted and
// warned about rather than failing the file.
export async function ensureLayout(entry) {
  if (entry.layout) return entry;
  if (!entry.layoutPromise) {
    entry.layoutPromise = layoutFor(entry.source).then((layout) => {
      const n = layout.ids.length;
      const rowOf = new Map();
      const catIds = new Int32Array(n);
      let bad = 0;
      for (let r = 0; r < n; r++) {
        const m = /^cat-(\d+)$/.exec(layout.ids[r]);
        if (!m) {
          catIds[r] = -1;
          bad++;
          continue;
        }
        catIds[r] = Number(m[1]);
        rowOf.set(catIds[r], r);
      }
      if (bad) console.warn(`${entry.label}: ${bad} ids aren't cat-<n> and were ignored`);
      entry.layout = layout;
      entry.rowOf = rowOf;
      entry.catIds = catIds;
      entry.loaded = new Uint8Array(n);
      return entry;
    });
    entry.layoutPromise.catch(() => {
      entry.layoutPromise = null;
    });
  }
  return entry.layoutPromise;
}

// ====================================================================
// Hydrofabric index lookups (worker-side, pure): where is cat-N?
//
// hydrofabric_index.parquet has one row per hydrofabric feature (divides,
// flowpaths, nexus, lakes) with a representative lon/lat. It isn't sorted by
// id — every row group spans the whole id range — so finding one catchment
// means scanning the id column (~10 MB) once, kept as a sorted numeric table,
// then reading that one row's coordinates (~2 MB, one row group's chunks).
// Both go through HTTP Range requests; nothing is downloaded whole.
//
// `hyparquet` is the CDN module, injected by the worker.
// ====================================================================

export const HF_INDEX_URL =
  "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/hydrofabric_index.parquet";

let filePromise = null;
function indexFile(hyparquet) {
  if (!filePromise) {
    filePromise = hyparquet.asyncBufferFromUrl({ url: HF_INDEX_URL });
    filePromise.catch(() => {
      filePromise = null;
    });
  }
  return filePromise;
}

// Every catchment in the index: `nums` (N of cat-N, ascending) and the file
// row of each, for a binary search on the main thread.
export async function scanCatchmentIndex(hyparquet) {
  const file = await indexFile(hyparquet);
  const nums = [];
  const rows = [];
  await hyparquet.parquetRead({
    file,
    columns: ["id"],
    onChunk({ columnData, rowStart }) {
      for (let i = 0; i < columnData.length; i++) {
        const id = columnData[i];
        if (typeof id === "string" && id.startsWith("cat-")) {
          nums.push(Number(id.slice(4)));
          rows.push(rowStart + i);
        }
      }
    },
  });
  const order = Array.from(nums.keys()).sort((a, b) => nums[a] - nums[b]);
  return {
    nums: Int32Array.from(order, (i) => nums[i]),
    rows: Int32Array.from(order, (i) => rows[i]),
  };
}

// One index row's location: { lon, lat, vpuid }.
export async function readIndexRow(hyparquet, row) {
  const file = await indexFile(hyparquet);
  const [hit] = await hyparquet.parquetReadObjects({
    file,
    columns: ["lon", "lat", "vpuid"],
    rowStart: row,
    rowEnd: row + 1,
  });
  if (!hit) throw new Error(`Index row ${row} is missing`);
  return { lon: hit.lon, lat: hit.lat, vpuid: hit.vpuid };
}

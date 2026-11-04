// ====================================================================
// Hydrologic unit index lookups (worker-side, pure).
//
// hucindex.parquet (scripts/huc-index.js) has one row per unit, sorted by code:
// huc, name, and west / south / east / north in degrees (east > 180 for a unit
// across the antimeridian). Name search needs every name in the browser, so
// those two columns are read whole (~1 MB, ZSTD); a unit's bounds are read when
// it's picked, which costs one row group's chunks (~50 kB). All Range requests.
//
// `hyparquet` and `zstd` (zstddec) are injected by the worker.
// ====================================================================

export const HUC_INDEX_URL =
  "https://communityhydrofabric.s3.us-east-1.amazonaws.com/map/index/hucindex.parquet";

const decoders = (zstd) => ({ ZSTD: (input, outputLength) => zstd.decode(input, outputLength) });

// The footer is ~8 kB. hyparquet would fetch 512 kB of the file's tail to find it,
// in each worker of the pool. It fetches more itself if this is ever too little.
const FOOTER_FETCH_BYTES = 16 * 1024;

let opened = null; // Promise<{ file, metadata }>
function openIndex(hyparquet) {
  if (!opened) {
    opened = (async () => {
      const file = await hyparquet.asyncBufferFromUrl({ url: HUC_INDEX_URL });
      const metadata = await hyparquet.parquetMetadataAsync(file, { initialFetchSize: FOOTER_FETCH_BYTES });
      return { file, metadata };
    })();
    opened.catch(() => {
      opened = null;
    });
  }
  return opened;
}

// Every unit, in file order: { huc: [string], name: [string] }.
export async function readHucNames(hyparquet, zstd) {
  const out = { huc: [], name: [] };
  await hyparquet.parquetRead({
    ...(await openIndex(hyparquet)),
    columns: ["huc", "name"],
    compressors: decoders(zstd),
    onChunk({ columnName, columnData, rowStart }) {
      const column = out[columnName];
      for (let i = 0; i < columnData.length; i++) column[rowStart + i] = columnData[i];
    },
  });
  return out;
}

// One row's bounds: [west, south, east, north].
export async function readHucBounds(hyparquet, zstd, row) {
  const [hit] = await hyparquet.parquetReadObjects({
    ...(await openIndex(hyparquet)),
    columns: ["west", "south", "east", "north"],
    rowStart: row,
    rowEnd: row + 1,
    compressors: decoders(zstd),
  });
  if (!hit) throw new Error(`HUC index row ${row} is missing`);
  return [hit.west, hit.south, hit.east, hit.north].map(Number);
}

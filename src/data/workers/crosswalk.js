// ====================================================================
// NextGen ↔ NWM crosswalk (worker-side, pure).
//
// nextgen_nwm_crosswalk.parquet has one row per hydrofabric flowpath
// (828,288): nextgen_id (N of wb-N), nwm_feature_id (the NWM v3 COMID it
// lies on), in_nwm, nwm_outlet. Several flowpaths can split one NWM reach;
// exactly one per COMID is its outlet (`nwm_outlet`), the one carrying the
// reach's whole flow. ZSTD pages (hyparquet takes the decoder as a
// compressor). The file is 2.4 MB and the columns used are nearly all of
// it, so it's one GET: column-chunk Range reads came to 2.9 MB. The main
// thread keeps the result in IndexedDB (data/nwm.js).
//
// `hyparquet` and `zstd` (zstddec) are injected by the worker.
// ====================================================================

export const CROSSWALK_URL =
  "https://communityhydrofabric.s3.us-east-1.amazonaws.com/hydrofabrics/community/crosswalk/nextgen_nwm_crosswalk.parquet";

// The outlet flowpath of every COMID: { comids: Float64Array (ascending),
// wbs: Float64Array (the N of wb-N for each) }.
export async function readCrosswalk(hyparquet, zstd) {
  const res = await fetch(CROSSWALK_URL);
  if (!res.ok) throw new Error(`Crosswalk: HTTP ${res.status}`);
  const file = await res.arrayBuffer();
  const metadata = hyparquet.parquetMetadata(file);
  const n = Number(metadata.num_rows);
  const cols = {
    nextgen_id: new Float64Array(n),
    nwm_feature_id: new Float64Array(n),
    nwm_outlet: new Uint8Array(n),
  };
  await hyparquet.parquetRead({
    file,
    metadata,
    columns: Object.keys(cols),
    compressors: { ZSTD: (input, outputLength) => zstd.decode(input, outputLength) },
    onChunk({ columnName, columnData, rowStart }) {
      const out = cols[columnName];
      for (let i = 0; i < columnData.length; i++) out[rowStart + i] = Number(columnData[i]);
    },
  });
  const outlets = [];
  for (let i = 0; i < n; i++) if (cols.nwm_outlet[i]) outlets.push(i);
  outlets.sort((a, b) => cols.nwm_feature_id[a] - cols.nwm_feature_id[b]);
  return {
    comids: Float64Array.from(outlets, (i) => cols.nwm_feature_id[i]),
    wbs: Float64Array.from(outlets, (i) => cols.nextgen_id[i]),
  };
}

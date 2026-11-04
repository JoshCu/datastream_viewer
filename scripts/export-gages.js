#!/usr/bin/env bun
// Exports the viewer's USGS gage layer to a GeoPackage (EPSG:4326) for desktop
// GIS. Run with:
//   bun scripts/export-gages.js [out.gpkg]      (default dist/usgs_gages.gpkg)
//
// It's the same catalog the map draws (fetchUsgsCatalog: ~6 MB, a few seconds)
// and the same dam and network lists the panel filters on. Two point layers:
//
// usgs_gages: one row per site.
//   drainage_mi2, drainage_km2  null where USGS gives no area
//   por_begin, por_end, por_years  the site's whole span, over all its series
//   observes                    the types' labels, "; " separated
//   <type>_begin, <type>_end    the span per type (flow, stage, ...), null if
//                               the site doesn't observe it or USGS lists the
//                               series with no dates (`observes` still has it)
//   primary_type, color         the map dot with period "any time"
//   active_type, active_color   the map dot with period "recent" (the default),
//                               null for a site not reporting recently
//   dam_below_mi, no_dams, on_nextgen, on_nwm  the panel's dams/network filters
//
// usgs_gage_series: one row per (site, parameter), for filtering by parameter
// or by period the way the panel does (it tests each series, not the site).
//
// Periods are those of the continuous (instantaneous) record the layer is built
// from. That can start decades after a gage's daily record does (01013500's
// discharge: daily from 1903, continuous from 1990).
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { USGS_ACTIVE_WINDOW_MS, USGS_OBS_TYPES } from "../src/config.js";
import { fetchUsgsCatalog } from "../src/data/workers/usgscatalog.js";
import { damBelowMi, hasNoDams } from "../src/data/usgsdams.js";
import { isOnNetwork } from "../src/data/networkgages.js";

const OUT = resolve(process.argv[2] ?? new URL("../dist/usgs_gages.gpkg", import.meta.url).pathname);
if (!OUT.endsWith(".gpkg")) throw new Error(`Output must be a .gpkg file: ${OUT}`);

const MI2_TO_KM2 = 2.589988110336;
const YEAR_MS = 365.25 * 86400000;
const OTHER = USGS_OBS_TYPES.findIndex((t) => t.key === "other");

const isoDate = (ms) => (ms == null ? null : new Date(ms).toISOString().slice(0, 10));
const years = (begin, end) =>
  begin == null || end == null ? null : Math.round(((end - begin) / YEAR_MS) * 100) / 100;
const round = (value, digits) => (value == null ? null : Number(value.toFixed(digits)));

// ---- Rows -------------------------------------------------------------------

function buildRows({ fetchedAt, params, sites }) {
  const activeSince = fetchedAt - USGS_ACTIVE_WINDOW_MS;
  // A parameter with no name matches no type's regex.
  const typeOf = (p) => (params[p].type < 0 ? OTHER : params[p].type);
  const isActive = (end) => end != null && end >= activeSince;

  const gages = [];
  const series = [];
  for (const site of sites) {
    const no = site.id.slice(site.id.indexOf("-") + 1);
    const lonLat = [site.lon, site.lat];
    const spans = USGS_OBS_TYPES.map(() => null); // per type: { begin, end, active }
    let begin = null;
    let end = null;

    for (const [p, b, e] of site.series) {
      const t = typeOf(p);
      const span = (spans[t] ??= { begin: null, end: null, active: false });
      if (b != null && (span.begin == null || b < span.begin)) span.begin = b;
      if (e != null && (span.end == null || e > span.end)) span.end = e;
      span.active ||= isActive(e);
      if (b != null && (begin == null || b < begin)) begin = b;
      if (e != null && (end == null || e > end)) end = e;
      series.push({
        lonLat,
        site_id: site.id,
        site_no: no,
        name: site.name,
        parameter_code: params[p].code,
        parameter_name: params[p].name,
        units: params[p].units,
        obs_type: USGS_OBS_TYPES[t].key,
        begin_date: isoDate(b),
        end_date: isoDate(e),
        years: years(b, e),
        active: isActive(e),
      });
    }

    // Types are in priority order, as the map colours its dots.
    const seen = USGS_OBS_TYPES.filter((_, t) => spans[t]);
    const primary = seen[0];
    const active = USGS_OBS_TYPES.find((_, t) => spans[t]?.active);
    const row = {
      lonLat,
      site_id: site.id,
      site_no: no,
      name: site.name,
      site_type: site.siteType,
      state: site.state || null,
      lon: site.lon,
      lat: site.lat,
      drainage_mi2: site.area,
      drainage_km2: site.area == null ? null : round(site.area * MI2_TO_KM2, 2),
      por_begin: isoDate(begin),
      por_end: isoDate(end),
      por_years: years(begin, end),
      active: active != null,
      observes: seen.map((t) => t.label).join("; "),
      primary_type: primary?.key ?? null,
      color: primary?.color ?? null,
      active_type: active?.key ?? null,
      active_color: active?.color ?? null,
      dam_below_mi: damBelowMi(no),
      no_dams: hasNoDams(no),
      on_nextgen: isOnNetwork(no, "nextgen"),
      on_nwm: isOnNetwork(no, "nwm"),
    };
    USGS_OBS_TYPES.forEach((t, i) => {
      row[`${t.key}_begin`] = isoDate(spans[i]?.begin);
      row[`${t.key}_end`] = isoDate(spans[i]?.end);
    });
    gages.push(row);
  }
  return { gages, series };
}

const GAGE_COLUMNS = {
  site_id: "TEXT NOT NULL",
  site_no: "TEXT NOT NULL", // text: site numbers have leading zeros
  name: "TEXT",
  site_type: "TEXT",
  state: "TEXT",
  lon: "DOUBLE",
  lat: "DOUBLE",
  drainage_mi2: "DOUBLE",
  drainage_km2: "DOUBLE",
  por_begin: "DATE",
  por_end: "DATE",
  por_years: "DOUBLE",
  active: "BOOLEAN",
  observes: "TEXT",
  primary_type: "TEXT",
  color: "TEXT",
  active_type: "TEXT",
  active_color: "TEXT",
  ...Object.fromEntries(
    USGS_OBS_TYPES.flatMap((t) => [
      [`${t.key}_begin`, "DATE"],
      [`${t.key}_end`, "DATE"],
    ]),
  ),
  dam_below_mi: "DOUBLE",
  no_dams: "BOOLEAN",
  on_nextgen: "BOOLEAN",
  on_nwm: "BOOLEAN",
};

const SERIES_COLUMNS = {
  site_id: "TEXT NOT NULL",
  site_no: "TEXT NOT NULL",
  name: "TEXT",
  parameter_code: "TEXT NOT NULL",
  parameter_name: "TEXT",
  units: "TEXT",
  obs_type: "TEXT",
  begin_date: "DATE",
  end_date: "DATE",
  years: "DOUBLE",
  active: "BOOLEAN",
};

// ---- GeoPackage -------------------------------------------------------------

const SRS_ID = 4326;
const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]';

// A GeoPackage geometry blob: its 8-byte header (no envelope), then WKB.
function pointBlob([lon, lat]) {
  const bytes = new Uint8Array(29);
  const view = new DataView(bytes.buffer);
  bytes.set([0x47, 0x50, 0, 1]); // "GP", version 0, flags: little-endian, no envelope
  view.setInt32(4, SRS_ID, true);
  bytes[8] = 1; // WKB little-endian
  view.setUint32(9, 1, true); // WKB point
  view.setFloat64(13, lon, true);
  view.setFloat64(21, lat, true);
  return bytes;
}

function createGeoPackage(path) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA application_id = 1196444487"); // "GPKG"
  db.run("PRAGMA user_version = 10400"); // 1.4.0
  db.run(`CREATE TABLE gpkg_spatial_ref_sys (
    srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL,
    organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)`);
  const srs = db.prepare("INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)");
  srs.run("WGS 84 geodetic", SRS_ID, "EPSG", SRS_ID, WGS84_WKT, "longitude/latitude on WGS 84");
  srs.run("Undefined Cartesian SRS", -1, "NONE", -1, "undefined", null);
  srs.run("Undefined geographic SRS", 0, "NONE", 0, "undefined", null);
  db.run(`CREATE TABLE gpkg_contents (
    table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE,
    description TEXT DEFAULT '',
    last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
    srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id))`);
  db.run(`CREATE TABLE gpkg_geometry_columns (
    table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
    srs_id INTEGER NOT NULL REFERENCES gpkg_spatial_ref_sys(srs_id),
    z TINYINT NOT NULL, m TINYINT NOT NULL,
    PRIMARY KEY (table_name, column_name),
    FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name))`);
  return db;
}

function writeLayer(db, table, description, columns, rows) {
  const names = Object.keys(columns);
  const defs = names.map((name) => `"${name}" ${columns[name]}`).join(", ");
  db.run(`CREATE TABLE "${table}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom POINT NOT NULL, ${defs})`);

  const lons = rows.map((r) => r.lonLat[0]);
  const lats = rows.map((r) => r.lonLat[1]);
  db.prepare(
    `INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
     VALUES (?, 'features', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(table, table, description, Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), SRS_ID);
  db.prepare("INSERT INTO gpkg_geometry_columns VALUES (?, 'geom', 'POINT', ?, 0, 0)").run(table, SRS_ID);

  const insert = db.prepare(
    `INSERT INTO "${table}" (geom, ${names.map((n) => `"${n}"`).join(", ")})
     VALUES (?, ${names.map(() => "?").join(", ")})`,
  );
  db.transaction(() => {
    for (const row of rows) {
      insert.run(pointBlob(row.lonLat), ...names.map((n) => (typeof row[n] === "boolean" ? Number(row[n]) : row[n])));
    }
  })();
  db.run(`CREATE INDEX "${table}_site_no" ON "${table}" (site_no)`);
}

// ---- Run --------------------------------------------------------------------

const catalog = await fetchUsgsCatalog();
const { gages, series } = buildRows(catalog);

mkdirSync(dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });
const db = createGeoPackage(OUT);
const fetched = new Date(catalog.fetchedAt).toISOString().slice(0, 10);
const source = `USGS Water Data API combined-metadata, continuous values, fetched ${fetched}`;
writeLayer(db, "usgs_gages", `One row per site. ${source}`, GAGE_COLUMNS, gages);
writeLayer(db, "usgs_gage_series", `One row per site and parameter. ${source}`, SERIES_COLUMNS, series);
db.close();

console.log(`${gages.length} sites, ${series.length} series -> ${OUT}`);

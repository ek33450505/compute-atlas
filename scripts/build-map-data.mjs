/**
 * build-map-data.mjs
 *
 * Build-time data pipeline for map siting-context overlays. Fetches free US
 * geodata (water, transmission lines, drought), clips/simplifies it into
 * small committed static assets, and pre-computes per-facility "nearest
 * water" / "nearest transmission line" stats.
 *
 * The rendered water.geojson overlay comes from Natural Earth (50m rivers +
 * lakes — good for a small map layer, but far too coarse for per-facility
 * proximity: it only has major rivers/lakes, so "nearest water" against it
 * reports things like a Salton Sea 136mi away). The per-facility nearest-water
 * STAT instead queries USGS NHD (National Hydrography Dataset, public domain)
 * live per facility — NHD has fine-grained streams/ponds essentially
 * everywhere, giving credible short distances.
 *
 * Also builds two environmental context layers from live ArcGIS REST services
 * (WRI Aqueduct 4.0 water risk basins + USGS Principal Aquifers) — no GDAL,
 * no new deps, same paged-fetch/clip/simplify pattern as water/power/drought.
 * Aqueduct is GLOBAL (68k+ basin polygons) so its fetch uses a server-side US
 * envelope filter; both it and the aquifer layer feed per-facility fields in
 * siting-context.json via point-in-polygon lookup against the unsimplified
 * (pre-budget) US-clipped polygons.
 *
 * BUILD-TIME ONLY: the large source downloads (full HIFLD transmission set,
 * drought monitor snapshot, global Aqueduct basins, national aquifers) and
 * the per-facility NHD query responses are never written to disk — only the
 * small derived outputs below are committed:
 *
 *   public/data/water.geojson               (US-clipped 50m rivers + lakes overlay)
 *   public/data/power.geojson               (US-clipped >=230kV transmission overlay)
 *   public/data/drought.geojson             (simplified USDM snapshot overlay)
 *   public/data/water-stress.geojson        (WRI Aqueduct baseline water stress, US-clipped)
 *   public/data/groundwater-decline.geojson (WRI Aqueduct groundwater table decline, US-clipped)
 *   public/data/aquifers.geojson            (USGS Principal Aquifers, US-clipped)
 *   public/data/map-layers.json             (attribution + asOf manifest)
 *   public/data/hero-points.json            (homepage hero globe point set — see
 *                                             build-hero-points.mjs; local, no network)
 *   components/home/hero-plate-paths.ts     (homepage hero static Albers USA dot plate —
 *                                             see build-hero-plate.mjs; local, no network)
 *   public/data/pipeline-history.json       (per-quarter status composition — see
 *                                             build-pipeline-history.mjs; local, no network)
 *   data/siting-context.json                (per-facility nearest-water/-transmission +
 *                                             waterStress/groundwaterDecline/aquifer stats)
 *
 * Usage: node scripts/build-map-data.mjs [--skip-nhd]
 *   --skip-nhd  Skip the slow (~5min) live USGS NHD nearest-water pass and the
 *               water/power/drought overlay rebuild. Reuses the EXISTING
 *               data/siting-context.json's nearestWater/nearestTransmission
 *               fields and existing public/data/map-layers.json water/power/
 *               drought entries byte-for-byte, recomputing + merging in only
 *               the Aqueduct/aquifer fields and overlays. Use this to refresh
 *               environmental layers without re-running the full NHD pass.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import simplify from '@turf/simplify';
import bboxClip from '@turf/bbox-clip';
import pointToLineDistance from '@turf/point-to-line-distance';
import polygonToLine from '@turf/polygon-to-line';
import { lineString as turfLineString, point as turfPoint } from '@turf/helpers';

import { buildHeroPoints } from './build-hero-points.mjs';
import { buildHeroPlate } from './build-hero-plate.mjs';
import { buildPipelineHistory } from './build-pipeline-history.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const US_BBOX = [-179, 18, -66, 72]; // covers CONUS + AK + HI

const SOURCES = {
  water50Rivers: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson',
  water50Lakes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
  drought: 'https://droughtmonitor.unl.edu/data/json/usdm_current.json',
};

const HIFLD_TRANSMISSION_URL = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
const HIFLD_PAGE_SIZE = 2000;

// WRI Aqueduct 4.0 — Baseline Water Stress + Groundwater Table Decline, one
// shared HydroSHEDS PFAF6 basin-polygon layer (GLOBAL, 68,506 features), so
// the fetch uses a server-side US-envelope spatial filter. maxRecordCount=750.
const AQUEDUCT_URL = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/aqueduct_water_risk/FeatureServer/1/query';
const AQUEDUCT_PAGE_SIZE = 750;
// HydroSHEDS PFAF6 basins carry heavy coastal/island fragmentation (measured:
// avg ~13.5 disjoint MultiPolygon parts/feature, 90%+ of parts under ~12 km^2)
// that Douglas-Peucker tolerance alone can't simplify away (every part still
// needs its own minimum ~4-vertex ring) — dropTinyParts() trims those slivers
// from the RENDERED overlay only, never the unsimplified PIP candidate index.
const AQUEDUCT_MIN_PART_AREA_DEG2 = 0.06; // ~740 km^2 at the equator

// USGS Principal Aquifers — national aquifer-system polygons (3,010 features,
// public domain, 1:2,500,000 scale). maxRecordCount=2000.
const AQUIFERS_URL = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Aquifers_Feature_Layer_view/FeatureServer/0/query';
const AQUIFERS_PAGE_SIZE = 2000;

// USGS NHD (National Hydrography Dataset, public domain) — per-facility
// nearest-water lookup. We use the SMALL-SCALE (generalized) layers and
// restrict to NAMED features (GNIS_NAME present), which is the combination
// that yields a meaningful "nearest significant water body" signal:
//   - Layer 4  = Flowline - Small Scale (major rivers/streams, lines)
//   - Layer 10 = Waterbody - Small Scale (significant lakes/reservoirs, polygons)
// Rationale (verified against live queries across LA / NYC / Memphis / San
// Antonio / Ashburn): the LARGE-scale layers (6/12) are so dense they either
// return an unnamed drainage ditch 0.2mi away (useless as a "water source"
// datum) or blow past NHD's 2000-feature cap in metros and miss the actual
// major river. Natural Earth (the other extreme) is too coarse and misses
// local water entirely (LA -> "Salton Sea" 136mi). Small-scale + named lands
// in the middle: real, recognizable names at sensible distances (Memphis ->
// Nonconnah Creek 0.7mi, NYC -> Hudson River 0.9mi, LA -> Los Angeles River
// 0.5mi). Small-scale is sparse enough that the feature cap is never hit.
const NHD_BASE = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer';
const NHD_FLOWLINE_LAYER = 4;
const NHD_WATERBODY_LAYER = 10;
// Server-side filter to NAMED features only. NHD encodes "unnamed" as either
// NULL or a single space, so exclude both.
const NHD_NAMED_WHERE = "GNIS_NAME IS NOT NULL AND GNIS_NAME <> ' '";
// Ring sequence for the per-facility envelope search, in degrees (~69mi/deg).
// 0.15 deg (~10mi) captures any water within ~10mi at ring 0; the wider rings
// are a rural fallback. Small-scale + named is sparse, so no cap concern.
const NHD_RING_STEPS_DEG = [0.15, 0.4, 0.9, 1.8];
const NHD_REQUEST_DELAY_MS = 150;
const NHD_CONSECUTIVE_FAILURE_BUDGET = 10; // abort if the service looks down

// --- NHD mid-run throughput guard ------------------------------------------
// NHD_CONSECUTIVE_FAILURE_BUDGET counts FAILURES and resets to 0 on any
// success, so it is blind to a dependency that keeps answering successfully,
// every time, just far too slowly to finish. On 2026-09-23 a run's throughput
// decayed 0.83 -> 0.167 -> 0.006 facilities/sec and this guard never moved —
// too healthy to abort, too slow to finish. assessThroughput() (below, near
// computeSitingContext) asks the real question instead: can this run still
// complete inside the CI job budget? It is measured over a ROLLING window
// (elapsed time for the last NHD_THROUGHPUT_WINDOW facilities only), never a
// cumulative average since the run's start — a cumulative average is dragged
// up by a healthy warm-up and would hide exactly this kind of decay.
const NHD_THROUGHPUT_WINDOW = 50; // facilities per measurement window
const NHD_THROUGHPUT_GRACE = 100; // warm-up; do not judge before this many
const NHD_MAX_PROJECTED_HOURS = 5; // GitHub's default job cap is 6h and this
                                    // script sets no timeout-minutes, so a run
                                    // projected past this cannot land.

// Shared between the pre-flight abort (service down before any work starts)
// and the throughput-guard abort (service degrading mid-run) — both name the
// same documented recovery path, so the guidance text lives in one place.
const NHD_SKIP_FALLBACK_GUIDANCE = [
  'Documented fallback: re-run with --skip-nhd. That path makes no NHD calls,',
  'merges into the existing siting-context.json, and still fills',
  'waterStress/aquifer/groundwaterDecline for new records.',
  '',
  'PRICE OF --skip-nhd: it leaves nearestWater/nearestTransmission UNSET on',
  'new records, and nothing in the test suite goes red while that is',
  'outstanding (siting-context.test.ts asserts an ENTRY exists, not that it',
  'carries NHD fields). A full build:mapdata is still OWED once NHD is',
  'healthy — track it explicitly.',
];

// --- NHD pre-flight -------------------------------------------------------
// NHD_CONSECUTIVE_FAILURE_BUDGET cannot catch a degraded service: it only
// increments when BOTH layers fail for one facility and RESETS on any success,
// so intermittent failure keeps it near zero, and it counts failures while
// being blind to latency. On 2026-09-23 a run ground for ~6h to 1900/2167 with
// throughput decaying 0.83 -> 0.167 -> 0.006 facilities/sec and never aborted.
// The pre-flight answers the cheap question first: does a REAL query work now?
const NHD_PREFLIGHT_LAT = 39.1097; // Kansas, CONUS interior — dense named NHD coverage
const NHD_PREFLIGHT_LON = -95.0877;
// Ring 0 ONLY, deliberately: this is a fast liveness check, not a load test.
// KNOWN GAP: the build escalates through NHD_RING_STEPS_DEG (0.15/0.4/0.9/1.8)
// and the larger envelopes return far more geometry, so a service that is
// healthy at ring 0 but collapses at ring 3 PASSES this pre-flight. That is not
// the 2026-09-23 shape (total unavailability at every ring), so it does not
// undermine the check — but do not read a green pre-flight as "all rings fine".
// Mid-run degradation is a SEPARATE guard (see NHD_THROUGHPUT_WINDOW /
// assessThroughput below), because NHD_CONSECUTIVE_FAILURE_BUDGET resets on
// any success and counts failures while being blind to latency.
const NHD_PREFLIGHT_HALF_DEG = 0.15; // ring 0, the envelope the build uses most
// Fail in seconds, not minutes — this is a liveness probe, not build work.
const NHD_PREFLIGHT_TIMEOUT_MS = 12_000;
// Latency ceiling: a healthy ring-0 query returns in well under 1s (measured
// 473ms on a healthy service). 8s is ~17x that — comfortably clear of ordinary
// jitter, but far below the 14.5s responses seen while the service was degraded.
// Scoring slow-but-200 as a FAILURE is the whole point: today's run never
// aborted precisely because "eventually answered" was treated as success.
const NHD_PREFLIGHT_LATENCY_CEILING_MS = 8_000;

// One coordinate is a Bernoulli trial, not a measurement. On 2026-09-24, 3 of
// 6 spread CONUS coords timed out while others answered in under a second;
// the single-coord pre-flight above passed and the run then ground 2h05m
// before being cancelled. Spread these across distinct regions so a regional
// outage cannot hide behind one healthy probe. Used by preflightNHDQuorum(),
// which wraps preflightNHD() (kept above exactly as-is, as the single-
// coordinate primitive) into a sequential, fail-fast multi-coordinate check.
const NHD_PREFLIGHT_COORDS = [
  { label: 'KS interior',   lat: 39.1097,  lon: -95.0877  },
  { label: 'PA northeast',  lat: 41.5045,  lon: -75.5341  },
  { label: 'NC piedmont',   lat: 35.7796,  lon: -78.6382  },
  { label: 'AZ basin',      lat: 33.4484,  lon: -112.0740 },
  { label: 'OR Willamette', lat: 45.5152,  lon: -122.6784 },
];

const BUDGETS = {
  water: 1.5 * 1024 * 1024,
  power: 1.9 * 1024 * 1024, // stay comfortably under the ~2MB target
  drought: 1.5 * 1024 * 1024,
  waterStress: 1.5 * 1024 * 1024,
  groundwaterDecline: 1.5 * 1024 * 1024,
  aquifers: 1.5 * 1024 * 1024,
};

const ATTRIBUTIONS = {
  water: 'Natural Earth',
  power: 'HIFLD (ORNL/LANL/INL/NGA HSIP Team)',
  drought: 'U.S. Drought Monitor (NDMC / USDA / NOAA)',
  waterStress: 'WRI Aqueduct 4.0 (CC BY 4.0)',
  groundwaterDecline: 'WRI Aqueduct 4.0 (CC BY 4.0)',
  aquifers: 'USGS Principal Aquifers',
};

const NEAREST_CAP_MILES = 250;

const OUT_DIR = resolve(repoRoot, 'public', 'data');
const WATER_OUT = resolve(OUT_DIR, 'water.geojson');
const POWER_OUT = resolve(OUT_DIR, 'power.geojson');
const DROUGHT_OUT = resolve(OUT_DIR, 'drought.geojson');
const WATER_STRESS_OUT = resolve(OUT_DIR, 'water-stress.geojson');
const GROUNDWATER_DECLINE_OUT = resolve(OUT_DIR, 'groundwater-decline.geojson');
const AQUIFERS_OUT = resolve(OUT_DIR, 'aquifers.geojson');
const MANIFEST_OUT = resolve(OUT_DIR, 'map-layers.json');
const SITING_CONTEXT_OUT = resolve(repoRoot, 'data', 'siting-context.json');
const FACILITIES_PATH = resolve(repoRoot, 'data', 'facilities.json');

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
export async function fetchJSON(url, { label = url, retries = 1, timeoutMs = null } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // `timeoutMs` aborts the request itself rather than racing a timer beside
      // it: a hung socket that loses the race would otherwise keep running and
      // keep its connection open. Opt-in, so the long build path keeps its
      // existing (unbounded) patience unchanged.
      const res = await fetch(url, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      // ArcGIS REST services report failures in the response BODY with an HTTP
      // 200 status — e.g. `{"error":{"code":400,"message":"Unable to complete
      // operation."}}` — so `res.ok` alone cannot detect them. Undetected, this
      // silently nulled nearestWater on all 1,309 records on 2026-08-31.
      if (body && typeof body === 'object' && body.error) {
        const { code, message } = body.error;
        throw new Error(`ArcGIS error ${code}: ${message}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      console.error(`  [warn] fetch failed (attempt ${attempt + 1}/${retries + 1}) for ${label}: ${err.message}`);
    }
  }
  throw new Error(`Failed to fetch ${label} after ${retries + 1} attempt(s): ${lastErr?.message}`);
}

/**
 * Paged ArcGIS FeatureServer/query fetch.
 *
 * Back-compat form: fetchArcGISAll(baseUrl, whereClause, outFields, label)
 * Options-object form: fetchArcGISAll(baseUrl, { where, outFields, label,
 *   pageSize, geometryEnvelope }) — pageSize overrides HIFLD_PAGE_SIZE
 *   (needed for Aqueduct's 750 maxRecordCount); geometryEnvelope is a plain
 *   { xmin, ymin, xmax, ymax, spatialReference } object applied as a
 *   server-side esriGeometryEnvelope spatial filter (needed to cut Aqueduct's
 *   global 68,506 basins down to the US before paging).
 */
async function fetchArcGISAll(baseUrl, whereClauseOrOpts, outFieldsArg, labelArg) {
  let where, outFields, label, pageSize, geometryEnvelope;
  if (typeof whereClauseOrOpts === 'object' && whereClauseOrOpts !== null) {
    ({ where, outFields, label, pageSize = HIFLD_PAGE_SIZE, geometryEnvelope = null } = whereClauseOrOpts);
  } else {
    where = whereClauseOrOpts;
    outFields = outFieldsArg;
    label = labelArg;
    pageSize = HIFLD_PAGE_SIZE;
    geometryEnvelope = null;
  }

  let offset = 0;
  const allFeatures = [];
  for (;;) {
    let url = `${baseUrl}?where=${encodeURIComponent(where)}&outFields=${outFields}&resultRecordCount=${pageSize}&resultOffset=${offset}&f=geojson`;
    if (geometryEnvelope) {
      url += `&geometry=${encodeURIComponent(JSON.stringify(geometryEnvelope))}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
    }
    const data = await fetchJSON(url, { label: `${label} offset=${offset}`, retries: 1 });
    const features = data.features || [];
    allFeatures.push(...features);
    console.log(`  [${label}] offset=${offset} +${features.length} (total ${allFeatures.length})`);
    if (features.length === 0) break;
    // f=geojson nests the paging flag under `properties`, not top-level.
    const exceededTransferLimit = data.exceededTransferLimit ?? data.properties?.exceededTransferLimit;
    if (!exceededTransferLimit) break;
    offset += pageSize;
  }
  return allFeatures;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj));
}

function isEmptyGeometry(geometry) {
  if (!geometry) return true;
  const coords = geometry.coordinates;
  if (!coords || coords.length === 0) return true;
  return false;
}

/** Clip a single Feature to US_BBOX; returns null if fully outside. */
function clipToUSBBox(feature) {
  try {
    const clipped = bboxClip(feature, US_BBOX);
    if (isEmptyGeometry(clipped.geometry)) return null;
    return clipped;
  } catch {
    /* fake-success-ok: malformed/degenerate source geometry is dropped, not
       faked — null is filtered out by clipCollection(), never written to output. */
    return null;
  }
}

function clipCollection(features, label) {
  const out = [];
  for (const f of features) {
    const clipped = clipToUSBBox(f);
    if (clipped) out.push(clipped);
  }
  console.log(`  [${label}] clipped ${features.length} -> ${out.length} features within US bbox`);
  return out;
}

/** Escalate simplify tolerance until the FeatureCollection is under budgetBytes. */
function simplifyToBudget(fc, budgetBytes, label, startTolerance = 0.005, maxTolerance = 0.5) {
  let size = byteSize(fc);
  if (size <= budgetBytes) {
    console.log(`  [${label}] within budget unsimplified: ${(size / 1024).toFixed(0)} KB`);
    return { fc, tolerance: 0, size };
  }
  let tolerance = startTolerance;
  let working = fc;
  while (tolerance <= maxTolerance) {
    const clone = JSON.parse(JSON.stringify(fc));
    working = simplify(clone, { tolerance, highQuality: false, mutate: true });
    size = byteSize(working);
    console.log(`  [${label}] tolerance=${tolerance.toFixed(4)} -> ${(size / 1024).toFixed(0)} KB`);
    if (size <= budgetBytes) break;
    tolerance *= 1.7;
  }
  return { fc: working, tolerance, size };
}

/** Split a LineString/MultiLineString feature into individual LineString parts. */
function flattenToLineParts(feature) {
  const geom = feature.geometry;
  const parts = [];
  if (!geom) return parts;
  if (geom.type === 'LineString') {
    if (geom.coordinates.length >= 2) parts.push(turfLineString(geom.coordinates, feature.properties));
  } else if (geom.type === 'MultiLineString') {
    for (const coords of geom.coordinates) {
      if (coords.length >= 2) parts.push(turfLineString(coords, feature.properties));
    }
  }
  return parts;
}

/** Convert a Polygon/MultiPolygon feature to flattened LineString boundary parts. */
function polygonFeatureToLineParts(feature) {
  let converted;
  try {
    converted = polygonToLine(feature, { properties: feature.properties });
  } catch {
    /* fake-success-ok: a lake polygon that fails ring conversion is dropped
       from the nearest-water candidate index, not replaced with fabricated data. */
    return [];
  }
  const feats = converted.type === 'FeatureCollection' ? converted.features : [converted];
  const parts = [];
  for (const f of feats) parts.push(...flattenToLineParts(f));
  return parts;
}

function computeBBoxRec(coords, acc) {
  for (const c of coords) {
    if (Array.isArray(c[0])) {
      computeBBoxRec(c, acc);
    } else {
      const [x, y] = c;
      if (x < acc[0]) acc[0] = x;
      if (y < acc[1]) acc[1] = y;
      if (x > acc[2]) acc[2] = x;
      if (y > acc[3]) acc[3] = y;
    }
  }
}

function featureBBox(feature) {
  const acc = [Infinity, Infinity, -Infinity, -Infinity];
  computeBBoxRec(feature.geometry.coordinates, acc);
  return acc;
}

function bboxesIntersect(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Shoelace-formula ring area, in raw degree^2 units. A cheap, dependency-free
 * relative-size measure — not a real-world area unit, and only meaningful as
 * a same-CRS drop-tiny-parts filter (see dropTinyParts). */
function ringAreaDeg2(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
}

function polygonPartAreaDeg2(rings) {
  if (!rings.length) return 0;
  let area = ringAreaDeg2(rings[0]);
  for (let h = 1; h < rings.length; h++) area -= ringAreaDeg2(rings[h]);
  return Math.max(area, 0);
}

/**
 * Drop MultiPolygon parts below minAreaDeg2 (Polygon/single-part features are
 * untouched; a MultiPolygon feature is dropped entirely only if every part is
 * negligible). Only ever applied to an overlay meant for rendering — never to
 * an unsimplified candidate index used for per-facility point-in-polygon
 * lookup, where every real part must stay queryable.
 */
function dropTinyParts(fc, minAreaDeg2) {
  const out = [];
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g || g.type !== 'MultiPolygon') {
      out.push(f);
      continue;
    }
    const kept = g.coordinates.filter((rings) => polygonPartAreaDeg2(rings) >= minAreaDeg2);
    if (kept.length === 0) continue; // every part was a negligible fragment — drop the feature
    out.push({
      ...f,
      geometry: kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept },
    });
  }
  return { type: 'FeatureCollection', features: out };
}

/** Conservative bbox guaranteed to contain everything within capMiles of [lat,lon]. */
function searchBBoxFor(lat, lon, capMiles) {
  const padLat = (capMiles / 69) * 1.15;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.15);
  const padLon = Math.min((capMiles / (69 * cosLat)) * 1.15, 20);
  return [lon - padLon, lat - padLat, lon + padLon, lat + padLat];
}

/**
 * Island jurisdictions whose electric grids are ISOLATED — physically incapable
 * of connecting to a line outside their own bounding region.
 *
 * Why this exists. `nearestFromCandidates` is a straight-line computation with
 * no concept of REACHABILITY. That is correct everywhere in the contiguous US
 * and wrong the instant a record sits on an island: `epicio-st-croix-vi`
 * published "nearest >=230 kV transmission: 76 miles", measured across open
 * ocean to Puerto Rico's grid. St. Croix runs on WAPA's isolated island system
 * and no such interconnection exists. Geometrically true, semantically false,
 * and on a facility page it implies a grid relationship that is not there.
 *
 * ⛔ A DISTANCE THRESHOLD CANNOT FIX THIS, and the data says so. Measured over
 * the 1,704 records carrying a transmission distance: median 2.0 mi, p95 14.9,
 * p99 37.6, max 93.1. The mainland legitimately reaches 93.1 mi (MI), 69.1
 * (ME), 68.5 (TX), 66.6 (UT) — St. Croix's 76 sits INSIDE that range. Any cut
 * that suppresses 76 also suppresses four genuinely-reachable mainland
 * records. The defect is semantic, not numeric, so the fix has to be too.
 *
 * Membership is tested by bbox intersection against the candidate's own bbox,
 * which every candidate already carries. Verified against the real
 * `power.geojson` (10,483 features): St. Croix's match is a line bounded by
 * [-66.14, 18.00, -66.00, 18.05] — squarely in Puerto Rico, and disjoint from
 * VI's box — while the two PR records match a line at
 * [-66.46, 18.31, -66.14, 18.43], inside PR's box. The guard separates them
 * cleanly rather than by luck.
 *
 * ⚠️ ALASKA IS DELIBERATELY ABSENT. The Railbelt is a real interconnected
 * grid and the Anchorage records' 2.7 / 4.2 mi values are genuine; adding AK
 * would mean a bbox spanning a continent-sized state, which would exclude
 * nothing and only invite the belief that this list means "non-contiguous".
 * It means "isolated island system" — add a jurisdiction only when that is
 * true of it.
 *
 * ⚠️ The bounds below are grid-system extents, not political ones, and they
 * are the kind of constant that silently encodes whatever geography its author
 * happened to look at. A record outside every box is unaffected (the guard
 * only applies to states named here), so the failure mode of a too-small box
 * is a suppressed field, never a fabricated one.
 */
const ISLAND_GRID_BBOX = {
  PR: [-67.97, 17.86, -65.20, 18.54],
  VI: [-65.10, 17.62, -64.55, 18.44],
  GU: [144.55, 13.17, 145.02, 13.72],
  MP: [145.03, 14.05, 145.90, 15.35],
  HI: [-160.30, 18.85, -154.73, 22.30],
};

/**
 * Find nearest candidate (by exact pointToLineDistance) among bbox-prefiltered
 * parts. `regionBBox`, when given, additionally requires the candidate to lie
 * within that region — see ISLAND_GRID_BBOX for why distance alone is not a
 * sufficient test for an island record.
 *
 * `regionBBox` is annotated explicitly: without it TypeScript infers the
 * parameter as `null | undefined` from the default alone and every real
 * caller fails to typecheck.
 *
 * @param {number[]|null} [regionBBox]
 */
function nearestFromCandidates(pt, candidates, searchBBox, capMiles, regionBBox = null) {
  let best = null;
  for (const c of candidates) {
    if (!bboxesIntersect(c.bbox, searchBBox)) continue;
    if (regionBBox && !bboxesIntersect(c.bbox, regionBBox)) continue;
    let dist;
    try {
      dist = pointToLineDistance(pt, c.line, { units: 'miles' });
    } catch {
      /* fake-success-ok: a degenerate line part (e.g. <2 distinct points) is
         skipped for this candidate, not scored with a fabricated distance. */
      continue;
    }
    if (dist > capMiles) continue;
    if (!best || dist < best.dist) best = { dist, ...c.extra };
  }
  return best;
}

function buildCandidateIndex(features, extraFn) {
  const candidates = [];
  for (const f of features) {
    const parts = f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'
      ? polygonFeatureToLineParts(f)
      : flattenToLineParts(f);
    for (const line of parts) {
      candidates.push({ bbox: featureBBox(line), line, extra: extraFn(f) });
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// USGS NHD (per-facility nearest-water)
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastNHDRequestAt = 0;
/** Enforce a minimum gap between outbound NHD requests (be polite to the federal service). */
async function nhdPoliteDelay() {
  const elapsed = Date.now() - lastNHDRequestAt;
  if (elapsed < NHD_REQUEST_DELAY_MS) await sleep(NHD_REQUEST_DELAY_MS - elapsed);
  lastNHDRequestAt = Date.now();
}

/**
 * EDITORIAL overrides for upstream USGS NHD water-body names — NOT a data fix.
 *
 * Every so often the federal GNIS dataset renames a waterbody, and the project
 * deliberately does not adopt the rename. Keyed on the LOWERCASED, TRIMMED
 * upstream `GNIS_NAME` string (so upstream casing drift can't slip past it);
 * the value is the name we publish, in its correct casing.
 *
 * - "lake america" -> "Lake Ontario": USGS NHD now returns GNIS_NAME =
 *   "Lake America" for the waterbody off Barker, Niagara County NY (verified
 *   2026-09-01 via a direct query against
 *   hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/10). The site
 *   nearest that waterbody (terawulf-lake-mariner-ny) is on Lake Ontario, and
 *   the project publishes "Lake Ontario".
 *
 * MECHANICAL NOTE: this map is the ONLY thing standing between the upstream
 * name and published data. Removing an entry silently reintroduces the
 * upstream name on the next `build:mapdata` run, with no error.
 */
const GNIS_NAME_OVERRIDES = new Map([
  ['lake america', 'Lake Ontario'],
]);

/** Case-insensitive property lookup (NHD layers use inconsistent casing across layers). */
export { ISLAND_GRID_BBOX, nearestFromCandidates };

export function propGNISName(props) {
  const raw = props?.GNIS_NAME ?? props?.gnis_name ?? props?.GnisName ?? null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return GNIS_NAME_OVERRIDES.get(trimmed.toLowerCase()) ?? trimmed;
}

/** Ray-casting point-in-polygon (even-odd rule, holes supported). No new turf dep needed. */
function isPointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInPolygonGeometry(pt, geometry) {
  if (!geometry) return false;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const rings of polys) {
    if (!rings.length) continue;
    let inside = isPointInRing(pt, rings[0]);
    for (let h = 1; h < rings.length; h++) {
      if (isPointInRing(pt, rings[h])) inside = false; // hole
    }
    if (inside) return true;
  }
  return false;
}

/**
 * The exact query URL the build depends on. Shared with preflightNHD() on
 * purpose: a pre-flight that probes a DIFFERENT URL than the build is a false
 * green, which is precisely how the service root fooled us (2026-09-23 — root
 * metadata answered 200 in 307-441ms while every real query timed out or 502'd).
 */
function nhdQueryURL(layer, lat, lon, halfDeg) {
  const geometry = JSON.stringify({
    xmin: lon - halfDeg,
    ymin: lat - halfDeg,
    xmax: lon + halfDeg,
    ymax: lat + halfDeg,
    spatialReference: { wkid: 4326 },
  });
  return `${NHD_BASE}/${layer}/query?where=${encodeURIComponent(NHD_NAMED_WHERE)}&geometry=${encodeURIComponent(geometry)}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GNIS_NAME&returnGeometry=true&f=geojson`;
}

/** Query one NHD layer within an envelope around [lat,lon]. Returns { ok, features }. */
async function nhdQueryLayer(layer, lat, lon, halfDeg) {
  const url = nhdQueryURL(layer, lat, lon, halfDeg);
  await nhdPoliteDelay();
  try {
    const data = await fetchJSON(url, { label: `NHD layer ${layer} @ ${lat.toFixed(3)},${lon.toFixed(3)} D=${halfDeg}`, retries: 1 });
    return { ok: true, features: data.features || [] };
  } catch (err) {
    console.error(`  [warn] NHD layer ${layer} permanently failed at (${lat.toFixed(3)},${lon.toFixed(3)}) D=${halfDeg}: ${err.message}`);
    return { ok: false, features: [] };
  }
}

/**
 * Fail-fast liveness probe for USGS NHD, run before any expensive build work.
 *
 * Issues a REAL query against BOTH layers the build depends on — layer 4
 * (flowlines) and layer 10 (waterbodies) — because on 2026-09-23 layer 10
 * failed independently of layer 4, so probing one proves nothing about the
 * other. It never probes the service ROOT: root metadata answered HTTP 200 in
 * 307-441ms throughout that outage while every real query failed.
 *
 * Returns a structured result rather than throwing, so it is testable and the
 * caller owns the policy decision:
 *   { ok: boolean, results: [{ layer, ok, ms, error }] }
 *
 * `now` is injectable so the latency ceiling can be tested without sleeping.
 */
export async function preflightNHD({
  lat = NHD_PREFLIGHT_LAT,
  lon = NHD_PREFLIGHT_LON,
  halfDeg = NHD_PREFLIGHT_HALF_DEG,
  timeoutMs = NHD_PREFLIGHT_TIMEOUT_MS,
  latencyCeilingMs = NHD_PREFLIGHT_LATENCY_CEILING_MS,
  now = () => Date.now(),
} = {}) {
  /** One attempt at one layer. { ok } here means "answered with a valid shape", NOT "fast enough". */
  const probe = async (layer) => {
    const startedAt = now();
    try {
      // retries: 0 — a probe that retries is no longer fast, and a service that
      // needs a retry to answer one small query is exactly what we are catching.
      // (The ONE re-probe below is latency-only and deliberately not this.)
      const data = await fetchJSON(nhdQueryURL(layer, lat, lon, halfDeg), {
        label: `NHD pre-flight layer ${layer}`,
        retries: 0,
        timeoutMs,
      });
      // Liveness, not content: assert the geojson SHAPE, not that features were
      // found. An empty envelope is a legitimate answer; a missing `features`
      // array is not an answer at all.
      if (!data || !Array.isArray(data.features)) {
        throw new Error('response carried no `features` array');
      }
      return { answered: true, ms: now() - startedAt, error: null };
    } catch (err) {
      return { answered: false, ms: now() - startedAt, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const results = [];
  // Ring 0 only, both layers — see NHD_PREFLIGHT_HALF_DEG for the known gap
  // (a service that degrades only on the wider rings passes this probe).
  for (const layer of [NHD_FLOWLINE_LAYER, NHD_WATERBODY_LAYER]) {
    const first = await probe(layer);

    if (!first.answered) {
      // HARD failure (timeout, 502, no `features`). Never re-probed: a service
      // that is down must still fail in seconds, and retrying it restores
      // exactly the patience this check exists to remove.
      results.push({ layer, ok: false, ms: first.ms, error: first.error });
      continue;
    }

    if (first.ms <= latencyCeilingMs) {
      results.push({ layer, ok: true, ms: first.ms, error: null });
      continue;
    }

    // LATENCY-ONLY rejection: the query genuinely succeeded and was rejected
    // solely on the ceiling. A cold ArcGIS connection pool can make a first
    // query take seconds, so aborting on one sample would be a false abort — a
    // failure mode this pre-flight would itself have introduced. Re-probe ONCE
    // and take the faster of the two samples as the verdict.
    const second = await probe(layer);

    if (!second.answered) {
      results.push({
        layer,
        ok: false,
        ms: second.ms,
        error: `re-probe after a slow first attempt (${first.ms}ms) failed: ${second.error}`,
      });
      continue;
    }

    const ms = Math.min(first.ms, second.ms);
    if (ms <= latencyCeilingMs) {
      results.push({ layer, ok: true, ms, error: null });
      continue;
    }
    results.push({
      layer,
      ok: false,
      ms,
      error: `responded in ${ms}ms (faster of 2 attempts: ${first.ms}ms, ${second.ms}ms), over the ${latencyCeilingMs}ms ceiling (service degraded)`,
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

/**
 * Quorum wrapper around preflightNHD(): probes several geographically spread
 * coordinates (NHD_PREFLIGHT_COORDS) instead of one. preflightNHD() itself is
 * left completely unchanged above — this wraps it as the single-coordinate
 * primitive it already is.
 *
 * Sequential and FAIL-FAST: the first coordinate that fails stops the probe
 * immediately, without touching the rest. A service that cannot answer one
 * spread coordinate will not finish the multi-hour build either, and patience
 * is exactly what this check exists to remove. On a healthy service each
 * coordinate costs well under a second, so probing every coordinate in the
 * list costs a few seconds against a job measured in hours.
 *
 * `probe` is injectable (defaults to preflightNHD) so tests can stub it
 * directly instead of mocking the network; any extra options (`now`,
 * `timeoutMs`, etc.) are forwarded to every probe call.
 *
 * Returns { ok, results, failedAt }: `results` holds one entry per coordinate
 * ACTUALLY probed (in call order, stopping at the first failure), each
 * carrying that coordinate's per-layer results so an abort message can name
 * both the coordinate and the measured latency/error. `failedAt` is the
 * failing coordinate's label, or null when every probed coordinate passed.
 */
export async function preflightNHDQuorum({
  coords = NHD_PREFLIGHT_COORDS,
  probe = preflightNHD,
  ...opts
} = {}) {
  const results = [];
  for (const { label, lat, lon } of coords) {
    const outcome = await probe({ lat, lon, ...opts });
    results.push({ label, lat, lon, ok: outcome.ok, results: outcome.results });
    if (!outcome.ok) {
      return { ok: false, results, failedAt: label };
    }
  }
  return { ok: true, results, failedAt: null };
}

/**
 * Per-facility nearest water via live NHD queries: named small-scale flowlines
 * (rivers/streams, layer 4) and waterbodies (lakes/reservoirs, layer 10), expanding the search
 * ring until at least one feature is found. Returns { nearest, allFailed, absenceConfirmed }.
 *
 * `absenceConfirmed` says whether a null `nearest` can be trusted as genuine
 * absence, as opposed to a symptom of a failed query — a failed query returns
 * `features: []`, byte-identical to a real "nothing here" answer, so the two
 * are otherwise indistinguishable to the caller. It is scoped to the ring
 * where the loop CONCLUDES, not "any ring ever": the rings are strict spatial
 * supersets (each halfDeg step grows the same envelope around the same
 * point), so an early-ring failure followed by a clean wider-ring answer is
 * still a trustworthy "not found" — the wider query subsumes the narrower
 * failed one. Both layers must have succeeded at the terminating ring:
 * flowlines and waterbodies are disjoint feature sets, so a failed waterbody
 * query means lakes were never checked and absence is not established.
 */
export async function nearestWaterViaNHD(lat, lon) {
  const pt = turfPoint([lon, lat]);
  let anySuccess = false;

  for (let ring = 0; ring < NHD_RING_STEPS_DEG.length; ring++) {
    const halfDeg = NHD_RING_STEPS_DEG[ring];
    const flowRes = await nhdQueryLayer(NHD_FLOWLINE_LAYER, lat, lon, halfDeg);
    const waterRes = await nhdQueryLayer(NHD_WATERBODY_LAYER, lat, lon, halfDeg);
    if (flowRes.ok || waterRes.ok) anySuccess = true;
    const bothOk = flowRes.ok && waterRes.ok;

    const flow = flowRes.features;
    const water = waterRes.features;
    if (flow.length === 0 && water.length === 0) {
      if (ring < NHD_RING_STEPS_DEG.length - 1) continue; // expand and retry
      return { nearest: null, allFailed: !anySuccess, absenceConfirmed: bothOk };
    }

    let best = null;

    // Rivers: every returned flowline is already NAMED (server-side filter);
    // take the nearest.
    for (const f of flow) {
      const name = propGNISName(f.properties);
      for (const line of flattenToLineParts(f)) {
        let dist;
        try {
          dist = pointToLineDistance(pt, line, { units: 'miles' });
        } catch {
          /* fake-success-ok: degenerate flowline segment skipped, not scored. */
          continue;
        }
        if (!best || dist < best.dist) best = { dist, name, kind: 'river' };
      }
    }

    // Lakes/ponds: 0 if the point falls inside the polygon, else distance to boundary.
    for (const f of water) {
      const name = propGNISName(f.properties);
      if (isPointInPolygonGeometry([lon, lat], f.geometry)) {
        if (!best || best.dist > 0) best = { dist: 0, name, kind: 'lake' };
        continue;
      }
      for (const line of polygonFeatureToLineParts(f)) {
        let dist;
        try {
          dist = pointToLineDistance(pt, line, { units: 'miles' });
        } catch {
          /* fake-success-ok: degenerate waterbody boundary segment skipped. */
          continue;
        }
        if (!best || dist < best.dist) best = { dist, name, kind: 'lake' };
      }
    }

    // best === null here means features WERE returned but no segment could be
    // measured (every pointToLineDistance threw) — a measurement failure, not
    // a confirmed absence, so it must not clear good data.
    return { nearest: best, allFailed: false, absenceConfirmed: best !== null };
  }
  // Effectively dead: the last-ring iteration above always returns. Kept as a
  // fail-safe that never claims a confirmed absence.
  return { nearest: null, allFailed: !anySuccess, absenceConfirmed: false };
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------
async function buildWater() {
  console.log('\n=== Water (Natural Earth) ===');
  const [rivers50, lakes50] = await Promise.all([
    fetchJSON(SOURCES.water50Rivers, { label: 'water50Rivers' }),
    fetchJSON(SOURCES.water50Lakes, { label: 'water50Lakes' }),
  ]);
  console.log(`  fetched 50m rivers: ${rivers50.features.length} features, 50m lakes: ${lakes50.features.length} features`);

  const overlayRivers = clipCollection(rivers50.features, '50m rivers').map((f) => ({
    ...f,
    properties: { waterKind: 'river' },
  }));
  const overlayLakes = clipCollection(lakes50.features, '50m lakes').map((f) => ({
    ...f,
    properties: { waterKind: 'lake' },
  }));

  const overlayFC = { type: 'FeatureCollection', features: [...overlayRivers, ...overlayLakes] };
  const { fc: waterFC, tolerance: waterTolerance, size: waterSize } = simplifyToBudget(overlayFC, BUDGETS.water, 'water overlay');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(WATER_OUT, JSON.stringify(waterFC), 'utf8');

  // Per-facility nearest-water is computed separately via live USGS NHD
  // queries (nearestWaterViaNHD) — Natural Earth is too coarse for that stat.
  return { waterTolerance, waterSize };
}

// ---------------------------------------------------------------------------
// Power (transmission, >=230kV)
// ---------------------------------------------------------------------------
async function buildPower() {
  console.log('\n=== Power (HIFLD transmission >=230kV) ===');
  const rawFeatures = await fetchArcGISAll(HIFLD_TRANSMISSION_URL, 'VOLTAGE>=230', 'VOLTAGE,VOLT_CLASS,OWNER', 'HIFLD transmission');
  console.log(`  total transmission features: ${rawFeatures.length}`);

  const usFeatures = clipCollection(rawFeatures, 'transmission');

  const overlayFeatures = usFeatures
    .map((f) => {
      const voltage = Number(f.properties?.VOLTAGE ?? f.properties?.voltage);
      if (!Number.isFinite(voltage)) return null;
      return { ...f, properties: { voltage } };
    })
    .filter(Boolean);

  const overlayFC = { type: 'FeatureCollection', features: overlayFeatures };
  const { fc: powerFC, tolerance: powerTolerance, size: powerSize } = simplifyToBudget(overlayFC, BUDGETS.power, 'power overlay');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(POWER_OUT, JSON.stringify(powerFC), 'utf8');

  // Full-precision candidates (pre-simplify) for accurate siting-context distances
  const powerCandidates = buildCandidateIndex(overlayFeatures, (f) => ({ voltageKv: f.properties.voltage }));

  return { powerTolerance, powerSize, powerCandidates };
}

// ---------------------------------------------------------------------------
// Drought (US Drought Monitor snapshot)
// ---------------------------------------------------------------------------
async function buildDrought() {
  console.log('\n=== Drought (US Drought Monitor) ===');
  const raw = await fetchJSON(SOURCES.drought, { label: 'drought', retries: 1 });
  const features = raw.features || [];
  console.log(`  fetched ${features.length} drought polygons`);
  if (features.length > 0) {
    console.log(`  sample properties: ${JSON.stringify(features[0].properties)}`);
  }

  const sample = features[0]?.properties ?? {};
  const dateKeys = ['DATE', 'date', 'MapDate', 'mapdate', 'valid'];
  let asOf = null;
  for (const key of dateKeys) {
    if (sample[key]) {
      asOf = String(sample[key]);
      break;
    }
  }
  if (!asOf) asOf = new Date().toISOString().slice(0, 10);
  console.log(`  asOf date: ${asOf}`);

  const normalized = features
    .map((f) => {
      const props = f.properties ?? {};
      const dmRaw = props.DM ?? props.dm ?? props.Value ?? props.class;
      const dm = Number(dmRaw);
      if (!Number.isFinite(dm)) return null;
      return { ...f, properties: { dm } };
    })
    .filter(Boolean);

  const droughtFC = { type: 'FeatureCollection', features: normalized };
  const { fc: finalFC, tolerance: droughtTolerance, size: droughtSize } = simplifyToBudget(droughtFC, BUDGETS.drought, 'drought overlay', 0.01);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(DROUGHT_OUT, JSON.stringify(finalFC), 'utf8');

  return { droughtTolerance, droughtSize, asOf };
}

// ---------------------------------------------------------------------------
// Water Stress + Groundwater Decline (WRI Aqueduct 4.0)
// ---------------------------------------------------------------------------
async function buildAqueduct() {
  console.log('\n=== Water Stress + Groundwater Decline (WRI Aqueduct 4.0) ===');
  const usEnvelope = {
    xmin: US_BBOX[0],
    ymin: US_BBOX[1],
    xmax: US_BBOX[2],
    ymax: US_BBOX[3],
    spatialReference: { wkid: 4326 },
  };
  const rawFeatures = await fetchArcGISAll(AQUEDUCT_URL, {
    where: '1=1',
    outFields: 'bws_cat,bws_label,gtd_cat,gtd_label',
    label: 'Aqueduct basins (US envelope)',
    pageSize: AQUEDUCT_PAGE_SIZE,
    geometryEnvelope: usEnvelope,
  });
  console.log(`  total Aqueduct basin features (US envelope): ${rawFeatures.length}`);

  const usFeatures = clipCollection(rawFeatures, 'Aqueduct basins');

  // Full-precision (unsimplified, US-clipped) candidates for per-facility
  // point-in-polygon lookup — bbox-prefiltered before the exact PIP test.
  const aqueductCandidates = usFeatures.map((f) => ({ bbox: featureBBox(f), feature: f }));

  const waterStressFeatures = usFeatures
    .map((f) => {
      const cat = Number(f.properties?.bws_cat);
      if (!Number.isFinite(cat)) return null;
      return { ...f, properties: { bws_cat: cat } };
    })
    .filter(Boolean);
  const waterStressFCRaw = dropTinyParts({ type: 'FeatureCollection', features: waterStressFeatures }, AQUEDUCT_MIN_PART_AREA_DEG2);
  console.log(`  [water-stress overlay] dropped tiny parts: ${waterStressFeatures.length} -> ${waterStressFCRaw.features.length} features`);
  // Basin polygons stay vertex-dense well past the default 0.5 deg ceiling
  // (9k+ chunky basins), so raise maxTolerance for this coarse-zoom overlay.
  const { fc: waterStressFCOut, tolerance: waterStressTolerance, size: waterStressSize } =
    simplifyToBudget(waterStressFCRaw, BUDGETS.waterStress, 'water-stress overlay', 0.005, 5.0);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(WATER_STRESS_OUT, JSON.stringify(waterStressFCOut), 'utf8');

  const groundwaterFeatures = usFeatures
    .map((f) => {
      const cat = Number(f.properties?.gtd_cat);
      if (!Number.isFinite(cat)) return null;
      return { ...f, properties: { gtd_cat: cat } };
    })
    .filter(Boolean);
  const groundwaterFCRaw = dropTinyParts({ type: 'FeatureCollection', features: groundwaterFeatures }, AQUEDUCT_MIN_PART_AREA_DEG2);
  console.log(`  [groundwater-decline overlay] dropped tiny parts: ${groundwaterFeatures.length} -> ${groundwaterFCRaw.features.length} features`);
  const { fc: groundwaterFCOut, tolerance: groundwaterTolerance, size: groundwaterSize } =
    simplifyToBudget(groundwaterFCRaw, BUDGETS.groundwaterDecline, 'groundwater-decline overlay', 0.005, 5.0);
  writeFileSync(GROUNDWATER_DECLINE_OUT, JSON.stringify(groundwaterFCOut), 'utf8');

  return { waterStressTolerance, waterStressSize, groundwaterTolerance, groundwaterSize, aqueductCandidates };
}

// ---------------------------------------------------------------------------
// USGS Principal Aquifers
// ---------------------------------------------------------------------------
async function buildAquifers() {
  console.log('\n=== USGS Principal Aquifers ===');
  const rawFeatures = await fetchArcGISAll(AQUIFERS_URL, {
    where: '1=1',
    outFields: 'AQ_NAME,ROCK_NAME,AQ_CODE',
    label: 'USGS Principal Aquifers',
    pageSize: AQUIFERS_PAGE_SIZE,
  });
  console.log(`  total aquifer features: ${rawFeatures.length}`);

  const usFeatures = clipCollection(rawFeatures, 'aquifers');

  // Full-precision candidates for per-facility point-in-polygon lookup.
  const aquiferCandidates = usFeatures.map((f) => ({ bbox: featureBBox(f), feature: f }));

  const overlayFeatures = usFeatures
    .map((f) => {
      const aqName = f.properties?.AQ_NAME;
      if (!aqName) return null;
      return { ...f, properties: { aqName } };
    })
    .filter(Boolean);
  const overlayFC = { type: 'FeatureCollection', features: overlayFeatures };
  const { fc: aquifersFCOut, tolerance: aquifersTolerance, size: aquifersSize } =
    simplifyToBudget(overlayFC, BUDGETS.aquifers, 'aquifers overlay');
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(AQUIFERS_OUT, JSON.stringify(aquifersFCOut), 'utf8');

  return { aquifersTolerance, aquifersSize, aquiferCandidates };
}

/**
 * Per-facility environmental fields via bbox-prefiltered point-in-polygon
 * lookup against the unsimplified, US-clipped Aqueduct + aquifer candidates.
 * Honest omit: a field is left out entirely when the point falls outside
 * every candidate polygon, or when the matched basin/label is a non-signal
 * ("No Data" water stress, "Insignificant Trend" / -9999 groundwater decline)
 * — never fabricated.
 */
function environmentalFieldsForPoint(lat, lon, aqueductCandidates, aquiferCandidates) {
  const pt = [lon, lat];
  const ptBBox = [lon, lat, lon, lat];
  const fields = {};

  for (const c of aqueductCandidates) {
    if (fields.waterStress && fields.groundwaterDecline) break;
    if (!bboxesIntersect(c.bbox, ptBBox)) continue;
    if (!isPointInPolygonGeometry(pt, c.feature.geometry)) continue;
    const props = c.feature.properties ?? {};

    if (!fields.waterStress) {
      const cat = Number(props.bws_cat);
      const label = props.bws_label;
      if (Number.isFinite(cat) && typeof label === 'string' && label !== 'No Data') {
        fields.waterStress = { cat, label };
      }
    }
    if (!fields.groundwaterDecline) {
      const cat = Number(props.gtd_cat);
      const label = props.gtd_label;
      if (Number.isFinite(cat) && cat !== -9999 && typeof label === 'string' && label !== 'Insignificant Trend') {
        fields.groundwaterDecline = { cat, label };
      }
    }
  }

  for (const c of aquiferCandidates) {
    if (!bboxesIntersect(c.bbox, ptBBox)) continue;
    if (!isPointInPolygonGeometry(pt, c.feature.geometry)) continue;
    const props = c.feature.properties ?? {};
    if (props.AQ_NAME) {
      fields.aquifer = { name: props.AQ_NAME, rock: props.ROCK_NAME ?? null };
      break;
    }
  }

  return fields;
}

/** Compute waterStress/groundwaterDecline/aquifer fields for every facility. */
function computeEnvironmentalContext(facilities, aqueductCandidates, aquiferCandidates) {
  console.log('\n=== Siting context (environmental: water stress / groundwater decline / aquifers) ===');
  const result = {};
  let processed = 0;
  for (const facility of facilities) {
    const { lat, lon } = facility.location ?? {};
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const fields = environmentalFieldsForPoint(lat, lon, aqueductCandidates, aquiferCandidates);
    if (Object.keys(fields).length > 0) result[facility.id] = fields;
    processed++;
    if (processed % 100 === 0) console.log(`  ... ${processed}/${facilities.length} facilities processed`);
  }
  console.log(`  computed environmental context for ${Object.keys(result).length}/${facilities.length} facilities`);
  return result;
}

// ---------------------------------------------------------------------------
// Siting context (per-facility nearest water / transmission)
// ---------------------------------------------------------------------------

/**
 * Decide one facility's nearestWater, given a live lookup outcome and whatever
 * the existing siting-context.json holds for it.
 *
 * The gate is `absenceConfirmed`, NOT `allFailed`. `allFailed` is true only
 * when NO ring answered at all, but a query that fails only on the ring where
 * the loop concludes is just as untrustworthy: it returns `features: []`,
 * byte-identical to a genuine "nothing here" answer, so treating it as
 * authoritative silently clears a good value (2026-09-22) — and under
 * SCATTERED degradation this is the common case, not an edge case, since a
 * facility with no nearby water at ring 0 escalates into the larger, slower
 * queries most likely to fail. `absenceConfirmed !== true` is checked (not
 * `=== false`), so a malformed or missing field fails OPEN toward
 * preservation, matching this module's preserve-by-default bias. A lookup
 * that genuinely answered and found nothing (`absenceConfirmed: true`) is
 * different and authoritative — a corrected coordinate must still be able to
 * clear a stale value.
 *
 * Returns { value, carriedForward }. `value` is undefined when the entry should
 * carry no nearestWater at all.
 */
export function resolveNearestWater(waterOutcome, existingEntry) {
  if (waterOutcome.nearest) {
    return {
      value: {
        name: waterOutcome.nearest.name ?? null,
        kind: waterOutcome.nearest.kind,
        distanceMi: Math.round(waterOutcome.nearest.dist * 10) / 10,
      },
      carriedForward: false,
    };
  }
  if (waterOutcome.absenceConfirmed !== true && existingEntry?.nearestWater) {
    return { value: existingEntry.nearestWater, carriedForward: true };
  }
  return { value: undefined, carriedForward: false };
}

/**
 * Decide whether a run projected from the CURRENT measurement window can
 * still finish inside the job's time budget. Pure: takes measurements,
 * returns a verdict — no clock, no sleeping, fully testable (mirrors the
 * resolveNearestWater pattern above: policy lives in a pure function, the
 * caller owns wiring/timing).
 *
 * A RATE guard, deliberately, sitting BESIDE NHD_CONSECUTIVE_FAILURE_BUDGET
 * rather than replacing it: a failure-count guard is blind to a dependency
 * that answers correctly every time but ten times too slowly (2026-09-23:
 * 0.83 -> 0.006 facilities/sec, and the failure-count guard never moved).
 *
 * `windowElapsedMs` MUST be the elapsed time for THIS window only (a rolling
 * measurement) — a cumulative average since the run's start is dragged up by
 * a healthy warm-up and would hide exactly the decay this guard exists to
 * catch.
 *
 * Contract:
 *   - A non-finite or non-positive `windowElapsedMs` can't produce a rate at
 *     all (division by zero or worse) — never abort on a bad measurement.
 *   - `processed < graceFacilities` — warm-up: never JUDGE the run yet, but
 *     still report the measured rate so a caller can log it.
 *   - A zero (or non-finite) rate past the grace period means real time
 *     elapsed with NO progress — a stalled service. This is a hard abort
 *     (`ok: false`), not an accidental Infinity/NaN.
 *   - Otherwise: ratePerSec = windowSize / (windowElapsedMs / 1000),
 *     projectedHours = (total - processed) / ratePerSec / 3600,
 *     ok = projectedHours <= maxProjectedHours.
 */
export function assessThroughput({
  processed,
  total,
  windowElapsedMs,
  windowSize,
  graceFacilities,
  maxProjectedHours,
}) {
  if (!Number.isFinite(windowElapsedMs) || windowElapsedMs <= 0) {
    return { ok: true, ratePerSec: null, projectedHours: null };
  }

  const ratePerSec = windowSize / (windowElapsedMs / 1000);

  if (processed < graceFacilities) {
    return { ok: true, ratePerSec, projectedHours: null };
  }

  if (!Number.isFinite(ratePerSec) || ratePerSec <= 0) {
    // Elapsed real time with zero (or non-finite) progress is a stalled
    // service, not a bad measurement — abort outright rather than let the
    // division below produce Infinity/NaN and slip past the ok check by
    // accident.
    return { ok: false, ratePerSec: 0, projectedHours: Infinity };
  }

  const projectedHours = (total - processed) / ratePerSec / 3600;
  return { ok: projectedHours <= maxProjectedHours, ratePerSec, projectedHours };
}

/**
 * Roll the throughput measurement window.
 *
 * ROLLING, not cumulative, and that distinction is the whole guard:
 * assessThroughput() divides a FIXED windowSize by the elapsed time it is
 * handed, so an elapsed time that accumulates from the run's start makes the
 * computed rate decay on a perfectly healthy service and eventually aborts a
 * good run. Only the elapsed time of the LAST window describes the service's
 * current speed, which is what detects decay (2026-09-23: 0.83 -> 0.167 ->
 * 0.006 facilities/sec).
 *
 * Pure: no clock reads, no I/O — mirrors the assessThroughput/
 * resolveNearestWater pattern (the decision lives in a pure function, the
 * caller owns wiring/timing). Extracted specifically because this bookkeeping
 * used to live inline in computeSitingContext, where a mutation deleting the
 * `windowStartedAt = now()` reset failed zero tests — nothing exercised the
 * reset itself, only assessThroughput's math given already-correct inputs.
 *
 * Contract:
 *   - `isBoundary` is true only when `processed` is a POSITIVE multiple of
 *     `windowSize` (processed === 0 is never a boundary — the run must not
 *     judge before any work has happened).
 *   - `windowElapsedMs` is `nowMs - windowStartedAt`, computed ONLY at a
 *     boundary; `null` otherwise (not a meaningful measurement between
 *     boundaries — callers must not read it then).
 *   - `windowStartedAt` is the value the caller MUST carry forward: `nowMs`
 *     AT a boundary (the reset — this is the rolling property this function
 *     exists to guarantee), and the unchanged incoming `windowStartedAt`
 *     every other time. A caller that ignores this return value and keeps
 *     the original `windowStartedAt` reintroduces the cumulative-window bug.
 *   - `windowSize <= 0` can never define a real window: always
 *     `isBoundary: false`, `windowElapsedMs: null`, `windowStartedAt`
 *     unchanged — an inert no-op rather than a modulo/divide-by-zero risk.
 */
export function nextThroughputWindow({ processed, windowSize, windowStartedAt, nowMs }) {
  const isBoundary = windowSize > 0 && processed > 0 && processed % windowSize === 0;
  if (!isBoundary) {
    return { isBoundary: false, windowElapsedMs: null, windowStartedAt };
  }
  return { isBoundary: true, windowElapsedMs: nowMs - windowStartedAt, windowStartedAt: nowMs };
}

async function computeSitingContext(facilities, powerCandidates, existingContext = {}, { now = () => Date.now() } = {}) {
  console.log('\n=== Siting context (per-facility nearest water/transmission) ===');
  const result = {};
  let consecutiveNHDFailures = 0;
  let carriedForwardCount = 0;
  let unconfirmedAbsenceCount = 0;
  let processed = 0;
  let windowStartedAt = now(); // rolling — reset every NHD_THROUGHPUT_WINDOW facilities, never cumulative

  // Pre-filter to facilities with usable coordinates ONCE, before the loop,
  // rather than skipping inline (via `continue`) and reconciling a separate
  // skip counter against `facilities.length` afterwards. A tracked skip
  // counter is two numbers that can drift apart again; filtering once removes
  // the possibility of drift structurally. This matters because `total` below
  // feeds assessThroughput's `remaining = total - processed` — handing it the
  // RAW facilities.length (which includes facilities that are never
  // processed because they lack coordinates) understates completed progress
  // and overstates remaining work, biasing the guard toward projecting a
  // longer finish and aborting a run that would have completed fine. A false
  // abort is worse than no guard: the first one teaches everyone watching the
  // pipeline to ignore it. Dormant today (0 of the live dataset lacks
  // coordinates) but latent otherwise.
  const sitedFacilities = facilities.filter((facility) => {
    const { lat, lon } = facility.location ?? {};
    return typeof lat === 'number' && typeof lon === 'number';
  });

  for (const facility of sitedFacilities) {
    const { lat, lon } = facility.location ?? {};
    const pt = turfPoint([lon, lat]);
    const searchBBox = searchBBoxFor(lat, lon, NEAREST_CAP_MILES);

    const waterOutcome = await nearestWaterViaNHD(lat, lon);
    if (waterOutcome.allFailed) {
      consecutiveNHDFailures++;
      if (consecutiveNHDFailures >= NHD_CONSECUTIVE_FAILURE_BUDGET) {
        throw new Error(
          `USGS NHD service appears unreachable: ${consecutiveNHDFailures} consecutive facilities failed both layers`
        );
      }
    } else {
      consecutiveNHDFailures = 0;
    }
    // Scale-of-degradation signal, independent of whether a prior value
    // existed to carry forward: a facility with no water AND no confirmed
    // absence is one we could not verify this run, full stop.
    if (!waterOutcome.nearest && waterOutcome.absenceConfirmed !== true) {
      unconfirmedAbsenceCount++;
    }

    // An isolated island grid cannot reach a line outside its own system, no
    // matter how close the straight line makes it look. Undefined for every
    // mainland state, which leaves their behaviour byte-identical.
    const islandBBox = ISLAND_GRID_BBOX[facility.location?.state] ?? null;
    const nearestTransmission = nearestFromCandidates(
      pt,
      powerCandidates,
      searchBBox,
      NEAREST_CAP_MILES,
      islandBBox
    );

    const entry = {};
    const { value: nearestWater, carriedForward } = resolveNearestWater(
      waterOutcome,
      existingContext[facility.id]
    );
    if (nearestWater !== undefined) {
      entry.nearestWater = nearestWater;
      if (carriedForward) carriedForwardCount++;
    }
    if (nearestTransmission) {
      entry.nearestTransmission = {
        voltageKv: nearestTransmission.voltageKv,
        distanceMi: Math.round(nearestTransmission.dist * 10) / 10,
      };
    }
    if (Object.keys(entry).length > 0) {
      result[facility.id] = entry;
    }

    processed++;
    if (processed % 50 === 0) console.log(`  ... ${processed}/${sitedFacilities.length} facilities processed`);

    const windowRoll = nextThroughputWindow({
      processed,
      windowSize: NHD_THROUGHPUT_WINDOW,
      windowStartedAt,
      nowMs: now(),
    });
    // Unconditional and load-bearing: nextThroughputWindow returns
    // windowStartedAt UNCHANGED except at a boundary, where it returns the
    // reset value — this single assignment IS the rolling-window property
    // (see nextThroughputWindow's doc comment). Dropping this line
    // reintroduces the cumulative-from-start bug at the wiring layer instead
    // of inside the pure function.
    windowStartedAt = windowRoll.windowStartedAt;

    if (windowRoll.isBoundary) {
      const assessment = assessThroughput({
        processed,
        total: sitedFacilities.length,
        windowElapsedMs: windowRoll.windowElapsedMs,
        windowSize: NHD_THROUGHPUT_WINDOW,
        graceFacilities: NHD_THROUGHPUT_GRACE,
        maxProjectedHours: NHD_MAX_PROJECTED_HOURS,
      });
      if (assessment.ratePerSec !== null) {
        const projectedStr = assessment.projectedHours !== null
          ? `, projected ${Number.isFinite(assessment.projectedHours) ? assessment.projectedHours.toFixed(2) : 'unbounded'}h to finish`
          : '';
        console.log(`  [throughput] window rate ${assessment.ratePerSec.toFixed(4)}/sec${projectedStr}`);
      }
      if (!assessment.ok) {
        throw new Error(
          [
            '',
            `NHD throughput guard FAILED — measured ${assessment.ratePerSec.toFixed(4)} facilities/sec`,
            `over the last ${NHD_THROUGHPUT_WINDOW} facilities, projecting ${
              Number.isFinite(assessment.projectedHours) ? assessment.projectedHours.toFixed(1) : 'unbounded'
            } more hours to process the remaining ${sitedFacilities.length - processed} of ${sitedFacilities.length}`,
            `facilities (${processed} processed so far).`,
            '',
            'USGS NHD is answering but too slowly for this run to land inside the CI job',
            'budget. Do NOT retry the full pass — this is the same degraded-service shape',
            'that let a run grind for 6h and still lose data.',
            '',
            ...NHD_SKIP_FALLBACK_GUIDANCE,
          ].join('\n'),
        );
      }
    }
  }
  // M is deliberately `facilities.length` here (the full input), not
  // `sitedFacilities.length` (the progress log's denominator, scoped to what
  // this run actually iterated) — this line reports dataset coverage: how
  // much of everything on disk has a siting-context entry, including any
  // facility that can never get one because it has no coordinates. That is a
  // different question from "how far did this run get through its own
  // queue", which is what the progress log answers. Not silently
  // inconsistent with it — they measure different things, and this comment
  // says so.
  console.log(`  computed siting context for ${Object.keys(result).length}/${facilities.length} facilities`);
  if (carriedForwardCount > 0) {
    console.log(
      `  preserved nearestWater for ${carriedForwardCount} facilities whose live NHD lookup failed (degraded run — values carried forward from the existing siting-context.json, not freshly verified)`
    );
  }
  if (unconfirmedAbsenceCount > 0) {
    // States the SCALE of the degradation, not just the saves: carriedForwardCount
    // is the subset of this that had a prior value to preserve. The remainder
    // recorded no nearestWater at all this run and should be re-verified once
    // NHD is healthy — a zero here during a degraded run is what silently lost
    // data on 2026-09-22.
    console.log(
      `  [warn] ${unconfirmedAbsenceCount} facilities had UNCONFIRMED water absence this run (NHD degraded at the terminating ring) — ${carriedForwardCount} preserved from the prior siting-context.json, ${unconfirmedAbsenceCount - carriedForwardCount} recorded no nearestWater and should be re-verified`
    );
  }
  return result;
}

/**
 * Tally per-category facility counts for an ordinal environmental field
 * (`waterStress` or `groundwaterDecline`) directly from the just-assembled
 * siting-context result — never a hardcoded table, so it tracks the dataset
 * as facilities are added/removed. Counts by the human-readable `label`
 * (only labels that actually occur are included); `total` is the sum of the
 * distribution (i.e. the number of facilities carrying that field). Entries
 * are ordered most-severe-first using each label's numeric `cat` (WRI
 * Aqueduct categories run low->high severity, with the "Arid and Low Water
 * Use" special case at cat -1 sorting last, as intended).
 */
function computeDistribution(sitingContext, fieldName) {
  const byLabel = new Map(); // label -> { count, cat }
  for (const entry of Object.values(sitingContext)) {
    const field = entry?.[fieldName];
    if (!field || typeof field.label !== 'string') continue;
    const existing = byLabel.get(field.label);
    if (existing) {
      existing.count++;
    } else {
      byLabel.set(field.label, { count: 1, cat: field.cat });
    }
  }
  const sorted = [...byLabel.entries()].sort((a, b) => b[1].cat - a[1].cat);
  const distribution = {};
  let total = 0;
  for (const [label, { count }] of sorted) {
    distribution[label] = count;
    total += count;
  }
  return { total, distribution };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const skipNHD = process.argv.slice(2).includes('--skip-nhd');

  // --skip-nhd makes NO NHD calls at all, so it must NOT pre-flight: that path
  // is the documented fallback DURING an outage and has to keep working when
  // the probe would fail. Breaking this would have blocked the 2026-09-23 wave.
  if (!skipNHD) {
    const preflight = await preflightNHDQuorum();
    for (const coord of preflight.results) {
      for (const r of coord.results) {
        console.log(
          `NHD pre-flight [${coord.label}] layer ${r.layer}: ${r.ok ? 'ok' : 'FAILED'} in ${r.ms}ms${r.error ? ` — ${r.error}` : ''}`,
        );
      }
    }
    if (!preflight.ok) {
      const failedCoord = preflight.results.find((c) => c.label === preflight.failedAt);
      const failed = failedCoord.results.filter((r) => !r.ok);
      console.error(
        [
          '',
          `NHD pre-flight FAILED at coordinate [${failedCoord.label}] (lat ${failedCoord.lat}, lon ${failedCoord.lon}) — aborting before any expensive work.`,
          ...failed.map((r) => `  layer ${r.layer}: ${r.error} (measured ${r.ms}ms)`),
          '',
          'USGS NHD is down or degraded. Do NOT retry the full pass — a degraded',
          'service answers slowly rather than failing, which is what let a run grind',
          'for 6h and still lose data.',
          '',
          ...NHD_SKIP_FALLBACK_GUIDANCE,
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }
  }

  const facilities = JSON.parse(readFileSync(FACILITIES_PATH, 'utf8'));
  console.log(`Loaded ${facilities.length} facilities from ${FACILITIES_PATH}`);
  if (skipNHD) console.log('--skip-nhd: reusing existing siting-context.json + map-layers.json for water/power/drought');

  const aqueductResult = await buildAqueduct();
  const aquifersResult = await buildAquifers();
  const envContext = computeEnvironmentalContext(facilities, aqueductResult.aqueductCandidates, aquifersResult.aquiferCandidates);

  let sitingContext;
  let manifestBase;
  let waterResult = null;
  let powerResult = null;
  let droughtResult = null;

  if (skipNHD) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(SITING_CONTEXT_OUT, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `--skip-nhd requires an existing ${SITING_CONTEXT_OUT} to merge into, but none was found. ` +
          '--skip-nhd only refreshes environmental fields (waterStress/aquifer/groundwaterDecline) on ' +
          'top of a prior NHD pass — it cannot be used for a first-ever build. Run without --skip-nhd ' +
          `once (a full NHD build) to create the initial file, or restore a committed copy of ${SITING_CONTEXT_OUT}.`
        );
      }
      throw new Error(
        `--skip-nhd could not read/parse the existing ${SITING_CONTEXT_OUT}${err.code ? ` (${err.code})` : ''}: ${err.message}. ` +
        '--skip-nhd merges into that file and cannot proceed without a valid one. The file exists, but this ' +
        'could be a parse error (corrupted/truncated JSON) or something else entirely, such as a permissions ' +
        'error — see the error above for the real cause. Restore a known-good committed copy, or fix access ' +
        'to the file, before retrying.'
      );
    }
    sitingContext = {};
    // Seed the id set with EVERY facility, not just the ones a dataset matched:
    // a facility that matched nothing is recorded as `{}` on purpose. NHD,
    // HIFLD, Aqueduct and the USGS principal aquifers are all CONUS-only, so a
    // non-CONUS point (Hawaii, Alaska) can legitimately match none of them.
    // Omitting it would break the every-facility invariant asserted by
    // lib/siting-context.test.ts, and `{}` renders identically to a missing
    // entry (components/facility/siting-context.tsx bails when no field is set).
    const ids = new Set([
      ...facilities.map((facility) => facility.id),
      ...Object.keys(existing),
      ...Object.keys(envContext),
    ]);
    for (const id of ids) {
      sitingContext[id] = { ...(existing[id] ?? {}), ...(envContext[id] ?? {}) };
    }
    manifestBase = JSON.parse(readFileSync(MANIFEST_OUT, 'utf8'));
  } else {
    waterResult = await buildWater();
    powerResult = await buildPower();
    droughtResult = await buildDrought();

    let existingSitingContext = {};
    try {
      existingSitingContext = JSON.parse(readFileSync(SITING_CONTEXT_OUT, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // NOT fake-success-ok: a file that exists but fails to read or parse is
        // a corrupted/truncated committed artifact, not "first-ever build".
        // Silently falling back to {} here would disable carry-forward for
        // EVERY facility with no warning at all — this is a whole-artifact
        // integrity check, unlike the benign per-item geometry skips elsewhere
        // in this file that legitimately use this same comment tag.
        console.error(
          `  [warn] could not read/parse ${SITING_CONTEXT_OUT}, proceeding with no carry-forward data: ${err.message}`
        );
      }
      /* fake-success-ok: ENOENT only — first-ever build has no prior siting-context.json to carry forward from. */
    }
    const nhdContext = await computeSitingContext(facilities, powerResult.powerCandidates, existingSitingContext);
    sitingContext = {};
    // Seed the id set with EVERY facility, not just the ones a dataset matched:
    // a facility that matched nothing is recorded as `{}` on purpose. NHD,
    // HIFLD, Aqueduct and the USGS principal aquifers are all CONUS-only, so a
    // non-CONUS point (Hawaii, Alaska) can legitimately match none of them.
    // Omitting it would break the every-facility invariant asserted by
    // lib/siting-context.test.ts, and `{}` renders identically to a missing
    // entry (components/facility/siting-context.tsx bails when no field is set).
    const ids = new Set([
      ...facilities.map((facility) => facility.id),
      ...Object.keys(nhdContext),
      ...Object.keys(envContext),
    ]);
    for (const id of ids) {
      sitingContext[id] = { ...(nhdContext[id] ?? {}), ...(envContext[id] ?? {}) };
    }
    manifestBase = {
      water: { attribution: ATTRIBUTIONS.water },
      power: { attribution: ATTRIBUTIONS.power },
      drought: { attribution: ATTRIBUTIONS.drought, asOf: droughtResult.asOf },
    };
  }

  mkdirSync(dirname(SITING_CONTEXT_OUT), { recursive: true });
  writeFileSync(SITING_CONTEXT_OUT, JSON.stringify(sitingContext, null, 2), 'utf8');

  const waterStressDist = computeDistribution(sitingContext, 'waterStress');
  const groundwaterDist = computeDistribution(sitingContext, 'groundwaterDecline');

  const manifest = {
    ...manifestBase,
    waterStress: {
      attribution: ATTRIBUTIONS.waterStress,
      license: 'CC-BY-4.0',
      total: waterStressDist.total,
      distribution: waterStressDist.distribution,
    },
    groundwaterDecline: {
      attribution: ATTRIBUTIONS.groundwaterDecline,
      license: 'CC-BY-4.0',
      total: groundwaterDist.total,
      distribution: groundwaterDist.distribution,
    },
    aquifers: { attribution: ATTRIBUTIONS.aquifers },
  };
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2), 'utf8');

  // Homepage hero globe point set. Pure local transform of data/facilities.json
  // (no network), so it runs under --skip-nhd too — new facilities must never
  // be missing from the hero just because the slow NHD pass was skipped.
  const heroPointsResult = buildHeroPoints();

  // Homepage hero plate: the static, zero-JS Albers USA dot map phones get
  // instead of the sm+-gated WebGL globe. Same reasoning as hero-points — a
  // pure local transform of data/facilities.json, so it runs under --skip-nhd
  // too, and a wave that skipped it would ship a plate missing new facilities.
  const heroPlateResult = buildHeroPlate();

  // Homepage pipeline-history series: per-quarter status composition
  // reconstructed from statusHistory. Same reasoning again — a pure local
  // transform of data/facilities.json, so it runs under --skip-nhd too, and a
  // wave that skipped it would chart a time axis that stops before the wave.
  const pipelineHistoryResult = buildPipelineHistory();

  console.log('\n--- Build Summary ---');
  if (!skipNHD) {
    console.log(`water.geojson:   ${(waterResult.waterSize / 1024).toFixed(0)} KB (tolerance ${waterResult.waterTolerance})`);
    console.log(`power.geojson:   ${(powerResult.powerSize / 1024).toFixed(0)} KB (tolerance ${powerResult.powerTolerance})`);
    console.log(`drought.geojson: ${(droughtResult.droughtSize / 1024).toFixed(0)} KB (tolerance ${droughtResult.droughtTolerance}, asOf ${droughtResult.asOf})`);
  } else {
    console.log('water.geojson / power.geojson / drought.geojson: skipped (--skip-nhd, reused existing)');
  }
  console.log(`water-stress.geojson:        ${(aqueductResult.waterStressSize / 1024).toFixed(0)} KB (tolerance ${aqueductResult.waterStressTolerance})`);
  console.log(`groundwater-decline.geojson: ${(aqueductResult.groundwaterSize / 1024).toFixed(0)} KB (tolerance ${aqueductResult.groundwaterTolerance})`);
  console.log(`aquifers.geojson:            ${(aquifersResult.aquifersSize / 1024).toFixed(0)} KB (tolerance ${aquifersResult.aquifersTolerance})`);
  console.log(`map-layers.json: ${MANIFEST_OUT}`);
  console.log(`siting-context.json: ${SITING_CONTEXT_OUT} (${Object.keys(sitingContext).length} entries)`);
  console.log(`hero-points.json: ${heroPointsResult.outPath} (${heroPointsResult.count} points, ${(heroPointsResult.bytes / 1024).toFixed(0)} KB)`);
  console.log(`hero-plate-paths.ts: ${heroPlateResult.outPath} (${heroPlateResult.plotted} marks, ${heroPlateResult.deduped} co-located collapsed, ${heroPlateResult.omitted} omitted${heroPlateResult.omittedJurisdictions.length ? ` in ${heroPlateResult.omittedJurisdictions.join('/')}` : ''}, ${(heroPlateResult.bytes / 1024).toFixed(1)} KB)`);
  console.log(`pipeline-history.json: ${pipelineHistoryResult.outPath} (${pipelineHistoryResult.quarters} quarters, ${pipelineHistoryResult.known} known at the last quarter, ${pipelineHistoryResult.excluded} excluded for having no statusHistory, ${(pipelineHistoryResult.bytes / 1024).toFixed(1)} KB)`);
  console.log('\nDone.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

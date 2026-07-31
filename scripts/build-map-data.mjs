/**
 * build-map-data.mjs
 *
 * Build-time data pipeline for map siting-context overlays. Fetches free US
 * geodata (water, transmission lines, drought), clips/simplifies it into
 * small committed static assets, and pre-computes per-facility "nearest
 * water" / "nearest transmission line" stats.
 *
 * BUILD-TIME ONLY: the large source downloads (10m water, full HIFLD
 * transmission set, drought monitor snapshot) are never written to disk —
 * only the small derived outputs below are committed:
 *
 *   public/data/water.geojson       (US-clipped 50m rivers + lakes overlay)
 *   public/data/power.geojson       (US-clipped >=230kV transmission overlay)
 *   public/data/drought.geojson     (simplified USDM snapshot overlay)
 *   public/data/map-layers.json     (attribution + asOf manifest)
 *   data/siting-context.json        (per-facility nearest-water/-transmission stats)
 *
 * Usage: node scripts/build-map-data.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import simplify from '@turf/simplify';
import bboxClip from '@turf/bbox-clip';
import pointToLineDistance from '@turf/point-to-line-distance';
import polygonToLine from '@turf/polygon-to-line';
import { lineString as turfLineString, point as turfPoint } from '@turf/helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const US_BBOX = [-179, 18, -66, 72]; // covers CONUS + AK + HI

const SOURCES = {
  water50Rivers: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson',
  water50Lakes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson',
  water10Rivers: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson',
  water10Lakes: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson',
  drought: 'https://droughtmonitor.unl.edu/data/json/usdm_current.json',
};

const HIFLD_TRANSMISSION_URL = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
const HIFLD_PAGE_SIZE = 2000;

const BUDGETS = {
  water: 1.5 * 1024 * 1024,
  power: 1.9 * 1024 * 1024, // stay comfortably under the ~2MB target
  drought: 1.5 * 1024 * 1024,
};

const ATTRIBUTIONS = {
  water: 'Natural Earth',
  power: 'HIFLD (ORNL/LANL/INL/NGA HSIP Team)',
  drought: 'U.S. Drought Monitor (NDMC / USDA / NOAA)',
};

const NEAREST_CAP_MILES = 250;

const OUT_DIR = resolve(repoRoot, 'public', 'data');
const WATER_OUT = resolve(OUT_DIR, 'water.geojson');
const POWER_OUT = resolve(OUT_DIR, 'power.geojson');
const DROUGHT_OUT = resolve(OUT_DIR, 'drought.geojson');
const MANIFEST_OUT = resolve(OUT_DIR, 'map-layers.json');
const SITING_CONTEXT_OUT = resolve(repoRoot, 'data', 'siting-context.json');
const FACILITIES_PATH = resolve(repoRoot, 'data', 'facilities.json');

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchJSON(url, { label = url, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.error(`  [warn] fetch failed (attempt ${attempt + 1}/${retries + 1}) for ${label}: ${err.message}`);
    }
  }
  throw new Error(`Failed to fetch ${label} after ${retries + 1} attempt(s): ${lastErr?.message}`);
}

async function fetchArcGISAll(baseUrl, whereClause, outFields, label) {
  let offset = 0;
  const allFeatures = [];
  for (;;) {
    const url = `${baseUrl}?where=${encodeURIComponent(whereClause)}&outFields=${outFields}&resultRecordCount=${HIFLD_PAGE_SIZE}&resultOffset=${offset}&f=geojson`;
    const data = await fetchJSON(url, { label: `${label} offset=${offset}`, retries: 1 });
    const features = data.features || [];
    allFeatures.push(...features);
    console.log(`  [${label}] offset=${offset} +${features.length} (total ${allFeatures.length})`);
    if (features.length === 0) break;
    // f=geojson nests the paging flag under `properties`, not top-level.
    const exceededTransferLimit = data.exceededTransferLimit ?? data.properties?.exceededTransferLimit;
    if (!exceededTransferLimit) break;
    offset += HIFLD_PAGE_SIZE;
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

/** Conservative bbox guaranteed to contain everything within capMiles of [lat,lon]. */
function searchBBoxFor(lat, lon, capMiles) {
  const padLat = (capMiles / 69) * 1.15;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.15);
  const padLon = Math.min((capMiles / (69 * cosLat)) * 1.15, 20);
  return [lon - padLon, lat - padLat, lon + padLon, lat + padLat];
}

/** Find nearest candidate (by exact pointToLineDistance) among bbox-prefiltered parts. */
function nearestFromCandidates(pt, candidates, searchBBox, capMiles) {
  let best = null;
  for (const c of candidates) {
    if (!bboxesIntersect(c.bbox, searchBBox)) continue;
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

  // 10m sets for higher-accuracy nearest-computation (build-time only, NOT written to disk)
  console.log('  fetching 10m water sets for siting-context (build-time only)...');
  const [rivers10, lakes10] = await Promise.all([
    fetchJSON(SOURCES.water10Rivers, { label: 'water10Rivers' }),
    fetchJSON(SOURCES.water10Lakes, { label: 'water10Lakes' }),
  ]);
  console.log(`  fetched 10m rivers: ${rivers10.features.length} features, 10m lakes: ${lakes10.features.length} features`);
  const nearestRivers = clipCollection(rivers10.features, '10m rivers');
  const nearestLakes = clipCollection(lakes10.features, '10m lakes');

  const riverName = (props) => props?.name ?? props?.NAME ?? props?.name_en ?? null;
  const riverCandidates = buildCandidateIndex(nearestRivers, (f) => ({ name: riverName(f.properties), kind: 'river' }));
  const lakeCandidates = buildCandidateIndex(nearestLakes, (f) => ({ name: riverName(f.properties), kind: 'lake' }));

  return {
    waterTolerance,
    waterSize,
    riverCandidates,
    lakeCandidates,
  };
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
// Siting context (per-facility nearest water / transmission)
// ---------------------------------------------------------------------------
function computeSitingContext(facilities, riverCandidates, lakeCandidates, powerCandidates) {
  console.log('\n=== Siting context (per-facility nearest water/transmission) ===');
  const result = {};
  for (const facility of facilities) {
    const { lat, lon } = facility.location ?? {};
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    const pt = turfPoint([lon, lat]);
    const searchBBox = searchBBoxFor(lat, lon, NEAREST_CAP_MILES);

    const nearestRiver = nearestFromCandidates(pt, riverCandidates, searchBBox, NEAREST_CAP_MILES);
    const nearestLake = nearestFromCandidates(pt, lakeCandidates, searchBBox, NEAREST_CAP_MILES);
    let nearestWater = null;
    if (nearestRiver && (!nearestLake || nearestRiver.dist <= nearestLake.dist)) {
      nearestWater = nearestRiver;
    } else if (nearestLake) {
      nearestWater = nearestLake;
    }

    const nearestTransmission = nearestFromCandidates(pt, powerCandidates, searchBBox, NEAREST_CAP_MILES);

    const entry = {};
    if (nearestWater) {
      entry.nearestWater = {
        name: nearestWater.name ?? null,
        kind: nearestWater.kind,
        distanceMi: Math.round(nearestWater.dist * 10) / 10,
      };
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
  }
  console.log(`  computed siting context for ${Object.keys(result).length}/${facilities.length} facilities`);
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const facilities = JSON.parse(readFileSync(FACILITIES_PATH, 'utf8'));
  console.log(`Loaded ${facilities.length} facilities from ${FACILITIES_PATH}`);

  const waterResult = await buildWater();
  const powerResult = await buildPower();
  const droughtResult = await buildDrought();

  const sitingContext = computeSitingContext(
    facilities,
    waterResult.riverCandidates,
    waterResult.lakeCandidates,
    powerResult.powerCandidates
  );
  mkdirSync(dirname(SITING_CONTEXT_OUT), { recursive: true });
  writeFileSync(SITING_CONTEXT_OUT, JSON.stringify(sitingContext, null, 2), 'utf8');

  const manifest = {
    water: { attribution: ATTRIBUTIONS.water },
    power: { attribution: ATTRIBUTIONS.power },
    drought: { attribution: ATTRIBUTIONS.drought, asOf: droughtResult.asOf },
  };
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\n--- Build Summary ---');
  console.log(`water.geojson:   ${(waterResult.waterSize / 1024).toFixed(0)} KB (tolerance ${waterResult.waterTolerance})`);
  console.log(`power.geojson:   ${(powerResult.powerSize / 1024).toFixed(0)} KB (tolerance ${powerResult.powerTolerance})`);
  console.log(`drought.geojson: ${(droughtResult.droughtSize / 1024).toFixed(0)} KB (tolerance ${droughtResult.droughtTolerance}, asOf ${droughtResult.asOf})`);
  console.log(`map-layers.json: ${MANIFEST_OUT}`);
  console.log(`siting-context.json: ${SITING_CONTEXT_OUT} (${Object.keys(sitingContext).length} entries)`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

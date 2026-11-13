// Per-facility "join keys" for the siting context: county FIPS, census tract GEOID and EPA eGRID
// subregion. County and tract each come from one ArcGIS REST point query; eGRID comes from a local
// point-in-polygon lookup (`buildEgridLocator`) against EPA's polygons, which the caller downloads
// once per build (EPA's hosted eGRID point query measured ~10 s + ~4 s per facility on 2026-11-13).
//
// Every network call goes through an injectable `query(url)` so tests never touch the network.
// `query` is REQUIRED (no default, which would make this module and build-map-data.mjs import each
// other): the caller passes a fetchJSON-based function, which throws on ArcGIS body-level errors.
//
// Failure rule (mirrors nearestWater): a query that THROWS carries the previous value forward and
// is recorded in `failures`; only a confirmed absence (HTTP 200, zero features) clears a value.
// Nothing here ever writes `null`. The eGRID lookup is local and cannot fail per facility.
export const COUNTY_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';
export const TRACT_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query';
export const EGRID_URL =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/eGRID2023_Subregions/FeatureServer/0/query';
export const EGRID_MULTI_URL =
  'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/eGRID2023_Multiple_Subregions/FeatureServer/0/query';

export const SOURCES = {
  county: 'Census TIGERweb',
  tract: 'Census TIGERweb',
  egrid: 'EPA eGRID2023 (geographic approximation)',
};

const PREFLIGHT_PIN = { lon: -77.4875, lat: 39.0438 };
// TIGERweb county-equivalent LSAD suffixes (VA independent cities, AK boroughs/areas/municipalities, PR, CT planning regions).
const COUNTY_SUFFIX_RE =
  /\s+(county|parish|borough|city and borough|census area|municipio|municipality|city|planning region)$/i;

/** Key groups `skipKeys` may name. 'egrid' also covers the multiple-subregions layer. */
export const JOIN_KEY_NAMES = ['county', 'tract', 'egrid'];
const KEY_GROUP = { countyFips: 'county', tractGeoid: 'tract', egridSubregion: 'egrid', egridMultiple: 'egrid' };
// Flags owned by each group, copied forward unchanged when that group is skipped.
const GROUP_FLAGS = {
  county: ['county_no_polygon', 'multiple_hits:countyFips', 'county_name_mismatch'],
  tract: ['tract_no_polygon', 'multiple_hits:tractGeoid', 'tract_county_mismatch'],
  egrid: ['egrid_no_polygon', 'multiple_hits:egridSubregion', 'egrid_multi_unknown'],
};

function requireQuery(query) {
  if (typeof query !== 'function') throw new Error('join-keys: a `query(url)` function is required');
}

function toSkipSet(skipKeys) {
  const set = new Set(skipKeys ?? []);
  for (const k of set) if (!JOIN_KEY_NAMES.includes(k)) throw new Error(`join-keys: unknown skipKey "${k}"`);
  return set;
}
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const round6 = (n) => Number(n).toFixed(6);

export function pointQueryUrl(base, lon, lat, outField) {
  return (
    `${base}?geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=${encodeURIComponent(outField)}` +
    `&returnGeometry=false&f=json`
  );
}

/** `{value}` for one feature, `{none:true}` for zero, `{multiple:[...]}` for more. Throws on a malformed body. */
export function parseSingleAttribute(body, field) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.features)) {
    throw new Error('malformed ArcGIS body: no features array');
  }
  const values = body.features.map((f) => {
    const v = f?.attributes?.[field];
    if (v === undefined || v === null || v === '') {
      throw new Error(`malformed ArcGIS body: feature without ${field}`);
    }
    return String(v);
  });
  if (values.length === 0) return { none: true };
  if (values.length === 1) return { value: values[0] };
  return { multiple: [...new Set(values)] };
}

function pinOf(facility) {
  const { lat, lon, precision } = facility.location;
  return { lat, lon, precision: precision ?? 'approximate' };
}

const NO_RETRY_FLAGS = {
  countyFips: ['county_no_polygon', 'multiple_hits:countyFips'],
  tractGeoid: ['tract_no_polygon', 'multiple_hits:tractGeoid'],
  egridSubregion: ['egrid_no_polygon', 'multiple_hits:egridSubregion'],
};

/**
 * Incremental cache: true when there is no entry, the pin moved (6 dp), or the precision changed.
 * Also true when a key is absent with no confirmed-absence/multi-hit flag explaining it, i.e. a
 * previous query FAILED and carried nothing forward, so the next run retries it.
 */
export function needsRecompute(facility, existingJoinKeys, { skipKeys } = {}) {
  const skip = toSkipSet(skipKeys);
  if (!existingJoinKeys || !existingJoinKeys.pin) return true;
  const pin = pinOf(facility);
  const old = existingJoinKeys.pin;
  if (round6(pin.lat) !== round6(old.lat) || round6(pin.lon) !== round6(old.lon)) return true;
  if (pin.precision !== old.precision) return true;
  const flags = existingJoinKeys.flags ?? [];
  // A skipped group is never a reason to retry: its absence or carry-forward is deliberate.
  const wanted = ['countyFips', 'egridSubregion'];
  if (pin.precision === 'exact') wanted.push('tractGeoid');
  const active = wanted.filter((k) => !skip.has(KEY_GROUP[k]));
  // An old egrid_multi_unknown flag (earlier builds wrote it when the multiple-subregions point query
  // failed) or a key carried forward onto an old pin (carried_forward:*) is retried.
  const retryFlag = (f) =>
    f === 'egrid_multi_unknown'
      ? !skip.has('egrid')
      : f.startsWith('carried_forward:') && !skip.has(KEY_GROUP[f.slice('carried_forward:'.length)]);
  if (flags.some(retryFlag)) return true;
  return active.some(
    (key) => existingJoinKeys[key] === undefined && !NO_RETRY_FLAGS[key].some((f) => flags.includes(f)),
  );
}

function normalizeCounty(name) {
  // Strip repeatedly so both sides of "Charles City County" vs "Charles City" reduce to the same stem.
  let n = String(name).trim();
  for (let prev = null; prev !== n; ) {
    prev = n;
    n = n.replace(COUNTY_SUFFIX_RE, '').trim();
  }
  return n.toLowerCase();
}

/** Query one layer and parse each requested field; never throws. Returns {parsed:{field:result}} or {failed}. */
async function fetchParsed(query, url, fields) {
  try {
    const body = await query(url);
    const parsed = {};
    for (const f of fields) parsed[f] = parseSingleAttribute(body, f);
    return { parsed };
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

function ringBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function prepareFeature(feature, what) {
  const g = feature?.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) {
    throw new Error(`join-keys: ${what} feature geometry must be Polygon or MultiPolygon`);
  }
  const parts = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const rings = [];
  for (const part of parts) {
    for (const ring of part) rings.push({ ring, bbox: ringBbox(ring) });
  }
  return rings;
}

// Even-odd parity over every ring of one feature. A ring whose bbox excludes the point is skipped:
// it cannot contain the point, so the ray crosses it an even number of times.
function featureContains(rings, lon, lat) {
  let inside = false;
  for (const { ring, bbox } of rings) {
    if (lon < bbox.minX || lon > bbox.maxX || lat < bbox.minY || lat > bbox.maxY) continue;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Local eGRID lookup from EPA's polygons (GeoJSON Feature arrays). Returns
 * `locate(lon, lat) => { subregions: string[], inMultiple: boolean }` (subregions deduped, feature order).
 *
 * WHY even-odd over ALL rings of a feature, not "any part contains the point":
 *  - parts == rings for all 27 subregion features and for the one multiple-subregions feature
 *    (443 parts), measured 2026-11-13, so a hole cannot be told apart from an outer part. Per-part
 *    OR treated holes as land: over 3,233 pins it gave 15 pins two subregion codes (e.g. a Colstrip
 *    MT pin read MROW+NWPP) and put 13 pins inside the multiple-subregions footprint. Even-odd
 *    parity over all rings handles either encoding: EPA's own point query sided with parity in all
 *    28 of those comparisons (21 distinct pins; 7 pins disagreed on both layers), and agreed with
 *    it on all 75 facilities computed by point query earlier.
 *  - The bbox prefilter is per ring because it prunes far better: AKMS's parts are pre-split at
 *    +-180, so its feature bbox spans -179.15..179.78 and would exclude almost nothing. Skipping a
 *    ring whose bbox excludes the point keeps parity, since such a ring is crossed an even number
 *    of times.
 *  - Assumption: parity also reads a point inside two overlapping outer parts of one feature as
 *    outside. Such a point would show up as an OR-versus-parity disagreement where OR is the
 *    correct answer; in the 2026-11-13 measurement EPA sided with parity on every disagreement, so
 *    no pin sat in one.
 */
export function buildEgridLocator(subregionFeatures, multipleFeatures) {
  if (!Array.isArray(subregionFeatures) || subregionFeatures.length === 0) {
    throw new Error('join-keys: eGRID subregion features are empty');
  }
  if (!Array.isArray(multipleFeatures) || multipleFeatures.length === 0) {
    throw new Error('join-keys: eGRID multiple-subregion features are empty');
  }
  const subregions = subregionFeatures.map((f) => {
    const code = f?.properties?.Subregion;
    if (typeof code !== 'string' || code === '') {
      throw new Error('join-keys: eGRID subregion feature without a Subregion code');
    }
    return { code, rings: prepareFeature(f, 'subregion') };
  });
  const multiple = multipleFeatures.map((f) => prepareFeature(f, 'multiple-subregions'));
  return function locate(lon, lat) {
    const hits = [];
    for (const s of subregions) if (featureContains(s.rings, lon, lat)) hits.push(s.code);
    return {
      subregions: [...new Set(hits)],
      inMultiple: multiple.some((rings) => featureContains(rings, lon, lat)),
    };
  };
}

export async function computeJoinKeysFor(
  facility,
  existingJoinKeys,
  { query, delayMs = 0, today, skipKeys, egridLocator } = {},
) {
  requireQuery(query);
  const skip = toSkipSet(skipKeys);
  if (!skip.has('egrid') && typeof egridLocator !== 'function') {
    throw new Error('join-keys: an egridLocator is required unless egrid is skipped');
  }
  const pin = pinOf(facility);
  const { lat, lon } = pin;
  const exact = pin.precision === 'exact';
  const prev = existingJoinKeys ?? {};
  const flags = [];
  const failures = [];
  const keys = {};
  let first = true;
  const q = async (url) => {
    if (!first) await sleep(delayMs);
    first = false;
    return query(url);
  };

  // Settle one key from a query outcome. Failure carries the previous value forward (never null);
  // zero features is a confirmed absence (clears, flags); several features keep nothing and flag.
  const settle = (key, outcome, field, noPolygonFlag) => {
    if (outcome.failed !== undefined) {
      failures.push({ key, error: outcome.failed });
      if (prev[key] !== undefined) keys[key] = prev[key];
      return;
    }
    const p = outcome.parsed[field];
    if (p.none) flags.push(noPolygonFlag);
    else if (p.multiple) flags.push(`multiple_hits:${key}`);
    else keys[key] = p.value;
  };

  // A skipped group makes no query: its value and flags are carried forward unchanged and no failure
  // is recorded (so it never counts against a failure budget).
  const skippedCarried = [];
  const carrySkipped = (group, keyNames) => {
    for (const k of keyNames) {
      if (prev[k] !== undefined) {
        keys[k] = prev[k];
        if (k !== 'egridMultiple') skippedCarried.push(k);
      }
    }
    for (const f of GROUP_FLAGS[group]) if ((prev.flags ?? []).includes(f)) flags.push(f);
  };

  let county = { skipped: true };
  if (skip.has('county')) carrySkipped('county', ['countyFips']);
  else {
    county = await fetchParsed(q, pointQueryUrl(COUNTY_URL, lon, lat, 'GEOID,NAME'), ['GEOID', 'NAME']);
    settle('countyFips', county, 'GEOID', 'county_no_polygon');
  }

  const wantedCounty = facility.location.county;
  if (wantedCounty && county.parsed?.NAME?.value !== undefined) {
    if (normalizeCounty(county.parsed.NAME.value) !== normalizeCounty(wantedCounty)) {
      flags.push('county_name_mismatch');
    }
  }

  // Tract only for exact pins: a town/county centroid would yield a misleading tract.
  if (exact) {
    if (skip.has('tract')) carrySkipped('tract', ['tractGeoid']);
    else {
      const tract = await fetchParsed(q, pointQueryUrl(TRACT_URL, lon, lat, 'GEOID'), ['GEOID']);
      settle('tractGeoid', tract, 'GEOID', 'tract_no_polygon');
    }
  }

  if (skip.has('egrid')) carrySkipped('egrid', ['egridSubregion', 'egridMultiple']);
  else {
    const hit = egridLocator(lon, lat);
    if (hit.subregions.length === 0) flags.push('egrid_no_polygon');
    else if (hit.subregions.length > 1) flags.push('multiple_hits:egridSubregion');
    else keys.egridSubregion = hit.subregions[0];
    if (hit.inMultiple) keys.egridMultiple = true;
  }

  if (keys.tractGeoid && keys.countyFips && keys.tractGeoid.slice(0, 5) !== keys.countyFips) {
    flags.push('tract_county_mismatch');
  }

  // A review flag whose check could not be re-run (its inputs failed) is kept from the previous run
  // rather than silently dropped.
  const priorFlags = prev.flags ?? [];
  const keep = (flag, failedInputs) => {
    if (failedInputs && priorFlags.includes(flag) && !flags.includes(flag)) flags.push(flag);
  };
  // The name check needs the county NAME, which a failed county query cannot supply.
  keep('county_name_mismatch', county.failed !== undefined);
  // Keep the prior tract/county flag ONLY when the tract query failed; if the tract was fetched, the
  // fresh comparison against the county (fresh or carried) is the check and it wins.
  keep('tract_county_mismatch', failures.some((f) => f.key === 'tractGeoid'));

  // Pin moved (or precision changed) and a key was carried forward from the OLD pin: keep the old
  // pin so needsRecompute still sees a moved pin and retries next run. A new pin here would make the
  // stale value look current.
  const carried = [...failures.map((f) => f.key), ...skippedCarried].filter((k) => prev[k] !== undefined);
  const pinMoved =
    prev.pin &&
    (round6(pin.lat) !== round6(prev.pin.lat) ||
      round6(pin.lon) !== round6(prev.pin.lon) ||
      pin.precision !== prev.pin.precision);
  const keepOldPin = Boolean(pinMoved && carried.length);
  if (keepOldPin) for (const k of carried) flags.push(`carried_forward:${k}`);

  const joinKeys = {};
  if (keys.countyFips !== undefined) joinKeys.countyFips = keys.countyFips;
  if (keys.tractGeoid !== undefined) joinKeys.tractGeoid = keys.tractGeoid;
  if (keys.egridSubregion !== undefined) joinKeys.egridSubregion = keys.egridSubregion;
  if (keys.egridMultiple) joinKeys.egridMultiple = true;
  joinKeys.pin = keepOldPin ? prev.pin : pin;
  if (flags.length) joinKeys.flags = [...new Set(flags)];
  joinKeys.sources = exact
    ? { county: SOURCES.county, tract: SOURCES.tract, egrid: SOURCES.egrid }
    : { county: SOURCES.county, egrid: SOURCES.egrid };
  joinKeys.computedAt = today ?? new Date().toISOString().slice(0, 10);
  return { joinKeys, failures };
}

/**
 * Compute join keys for every facility, re-querying only new or moved pins.
 *
 * Two circuit breakers stop issuing queries and carry everything not yet done forward:
 *  - `maxFailures`: failed queries in this run. NOTE this counts FAILURES and is blind to latency
 *    (a service answering 200-OK at 30x slow never trips it; see CLAUDE.md, "a failure budget
 *    counts FAILURES"), hence
 *  - `maxRunMs`: wall-clock ceiling for the whole run.
 */
export async function computeAllJoinKeys(
  facilities,
  existingByFacilityId,
  {
    query,
    delayMs = 250,
    skipKeys,
    today,
    egridLocator,
    maxFailures = 25,
    maxRunMs = 20 * 60 * 1000,
    now = () => Date.now(),
  } = {},
) {
  requireQuery(query);
  const skip = toSkipSet(skipKeys);
  const byId = {};
  const stats = { recomputed: 0, reused: 0, failures: 0, flagged: 0, skipped: 0 };
  const startedAt = now();
  let stopped = false;
  for (const facility of facilities) {
    const existing = existingByFacilityId?.[facility.id];
    if (!needsRecompute(facility, existing, { skipKeys: skip })) {
      byId[facility.id] = existing;
      stats.reused++;
      continue;
    }
    if (!stopped && (stats.failures > maxFailures || now() - startedAt > maxRunMs)) stopped = true;
    if (stopped) {
      if (existing) byId[facility.id] = existing;
      stats.skipped++;
      continue;
    }
    const { joinKeys, failures } = await computeJoinKeysFor(facility, existing, { query, delayMs, today, skipKeys: skip, egridLocator });
    byId[facility.id] = joinKeys;
    stats.recomputed++;
    stats.failures += failures.length;
    if (joinKeys.flags?.length) stats.flagged++;
    await sleep(delayMs);
  }
  return { byId, stats };
}

/**
 * One known-good probe per service. Returns `{ ok, failed: [...] }` where `failed` names the
 * services ('county' | 'tract' | 'egrid') that errored or answered unexpectedly, so the caller can
 * carry that key forward with a loud warning instead of aborting the whole run. eGRID is probed
 * against the local locator (no network call).
 */
export async function preflightJoinKeys({ query, egridLocator } = {}) {
  requireQuery(query);
  const { lon, lat } = PREFLIGHT_PIN;
  const checks = [
    ['county', COUNTY_URL, 'GEOID', (v) => v === '51107'],
    ['tract', TRACT_URL, 'GEOID', (v) => v.startsWith('51107')],
  ];
  const failed = [];
  for (const [name, base, field, expect] of checks) {
    const r = await fetchParsed(query, pointQueryUrl(base, lon, lat, field), [field]);
    const p = r.parsed?.[field];
    if (r.failed !== undefined || p?.value === undefined || !expect(p.value)) failed.push(name);
  }
  if (typeof egridLocator !== 'function') failed.push('egrid');
  else {
    let egridOk = false;
    try {
      const { subregions } = egridLocator(lon, lat);
      egridOk = subregions.length === 1 && subregions[0] === 'SRVC';
    } catch {
      egridOk = false;
    }
    if (!egridOk) failed.push('egrid');
  }
  return { ok: failed.length === 0, failed };
}

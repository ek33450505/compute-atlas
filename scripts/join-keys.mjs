// Per-facility "join keys" for the siting context: county FIPS, census tract GEOID and EPA eGRID
// subregion, each from one ArcGIS REST point query (no polygon downloads).
//
// Every network call goes through an injectable `query(url)` so tests never touch the network.
// `query` is REQUIRED (no default, which would make this module and build-map-data.mjs import each
// other): the caller passes a fetchJSON-based function, which throws on ArcGIS body-level errors.
//
// Failure rule (mirrors nearestWater): a query that THROWS carries the previous value forward and
// is recorded in `failures`; only a confirmed absence (HTTP 200, zero features) clears a value.
// Nothing here ever writes `null`.
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
  // A failed multiple-subregions query (egrid_multi_unknown) or a key carried forward onto an old pin
  // (carried_forward:*) is retried.
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

export async function computeJoinKeysFor(
  facility,
  existingJoinKeys,
  { query, delayMs = 0, today, skipKeys } = {},
) {
  requireQuery(query);
  const skip = toSkipSet(skipKeys);
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
    const egrid = await fetchParsed(q, pointQueryUrl(EGRID_URL, lon, lat, 'Subregion'), ['Subregion']);
    settle('egridSubregion', egrid, 'Subregion', 'egrid_no_polygon');

    // A hit in the multiple-subregions layer is the only thing that sets egridMultiple.
    const multi = await fetchParsed(q, pointQueryUrl(EGRID_MULTI_URL, lon, lat, 'MultipleSu'), ['MultipleSu']);
    if (multi.failed !== undefined) {
      failures.push({ key: 'egridMultiple', error: multi.failed });
      flags.push('egrid_multi_unknown');
      if (prev.egridMultiple === true) keys.egridMultiple = true;
    } else if (!multi.parsed.MultipleSu.none) {
      keys.egridMultiple = true;
    }
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
    const { joinKeys, failures } = await computeJoinKeysFor(facility, existing, { query, delayMs, today, skipKeys: skip });
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
 * carry that key forward with a loud warning instead of aborting the whole run.
 */
export async function preflightJoinKeys({ query } = {}) {
  requireQuery(query);
  const { lon, lat } = PREFLIGHT_PIN;
  const checks = [
    ['county', COUNTY_URL, 'GEOID', (v) => v === '51107'],
    ['tract', TRACT_URL, 'GEOID', (v) => v.startsWith('51107')],
    ['egrid', EGRID_URL, 'Subregion', (v) => v === 'SRVC'],
  ];
  const failed = [];
  for (const [name, base, field, expect] of checks) {
    const r = await fetchParsed(query, pointQueryUrl(base, lon, lat, field), [field]);
    const p = r.parsed?.[field];
    if (r.failed !== undefined || p?.value === undefined || !expect(p.value)) failed.push(name);
  }
  return { ok: failed.length === 0, failed };
}

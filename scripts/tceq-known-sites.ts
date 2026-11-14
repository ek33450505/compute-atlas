/**
 * Maintainer CLI: propose TCEQ stormwater-permit (TXR15) facts for KNOWN Texas sites.
 *
 *   npm run permits:tceq-review                          build the review list (writes only the review JSON and .md)
 *   ... -- --since=2024-01-01 --statuses=proposed,permitted --include-filled
 *   ... -- --max-summaries=600 --max-searches=3000 --out=data/tceq-review.json
 *        (--max-searches is the TOTAL of search and summary-fetch calls in one run)
 *   ... -- --apply-approved data/tceq-review.json        write approved candidates to the LOCAL snapshot
 *
 * Mode 1 reads the local data/facilities.json (run `npm run db:export` first), searches TCEQ per
 * county, prefilters rows per facility without fetching, fetches summary pages for kept rows (in
 * priority order, within a per-facility budget and a global cap) and writes a review JSON plus a
 * Markdown summary beside it. Review mode makes no change except writing those two files: it never
 * writes data/facilities.json or Neon. Every candidate starts
 * `"approved": false`; the maintainer flips it.
 *
 * Mode 2 patches ONLY data/facilities.json, atomically, and never touches Neon,
 * data/facilities.meta.json, statusHistory, status, location or operator. It never overwrites an
 * existing value. It validates every record it patches and refuses the whole apply (writes
 * nothing) if any fails, when two approved candidates target the same field of one facility, or
 * when one permit is approved for more than one facility. Publishing stays `npm run db:sync`.
 *
 * NAMES RULE (structural): the TCEQ name fields can hold an individual's name. A candidate's
 * permittee is written only when it EXACTLY matched the facility's operator/parties; its site
 * name only when the operator rule or the data-center keyword rule matched (and it does not read
 * like an address). Token-only rows are "withheld", with the matched tokens recorded instead.
 * Logs carry permit numbers and county names, never party or site names.
 */
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatFatalError } from "../lib/db-error";
import { facilitySchema, statusEnum, v2SourceIndexRefs, type Facility } from "../lib/schema";
import {
  TceqRequestError,
  assertSummaryUrl,
  createTceqSession,
  dedupeByPermit,
  fetchTxr15Summary,
  searchTxr15,
  type TceqCriteria,
  type TceqRow,
  type TceqSummary,
} from "./discovery/tceq-client";
import { looksLikeAddress, normalizeName } from "./discovery/tceq-names";
import { isEntrypoint } from "./is-entrypoint";

export const WITHHELD = "withheld";
const DEFAULT_SINCE = "2024-01-01";
const SINCE_FLOOR = "2020-01-01";
const DEFAULT_MAX_SEARCHES = 3000;
const MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_STATUSES = ["proposed", "permitted", "under_construction"];
const DEFAULT_MAX_SUMMARIES = 600;
const DEFAULT_MAX_PER_FACILITY = 4;
const DEFAULT_OUT = "data/tceq-review.json";
const MIN_WINDOW_DAYS = 31;
const MIN_KEY_LENGTH = 4;
const STRONG_OPERATOR_KM = 10;
const STRONG_SITE_KM = 5;
const PUBLISHER = "Texas Commission on Environmental Quality";

// ---------------------------------------------------------------- types

export type Rule = "operator" | "token" | "keyword";
export type Strength = "strong" | "possible";

export interface CandidatePatch {
  disturbedAcres?: number;
  receivingWater?: { name: string; segment?: string };
  expectedStart?: string;
  expectedCompletion?: string;
}

export interface Candidate {
  permitNumber: string;
  summaryUrl: string;
  strength: Strength;
  rules: Rule[];
  distanceKm: number | null;
  /** The permittee, only when it exactly matched the facility's operator/parties. */
  permittee: string;
  /** The site name, only when the operator or data-center keyword rule matched and it looks non-residential. */
  siteName: string;
  /** Facility-name tokens the site name shared (token rule); recorded INSTEAD of the name for token-only rows. */
  matchedTokens: string[];
  disturbedAcres: number | null;
  receivingWater: string | null;
  segment: string | null;
  coverageBegan: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  patch: CandidatePatch;
  /** Why a value was not proposed (validator failures); never the raw value. */
  notProposed: string[];
  /** Maintainer signals, e.g. a passed estimated start. Never an automatic status change. */
  flags: string[];
  approved: boolean;
}

export interface ReviewFacility {
  id: string;
  /** The facility's name when reviewed; --apply-approved refuses if it no longer matches. */
  facilityName: string;
  name: string;
  precision: string;
  candidates: Candidate[];
}

export interface ReviewFile {
  generatedAt: string;
  since: string;
  stats: ReviewStats;
  facilities: ReviewFacility[];
}

export interface ReviewStats {
  cohort: number;
  countiesSearched: number;
  countiesSkipped: string[];
  skippedWindows: string[];
  rows: number;
  kept: number;
  summariesFetched: number;
  summaryCapHit: boolean;
  /** Facility ids whose in-budget rows were left unfetched because the global cap was hit. */
  shortOfBudget: string[];
  /** Facilities with more kept rows than the per-facility budget (lowest-priority rows not fetched). */
  budgetTruncated: number;
  summaryErrors: number;
  facilitiesStrong: number;
  facilitiesPossible: number;
}

export interface CliOptions {
  since: string;
  statuses: string[];
  includeFilled: boolean;
  maxSummaries: number;
  maxSummariesPerFacility: number;
  maxSearches: number;
  out: string;
  applyApproved: string | null;
}

// ---------------------------------------------------------------- args

/** A bad command line; the entrypoint exits 2. */
export class UsageError extends Error {}

function flagValue(arg: string, name: string, next: () => string | undefined): string | undefined {
  if (arg === name) {
    const v = next();
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
    return v;
  }
  if (arg.startsWith(`${name}=`)) {
    const v = arg.slice(name.length + 1);
    if (!v) throw new UsageError(`${name} needs a value`);
    return v;
  }
  return undefined;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    since: DEFAULT_SINCE,
    statuses: DEFAULT_STATUSES,
    includeFilled: false,
    maxSummaries: DEFAULT_MAX_SUMMARIES,
    maxSummariesPerFacility: DEFAULT_MAX_PER_FACILITY,
    maxSearches: DEFAULT_MAX_SEARCHES,
    out: DEFAULT_OUT,
    applyApproved: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--include-filled") o.includeFilled = true;
    else {
      let v: string | undefined;
      if ((v = flagValue(arg, "--since", next)) !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new UsageError("--since must be YYYY-MM-DD");
        if (v < SINCE_FLOOR) throw new UsageError(`--since must be ${SINCE_FLOOR} or later`);
        o.since = v;
      } else if ((v = flagValue(arg, "--statuses", next)) !== undefined) {
        o.statuses = v.split(",").map((s) => s.trim()).filter(Boolean);
        if (o.statuses.length === 0) throw new UsageError("--statuses needs at least one status");
        const unknown = o.statuses.filter((x) => !(statusEnum.options as readonly string[]).includes(x));
        if (unknown.length) throw new UsageError(`unknown status in --statuses: ${unknown.join(", ")}`);
      } else if ((v = flagValue(arg, "--max-summaries", next)) !== undefined) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new UsageError("--max-summaries must be a non-negative integer");
        o.maxSummaries = n;
      } else if ((v = flagValue(arg, "--max-summaries-per-facility", next)) !== undefined) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) throw new UsageError("--max-summaries-per-facility must be a non-negative integer");
        o.maxSummariesPerFacility = n;
      } else if ((v = flagValue(arg, "--max-searches", next)) !== undefined) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) throw new UsageError("--max-searches must be a positive integer");
        o.maxSearches = n;
      } else if ((v = flagValue(arg, "--out", next)) !== undefined) o.out = v;
      else if ((v = flagValue(arg, "--apply-approved", next)) !== undefined) o.applyApproved = v;
      else throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------- matching

const SUFFIXES = new Set([
  "llc", "inc", "incorporated", "lp", "llp", "ltd", "limited", "corp", "corporation", "co", "company", "pllc",
]);

/** Lowercase, drop parenthesized text, "&" -> "and", strip punctuation, strip trailing business suffixes. */
export function normalizeOrg(raw: string): string {
  let s = raw.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/&/g, " and ");
  s = s.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/\bl l c\b/g, "llc").replace(/\bl l p\b/g, "llp").replace(/\bl p\b/g, "lp");
  const tokens = s.split(" ").filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

/** EXACT equality of normalized names; never prefix or substring. Keys under 4 chars never match. */
export function operatorMatches(permittee: string, names: string[]): boolean {
  const key = normalizeOrg(permittee);
  if (key.length < MIN_KEY_LENGTH) return false;
  return names.some((n) => normalizeOrg(n) === key);
}

const STOPWORDS = new Set([
  "data", "center", "centre", "campus", "project", "phase", "site", "development", "the", "and", "park", "road",
  "texas", "county", "llc", "inc",
  // Generic site-name vocabulary that says nothing about WHICH site.
  "land", "tract", "lots", "addition", "subdivision", "industrial", "commercial", "facility", "building",
  "buildings", "construction", "north", "south", "east", "west", "central", "creek", "ranch", "farm", "business",
  "technology", "energy", "power", "storage", "highway", "street", "drive", "boulevard", "with", "from",
  // Infrastructure and civic words that matched unrelated permits (transmission-line overhauls, roads, schools).
  "transmission", "line", "lines", "overhaul", "substation", "pipeline", "bridge", "drainage", "utility",
  "utilities", "water", "sewer", "school", "church", "residential", "apartments", "retail",
]);

export function distinctiveTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 4 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

export function tokenOverlap(siteName: string, facilityText: string[], exclude: Set<string> = new Set()): string[] {
  const site = distinctiveTokens(siteName);
  const mine = new Set<string>();
  for (const t of facilityText) for (const x of distinctiveTokens(t)) if (!exclude.has(x)) mine.add(x);
  return [...site].filter((t) => mine.has(t)).sort();
}

const KEYWORDS = [/\bdata\s*cent(?:er|re)s?\b/i, /\bdatacent(?:er|re)s?\b/i, /\bhyperscale\b/i, /\bbitcoin\b/i, /\bcrypto/i];

export function hasKeyword(siteName: string): boolean {
  return KEYWORDS.some((re) => re.test(siteName));
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function facilityOrgNames(f: Facility): string[] {
  const names = [f.operator];
  for (const role of ["ownerEntity", "generalContractor"] as const) {
    for (const p of f.parties?.[role] ?? []) names.push(p.name);
  }
  return names.filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** Tokens naming WHERE the facility is (city, county): every permit in town shares them, so they prove nothing. */
export function placeTokens(f: Facility): Set<string> {
  const out = new Set<string>();
  for (const text of [f.location.city ?? "", f.location.county ?? "", f.location.state ?? ""]) {
    for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) if (t) out.add(t);
  }
  return out;
}

export interface RowMatch {
  rules: Rule[];
  tokens: string[];
}

/** Cheap prefilter, no network: which rules the row passes for this facility. */
export function prefilterRow(row: TceqRow, f: Facility): RowMatch {
  const rules: Rule[] = [];
  if (operatorMatches(row.permittee, facilityOrgNames(f))) rules.push("operator");
  const site = normalizeName(row.siteName);
  const tokens = tokenOverlap(site, [f.name], placeTokens(f));
  if (tokens.length > 0) rules.push("token");
  if (hasKeyword(site)) rules.push("keyword");
  return { rules, tokens };
}

export function classify(rules: Rule[], distanceKm: number | null): Strength {
  if (distanceKm === null) return "possible";
  if (rules.includes("operator") && distanceKm <= STRONG_OPERATOR_KM) return "strong";
  const siteRule = rules.includes("token") || rules.includes("keyword");
  return siteRule && distanceKm <= STRONG_SITE_KM ? "strong" : "possible";
}

export function rankCandidates<T extends { strength: Strength; rules: Rule[]; distanceKm: number | null }>(c: T[]): T[] {
  const dist = (x: T) => x.distanceKm ?? Number.POSITIVE_INFINITY;
  return [...c].sort(
    (a, b) =>
      Number(b.strength === "strong") - Number(a.strength === "strong") ||
      Number(b.rules.includes("operator")) - Number(a.rules.includes("operator")) ||
      dist(a) - dist(b),
  );
}

// ---------------------------------------------------------------- patches

const ROUTE_PREFIXES = new Set(["fm", "rm", "ih", "sh", "us", "cr", "sr", "hwy"]);

/** "BRUSHY CREEK" -> "Brushy Creek"; "FM 1960" and "O'BRIEN"/"MCKINNEY" keep their conventional case. */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/[a-z][a-z']*/g, (w, off: number, str: string) => {
    if (ROUTE_PREFIXES.has(w) && /^[\s.-]*\d/.test(str.slice(off + w.length))) return w.toUpperCase();
    let out = w[0].toUpperCase() + w.slice(1);
    out = out.replace(/^([A-Z])'([a-z])/, (_m, a: string, b: string) => `${a}'${b.toUpperCase()}`);
    if (/^Mc[a-z]/.test(out)) out = `Mc${out[2].toUpperCase()}${out.slice(3)}`;
    return out;
  });
}

// ---- publishable-value validators: used in review AND apply; a failing value is never patched.
const WATER_WORDS = new Set([
  "creek", "river", "lake", "branch", "bayou", "tributary", "draw", "reservoir", "pond", "canal", "ditch",
  "slough", "spring", "springs", "fork", "bay", "arroyo", "playa", "gully", "run", "hollow", "lagoon",
  "estuary", "gulf",
]);
const GENERIC_WATER_WORDS = new Set([
  "unnamed", "tributary", "tributaries", "onsite", "drainage", "existing", "local", "nearby", "storm",
  "stormwater", "municipal", "city", "county", "the", "of", "and", "a", "an",
]);
const SENTENCE_WORDS = new Set([
  "to", "into", "via", "discharge", "discharges", "proposed", "currently", "segment", "then", "from",
  "through", "onsite", "on-site",
]);

/** Returns a reason the name is not publishable, or null (the cleaned name is `cleanWaterName`). */
export function cleanWaterName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}
export function waterNameProblem(raw: string): string | null {
  const name = cleanWaterName(raw);
  if (!name) return "empty";
  if (!/^[A-Za-z0-9 .'\-/()&]+$/.test(name)) return "has characters outside the allowed set";
  if (name.length > 60) return "longer than 60 characters";
  if (/\d{5,}/.test(name)) return "has a 5+ digit run";
  if (/^[\d\s.\-/]+$/.test(name)) return "purely numeric";
  const words = name.split(" ");
  if (words.length > 6) return "more than 6 words";
  const toks = name.toLowerCase().split(/[^a-z0-9'-]+/).filter(Boolean);
  if (toks.some((t) => SENTENCE_WORDS.has(t))) return "reads as a sentence";
  if (!toks.some((t) => WATER_WORDS.has(t))) return "names no water body";
  // "Ditch" or "Unnamed Tributary" is generic: demand a distinguishing word.
  if (!toks.some((t) => /[a-z]/.test(t) && !WATER_WORDS.has(t) && !GENERIC_WATER_WORDS.has(t))) {
    return "names no specific water body";
  }
  return null;
}

export function segmentProblem(raw: string): string | null {
  return /^\d{4}[A-Z]?$/.test(raw) ? null : "not a 4-digit segment id";
}

export function acresProblem(n: number): string | null {
  return Number.isFinite(n) && n > 0 && n <= 20000 ? null : "outside (0, 20000]";
}

export function dateProblem(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return "not YYYY-MM-DD";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw ? null : "not a real calendar date";
}

export interface PermitFacts {
  disturbedAcres?: number;
  receivingWater?: { name: string; segment?: string };
  start?: string;
  end?: string;
  notProposed: string[];
}

/** The validated, publishable facts of a summary (no record or clock involved). */
export function permitFacts(s: TceqSummary): PermitFacts {
  const f: PermitFacts = { notProposed: [] };
  if (s.areaDisturbedAcres !== undefined) {
    const p = acresProblem(s.areaDisturbedAcres);
    if (p) f.notProposed.push(`disturbedAcres: ${p}`);
    else f.disturbedAcres = s.areaDisturbedAcres;
  }
  if (s.receivingWater) {
    const p = waterNameProblem(s.receivingWater);
    if (p) f.notProposed.push(`receivingWater: ${p}`);
    else {
      f.receivingWater = { name: titleCase(cleanWaterName(s.receivingWater)) };
      if (s.segment) {
        const sp = segmentProblem(s.segment);
        if (sp) f.notProposed.push(`segment: ${sp}`);
        else f.receivingWater.segment = s.segment;
      }
    }
  }
  for (const [key, raw] of [["start", s.estimatedStart], ["end", s.estimatedEnd]] as const) {
    if (raw === undefined) continue;
    const p = dateProblem(raw);
    if (p) f.notProposed.push(`estimated ${key}: ${p}`);
    else f[key] = raw;
  }
  return f;
}

const PLAUSIBLE_YEARS = 10;

/** True when `date` is more than ten years after `today` (ISO strings compare chronologically). */
export function beyondHorizon(date: string, today: string): boolean {
  return date > `${Number(today.slice(0, 4)) + PLAUSIBLE_YEARS}${today.slice(4)}`;
}

/**
 * Forecast filter: a date is proposed only when it is AFTER today and no more than ten years out.
 * A passed one becomes a flag; an implausible one is "not proposed" (the raw value is not echoed).
 */
export function patchFromFacts(
  facts: PermitFacts,
  today: string,
): { patch: CandidatePatch; flags: string[]; notProposed: string[] } {
  const patch: CandidatePatch = {};
  const flags: string[] = [];
  const notProposed: string[] = [];
  if (facts.disturbedAcres !== undefined) patch.disturbedAcres = facts.disturbedAcres;
  if (facts.receivingWater) patch.receivingWater = facts.receivingWater;
  if (facts.start) {
    if (beyondHorizon(facts.start, today)) notProposed.push("estimated start: implausible date");
    else if (facts.start > today) patch.expectedStart = facts.start;
    else flags.push(`permit's estimated start (${facts.start}) has passed; check the record's status`);
  }
  if (facts.end) {
    if (beyondHorizon(facts.end, today)) notProposed.push("estimated end: implausible date");
    else if (facts.end > today) patch.expectedCompletion = facts.end;
    else flags.push(`permit's estimated end (${facts.end}) has passed; check the record's status`);
  }
  return { patch, flags, notProposed };
}

type Construction = NonNullable<Facility["construction"]>;

/** Only the fields the record lacks; forecasts stay forecasts (expectedStart, never statusHistory). */
export function buildProposedPatch(
  f: Facility,
  s: TceqSummary,
  today: string,
): { patch: CandidatePatch; flags: string[]; notProposed: string[]; facts: PermitFacts } {
  const facts = permitFacts(s);
  const { patch, flags, notProposed } = patchFromFacts(facts, today);
  const c: Partial<Construction> = f.construction ?? {};
  if (c.disturbedAcres) delete patch.disturbedAcres;
  if (c.receivingWater) delete patch.receivingWater;
  if (c.expectedStart) delete patch.expectedStart;
  if (c.expectedCompletion) delete patch.expectedCompletion;
  return { patch, flags, notProposed: [...facts.notProposed, ...notProposed], facts };
}

export function buildCandidate(f: Facility, row: TceqRow, match: RowMatch, s: TceqSummary, today: string): Candidate {
  const hasPin = typeof f.location.lat === "number" && typeof f.location.lon === "number";
  const distanceKm =
    hasPin && s.lat !== undefined && s.lon !== undefined
      ? Math.round(haversineKm(f.location.lat, f.location.lon, s.lat, s.lon) * 100) / 100
      : null;
  const opMatched = match.rules.includes("operator");
  const showSite = (opMatched || match.rules.includes("keyword")) && !looksLikeAddress(normalizeName(row.siteName));
  const { patch, flags, notProposed, facts } = buildProposedPatch(f, s, today);
  return {
    permitNumber: s.permitNumber,
    summaryUrl: row.summaryUrl,
    strength: classify(match.rules, distanceKm),
    rules: match.rules,
    distanceKm,
    permittee: opMatched ? row.permittee : WITHHELD,
    siteName: showSite ? normalizeName(row.siteName) : WITHHELD,
    matchedTokens: match.tokens,
    // Only validated values are displayed; a rejected raw value is never echoed.
    disturbedAcres: facts.disturbedAcres ?? null,
    receivingWater: facts.receivingWater?.name ?? null,
    segment: facts.receivingWater?.segment ?? null,
    coverageBegan: s.coverageBegan && !dateProblem(s.coverageBegan) ? s.coverageBegan : null,
    estimatedStart: facts.start && !beyondHorizon(facts.start, today) ? facts.start : null,
    estimatedEnd: facts.end && !beyondHorizon(facts.end, today) ? facts.end : null,
    patch,
    notProposed,
    flags,
    approved: false,
  };
}

// ---------------------------------------------------------------- search

export type SearchFn = (criteria: TceqCriteria) => Promise<{ rows: TceqRow[] }>;

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

/** Search one county over [start, end]; on "narrow the search" split the window in halves, down to ~1 month. */
export async function searchWindowed(
  search: SearchFn,
  county: string,
  start: string,
  end: string,
): Promise<{ rows: TceqRow[]; skipped: string[] }> {
  try {
    const { rows } = await search({ permitStatus: "ACTIVE", county, startDate: start, endDate: end });
    return { rows, skipped: [] };
  } catch (err) {
    if (!(err instanceof Error) || !/narrow the search/i.test(err.message)) throw err;
    const span = daysBetween(start, end);
    if (span <= MIN_WINDOW_DAYS) return { rows: [], skipped: [`${county} ${start}..${end}`] };
    const mid = addDays(start, Math.floor(span / 2));
    const a = await searchWindowed(search, county, start, mid);
    const b = await searchWindowed(search, county, addDays(mid, 1), end);
    return { rows: [...a.rows, ...b.rows], skipped: [...a.skipped, ...b.skipped] };
  }
}

export function countyKey(county: string): string {
  return county.replace(/\s+county\s*$/i, "").trim().toUpperCase();
}

export function selectCohort(facilities: Facility[], opts: Pick<CliOptions, "statuses" | "includeFilled">): Facility[] {
  return facilities.filter(
    (f) =>
      f.location.state === "TX" &&
      (f.facilityType === "data_center" || f.facilityType === "crypto_mining") &&
      opts.statuses.includes(f.status) &&
      (opts.includeFilled || !f.construction?.disturbedAcres),
  );
}

/** A summary page that is not the permit its URL named; counted as a summary error, never shown. */
class SummaryMismatch extends Error {}

/** Thrown by {@link guarded} to stop a run; never swallowed as a per-item error. */
export class RunAborted extends Error {}

/** A call counter that several guarded functions can share, so one cap bounds their total. */
export interface RequestBudget {
  used: number;
  max: number;
}
export function requestBudget(max: number): RequestBudget {
  return { used: 0, max };
}

/**
 * Bounds a network function: at most the budget's max calls, and abort after `maxConsecutiveErrors` failures in a
 * row. The client already rate-limits every request to 1/second (createRateGate(1) in createTceqSession);
 * this bounds how long a run can go on. Errors matching `expected` (e.g. "narrow the search") are not failures.
 */
export function guarded<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  label: string,
  budget: number | RequestBudget,
  expected?: RegExp,
  maxConsecutiveErrors = MAX_CONSECUTIVE_ERRORS,
): (...args: A) => Promise<R> {
  const shared = typeof budget === "number" ? requestBudget(budget) : budget;
  let consecutive = 0;
  return async (...args: A) => {
    if (++shared.used > shared.max) throw new RunAborted(`${label}: request cap of ${shared.max} reached; aborting`);
    try {
      const r = await fn(...args);
      consecutive = 0;
      return r;
    } catch (err) {
      if (err instanceof Error && expected?.test(err.message)) {
        consecutive = 0;
      } else if (++consecutive >= maxConsecutiveErrors) {
        throw new RunAborted(`${label}: ${consecutive} consecutive request errors; aborting`);
      }
      throw err;
    }
  };
}

/**
 * One retry, only for a TceqRequestError (anything except a permanent error, HTTP 404/410). Permanent errors and plain
 * Errors (including "narrow the search") are never retried. Compose as retryOnce(guarded(fn)) so the
 * retry counts against the request cap.
 */
export function retryOnce<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof TceqRequestError && !err.permanent) return fn(...args);
      throw err;
    }
  };
}

export interface ReviewDeps {
  search: SearchFn;
  fetchSummary: (url: string) => Promise<TceqSummary>;
  today: string;
  log: (msg: string) => void;
}

export async function buildReviewList(
  facilities: Facility[],
  opts: Pick<CliOptions, "since" | "statuses" | "includeFilled" | "maxSummaries" | "maxSummariesPerFacility">,
  deps: ReviewDeps,
): Promise<ReviewFile> {
  const cohort = selectCohort(facilities, opts);
  const stats: ReviewStats = {
    cohort: cohort.length,
    countiesSearched: 0,
    countiesSkipped: [],
    skippedWindows: [],
    rows: 0,
    kept: 0,
    summariesFetched: 0,
    summaryCapHit: false,
    shortOfBudget: [],
    budgetTruncated: 0,
    summaryErrors: 0,
    facilitiesStrong: 0,
    facilitiesPossible: 0,
  };
  const byCounty = new Map<string, Facility[]>();
  for (const f of cohort) {
    if (!f.location.county) {
      stats.countiesSkipped.push(`${f.id} (no county)`);
      continue;
    }
    const k = countyKey(f.location.county);
    byCounty.set(k, [...(byCounty.get(k) ?? []), f]);
  }

  const summaries = new Map<string, TceqSummary | null>();
  const out: ReviewFacility[] = [];
  for (const [county, facs] of byCounty) {
    const found = await searchWindowed(deps.search, county, opts.since, deps.today);
    stats.countiesSearched++;
    stats.skippedWindows.push(...found.skipped);
    const rows = dedupeByPermit(found.rows);
    stats.rows += rows.length;
    deps.log(`county ${county}: ${rows.length} permits, ${facs.length} facilities`);
    for (const f of facs) {
      const kept: { row: TceqRow; match: RowMatch }[] = [];
      for (const row of rows) {
        const match = prefilterRow(row, f);
        if (match.rules.length > 0) kept.push({ row, match });
      }
      stats.kept += kept.length;
      kept.sort((a, b) => rulePriority(a.match.rules) - rulePriority(b.match.rules));
      const candidates: Candidate[] = [];
      let budget = opts.maxSummariesPerFacility;
      let truncated = false;
      let short = false;
      for (const { row, match } of kept) {
        let s = summaries.get(row.permitNumber);
        if (s === undefined) {
          // A row not fetched here is skipped, not a reason to drop later rows already fetched elsewhere.
          if (budget <= 0) {
            truncated = true;
            continue;
          }
          if (stats.summariesFetched >= opts.maxSummaries) {
            stats.summaryCapHit = true;
            short = true;
            continue;
          }
          budget--;
          stats.summariesFetched++;
          try {
            s = await deps.fetchSummary(row.summaryUrl);
            if (s.permitNumber !== row.permitNumber) throw new SummaryMismatch();
          } catch (err) {
            if (err instanceof RunAborted) throw err;
            stats.summaryErrors++;
            deps.log(`summary fetch failed for ${row.permitNumber}`);
            s = null;
          }
          summaries.set(row.permitNumber, s);
        }
        if (s) candidates.push(buildCandidate(f, row, match, s, deps.today));
      }
      if (truncated) stats.budgetTruncated++;
      if (short) stats.shortOfBudget.push(f.id);
      if (candidates.length === 0) continue;
      const ranked = rankCandidates(candidates);
      if (ranked.some((c) => c.strength === "strong")) stats.facilitiesStrong++;
      else stats.facilitiesPossible++;
      out.push({ id: f.id, facilityName: f.name, name: f.name, precision: f.location.precision, candidates: ranked });
    }
  }
  // One permit's acres belong to one record: warn wherever a permit is a candidate for several facilities.
  const facilitiesPerPermit = new Map<string, number>();
  for (const f of out) for (const c of f.candidates) facilitiesPerPermit.set(c.permitNumber, (facilitiesPerPermit.get(c.permitNumber) ?? 0) + 1);
  for (const f of out) {
    for (const c of f.candidates) {
      const n = facilitiesPerPermit.get(c.permitNumber) ?? 1;
      if (n > 1) c.flags.push(`permit is a candidate for ${n} facilities; approve at most one`);
    }
  }
  return { generatedAt: deps.today, since: opts.since, stats, facilities: out };
}

/** Lower is fetched first: operator match, then data-center keyword, then token overlap. */
function rulePriority(rules: Rule[]): number {
  return rules.includes("operator") ? 0 : rules.includes("keyword") ? 1 : 2;
}

export function renderMarkdown(review: ReviewFile): string {
  const s = review.stats;
  const lines: string[] = [
    `# TCEQ known-site review (${review.generatedAt})`,
    "",
    `Cohort ${s.cohort}; counties searched ${s.countiesSearched}; permits ${s.rows}; kept ${s.kept}; ` +
      `summaries ${s.summariesFetched}${s.summaryCapHit ? " (CAP HIT)" : ""}; ` +
      `${s.budgetTruncated} facilities had more kept rows than the per-facility budget; ` +
      `facilities with strong ${s.facilitiesStrong}, possible only ${s.facilitiesPossible}.`,
    "Flip `\"approved\": true` in the JSON, then run `--apply-approved`. Dates are permit forecasts, not a start of construction.",
    "",
  ];
  if (s.shortOfBudget.length) lines.push(`Short of budget (global cap hit): ${s.shortOfBudget.join(", ")}`, "");
  if (s.skippedWindows.length) lines.push(`Skipped windows (too many permits): ${s.skippedWindows.join("; ")}`, "");
  for (const f of review.facilities) {
    lines.push(`## ${f.id}`, `${f.name} (pin precision: ${f.precision})`, "");
    for (const c of f.candidates) {
      const rw = c.receivingWater ? `${c.receivingWater}${c.segment ? ` (segment ${c.segment})` : ""}` : "none";
      lines.push(
        `- **${c.permitNumber}** [${c.strength}] ${c.summaryUrl}`,
        `  - rules: ${c.rules.join(", ")}; distance: ${c.distanceKm ?? "unknown"} km`,
        `  - permittee: ${c.permittee}; site name: ${c.siteName}${c.siteName === WITHHELD && c.matchedTokens.length ? ` (matched tokens: ${c.matchedTokens.join(", ")})` : ""}`,
        `  - acres: ${c.disturbedAcres ?? "none"}; receiving water: ${rw}`,
        `  - coverage began: ${c.coverageBegan ?? "none"}; est. start: ${c.estimatedStart ?? "none"}; est. end: ${c.estimatedEnd ?? "none"}`,
        `  - proposed patch: ${Object.keys(c.patch).length ? JSON.stringify(c.patch) : "nothing (record already has these fields)"}`,
      );
      for (const n of c.notProposed) lines.push(`  - not proposed: ${n}`);
      for (const fl of c.flags) lines.push(`  - FLAG: ${fl}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- apply

type Json = Record<string, unknown>;
interface SourceLike { url: string }

export interface ApplyReport {
  changed: { id: string; changes: string[]; patch: CandidatePatch }[];
  conflicts: string[];
}

export class ApplyRefusal extends Error {}

const PERMIT_RE = /^TXR15[0-9A-Z]{2,12}$/;

interface Approved {
  id: string;
  facilityName: string;
  permitNumber: string;
  summaryUrl: string;
}

/** Reads ONLY identifiers from the hand-edited review file; every value is rebuilt from a live fetch. */
function approvedIdentifiers(review: unknown): Approved[] {
  const facs = (review as { facilities?: unknown })?.facilities;
  if (!Array.isArray(facs)) throw new ApplyRefusal("review file has no facilities array");
  const out: Approved[] = [];
  for (const f of facs as { id?: unknown; facilityName?: unknown; candidates?: unknown }[]) {
    if (typeof f?.id !== "string" || typeof f.facilityName !== "string" || !Array.isArray(f.candidates)) {
      throw new ApplyRefusal("malformed facility entry in review file");
    }
    for (const c of f.candidates as { approved?: unknown; permitNumber?: unknown; summaryUrl?: unknown }[]) {
      if (c?.approved !== true) continue;
      if (typeof c.permitNumber !== "string" || !PERMIT_RE.test(c.permitNumber)) {
        throw new ApplyRefusal(`approved candidate for ${f.id} has a malformed permit number`);
      }
      if (typeof c.summaryUrl !== "string") throw new ApplyRefusal(`approved candidate ${c.permitNumber} has no summary URL`);
      let u: URL;
      try {
        u = assertSummaryUrl(c.summaryUrl);
      } catch {
        throw new ApplyRefusal(`approved candidate ${c.permitNumber} has a non-TCEQ summary URL`);
      }
      const idents = u.searchParams.getAll("lgl_ident_txt");
      if (idents.length !== 1 || idents[0] !== c.permitNumber) {
        throw new ApplyRefusal(`summary URL of ${c.permitNumber} does not carry that permit number`);
      }
      out.push({ id: f.id, facilityName: f.facilityName, permitNumber: c.permitNumber, summaryUrl: u.href });
    }
  }
  return out;
}

/**
 * Returns patched COPIES of the touched records (raw JSON shape preserved) and a report. The review
 * file contributes identifiers only: each approved permit is re-fetched live and its patch rebuilt with
 * the same validators as review mode. Throws ApplyRefusal on any problem; the caller then writes nothing.
 */
export async function applyApproved(
  records: Json[],
  review: unknown,
  today: string,
  fetchSummary: (url: string) => Promise<TceqSummary>,
): Promise<{ records: Json[]; report: ApplyReport }> {
  const approved = approvedIdentifiers(review);
  const idsByPermit = new Map<string, Set<string>>();
  for (const x of approved) idsByPermit.set(x.permitNumber, (idsByPermit.get(x.permitNumber) ?? new Set()).add(x.id));
  for (const [permit, ids] of idsByPermit) {
    if (ids.size > 1) throw new ApplyRefusal(`permit ${permit} is approved for more than one facility: ${[...ids].join(", ")}`);
  }
  const byId = new Map(records.map((r) => [r.id as string, r]));
  const touched = new Map<string, Json>();
  const claimed = new Set<string>();
  const seen = new Set<string>();
  const live = new Map<string, TceqSummary>();
  const report: ApplyReport = { changed: [], conflicts: [] };

  for (const a of approved) {
    const orig = byId.get(a.id);
    if (!orig) throw new ApplyRefusal(`approved candidate ${a.permitNumber} targets unknown facility ${a.id}`);
    if (orig.name !== a.facilityName) {
      throw new ApplyRefusal(`facility ${a.id} no longer has the name that was reviewed; re-run the review`);
    }
    if (seen.has(`${a.id}:${a.permitNumber}`)) throw new ApplyRefusal(`${a.permitNumber} approved twice for ${a.id}`);
    seen.add(`${a.id}:${a.permitNumber}`);

    let sum = live.get(a.permitNumber);
    if (!sum) {
      sum = await fetchSummary(a.summaryUrl);
      if (sum.permitNumber !== a.permitNumber) {
        throw new ApplyRefusal(`live summary at the URL of ${a.permitNumber} is a different permit`);
      }
      live.set(a.permitNumber, sum);
    }
    const { patch } = patchFromFacts(permitFacts(sum), today);
    const rec = touched.get(a.id) ?? (JSON.parse(JSON.stringify(orig)) as Json);
    const sources = (rec.sources = Array.isArray(rec.sources) ? (rec.sources as Json[]) : []);
    const construction = (rec.construction ?? {}) as Json;

    const wanted: [keyof CandidatePatch, string, unknown][] = [
      ["disturbedAcres", "disturbedAcres", patch.disturbedAcres],
      ["receivingWater", "receivingWater", patch.receivingWater],
      ["expectedStart", "expectedStart", patch.expectedStart],
      ["expectedCompletion", "expectedCompletion", patch.expectedCompletion],
    ];
    for (const [, field, v] of wanted) {
      if (v === undefined) continue;
      const k = `${a.id}:${field}`;
      if (claimed.has(k)) throw new ApplyRefusal(`two approved candidates target ${field} of ${a.id}`);
      claimed.add(k);
    }
    const free = wanted.filter(([, field, v]) => {
      if (v === undefined) return false;
      if (construction[field] !== undefined) {
        report.conflicts.push(`${a.id}: ${field} already set; kept existing (permit ${a.permitNumber})`);
        return false;
      }
      return true;
    });
    if (free.length === 0) {
      touched.set(a.id, rec);
      continue;
    }

    const changes: string[] = [];
    let sourceIndex = (sources as unknown as SourceLike[]).findIndex((x) => x.url === a.summaryUrl);
    if (sourceIndex < 0) {
      sources.push({
        url: a.summaryUrl,
        label: `TCEQ stormwater construction permit ${a.permitNumber}`,
        publisher: PUBLISHER,
        retrievedAt: today,
        kind: "permit",
      });
      sourceIndex = sources.length - 1;
      changes.push(`+source ${a.permitNumber}`);
    }
    const applied: CandidatePatch = {};
    for (const [key, field, v] of free) {
      if (field === "disturbedAcres") construction.disturbedAcres = { value: v, sourceIndex };
      else if (field === "receivingWater") {
        const rw = v as { name: string; segment?: string };
        construction.receivingWater = { name: rw.name, ...(rw.segment ? { segment: rw.segment } : {}), sourceIndex };
      } else construction[field] = { date: v, sourceIndex };
      (applied as Record<string, unknown>)[key] = v;
      changes.push(`+${field}`);
    }
    rec.construction = construction;
    rec.lastUpdated = today;
    touched.set(a.id, rec);
    const prior = report.changed.find((x) => x.id === a.id);
    if (prior) {
      prior.changes.push(...changes);
      Object.assign(prior.patch, applied);
    } else report.changed.push({ id: a.id, changes, patch: applied });
  }

  for (const [id, rec] of touched) {
    if (!report.changed.some((x) => x.id === id)) {
      touched.delete(id);
      continue;
    }
    const parsed = facilitySchema.safeParse(rec);
    if (!parsed.success) throw new ApplyRefusal(`${id} fails schema validation after patch: ${parsed.error.issues[0]?.message}`);
    const nSources = Array.isArray(rec.sources) ? rec.sources.length : 0;
    const bad = v2SourceIndexRefs(rec as Parameters<typeof v2SourceIndexRefs>[0]).filter((r) => r.index >= nSources);
    if (bad.length) throw new ApplyRefusal(`${id} has out-of-range sourceIndex at ${bad[0].path}`);
  }
  return {
    records: records.map((r) => touched.get(r.id as string) ?? r),
    report,
  };
}

/**
 * --out must be a .json path whose target (and derived .md) either does not exist or is a previous
 * review output, so a typo can never overwrite data/facilities.json, a meta file or any other file.
 */
export function assertSafeOut(out: string): string {
  if (!/\.json$/i.test(out)) throw new UsageError("--out must end in .json");
  const md = `${out.replace(/\.json$/i, "")}.md`;
  for (const [file, isReview] of [[out, isReviewJson], [md, isReviewMd]] as const) {
    if (!existsSync(file)) continue;
    let ok = false;
    try {
      ok = isReview(readFileSync(realpathSync(file), "utf8"));
    } catch {
      ok = false;
    }
    if (!ok) throw new UsageError(`refusing to overwrite ${path.basename(file)}: it is not a previous TCEQ review output`);
  }
  return md;
}

function isReviewJson(text: string): boolean {
  try {
    const v = JSON.parse(text) as { generatedAt?: unknown; stats?: unknown; facilities?: unknown };
    return typeof v.generatedAt === "string" && typeof v.stats === "object" && Array.isArray(v.facilities);
  } catch {
    return false;
  }
}

function isReviewMd(text: string): boolean {
  return text.startsWith("# TCEQ known-site review");
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** File-level apply: reads the snapshot, patches, writes facilities.json only (meta untouched). */
export async function applyApprovedFile(
  root: string,
  reviewPath: string,
  today: string,
  fetchSummary: (url: string) => Promise<TceqSummary>,
): Promise<ApplyReport> {
  const file = path.join(root, "data", "facilities.json");
  const records = JSON.parse(readFileSync(file, "utf8")) as Json[];
  const review = JSON.parse(readFileSync(reviewPath, "utf8")) as unknown;
  const { records: next, report } = await applyApproved(records, review, today, fetchSummary);
  if (report.changed.length > 0) writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------- main

/** Today in Texas: TCEQ rejects a search whose end date is still in the future there (UTC runs ahead in the evening). */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(now);
}

function readSnapshot(root: string): Facility[] {
  const file = path.join(root, "data", "facilities.json");
  if (!existsSync(file)) throw new Error("data/facilities.json is missing; run `npm run db:export` first");
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("data/facilities.json is not a non-empty array");
  const out: Facility[] = [];
  for (const r of parsed) {
    const v = facilitySchema.safeParse(r);
    if (!v.success) throw new Error("data/facilities.json has a record that fails schema validation; run `npm run db:export`");
    out.push(v.data);
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const root = process.cwd();
  const outPath = opts.applyApproved ? null : path.resolve(root, opts.out);
  const mdPath = outPath ? assertSafeOut(outPath) : null;
  const today = todayIso();
  if (opts.applyApproved) {
    const session = createTceqSession();
    const fetchSummary = guarded((url: string) => fetchTxr15Summary(session, url), "summary fetch", requestBudget(opts.maxSearches));
    const report = await applyApprovedFile(root, opts.applyApproved, today, fetchSummary);
    for (const c of report.changed) console.log(`${c.id}: ${c.changes.join(", ")} ${JSON.stringify(c.patch)}`);
    for (const c of report.conflicts) console.log(`CONFLICT ${c}`);
    console.log(
      report.changed.length
        ? `patched ${report.changed.length} record(s) in data/facilities.json (local only; publish with npm run db:sync)`
        : "nothing to change; data/facilities.json untouched",
    );
    return 0;
  }
  const facilities = readSnapshot(root);
  const session = createTceqSession();
  const budget = requestBudget(opts.maxSearches);
  const review = await buildReviewList(facilities, opts, {
    search: retryOnce(
      guarded((criteria: TceqCriteria) => searchTxr15(session, criteria), "search", budget, /narrow the search/i),
    ),
    fetchSummary: guarded((url: string) => fetchTxr15Summary(session, url), "summary fetch", budget),
    today,
    log: (m) => console.error(m),
  });
  writeAtomic(outPath as string, `${JSON.stringify(review, null, 2)}\n`);
  writeAtomic(mdPath as string, renderMarkdown(review));
  const s = review.stats;
  console.log(
    `cohort ${s.cohort}; counties ${s.countiesSearched}; permits ${s.rows}; kept ${s.kept}; ` +
      `summaries ${s.summariesFetched}${s.summaryCapHit ? " (cap hit)" : ""}; short ${s.shortOfBudget.length}; truncated ${s.budgetTruncated}; errors ${s.summaryErrors}; ` +
      `strong ${s.facilitiesStrong}; possible ${s.facilitiesPossible}; skipped windows ${s.skippedWindows.length}`,
  );
  console.log(`wrote ${opts.out} and its .md summary`);
  return 0;
}

/** main() with the exit-code contract: a UsageError prints one line and exits 2; anything else exits 1. */
export async function run(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      // lint-no-raw-error-logs: allow -- UsageError only (fixed text, the operator's own argv and a file basename; never a DB error)
      console.error(`error: ${err.message}`);
      return 2;
    }
    console.error(`tceq-known-sites: ${formatFatalError(err)}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  void run(process.argv.slice(2)).then((code) => process.exit(code));
}

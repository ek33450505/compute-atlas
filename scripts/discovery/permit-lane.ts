/**
 * Permit-first discovery lane: reads Texas TCEQ construction stormwater permits
 * (TXR15 notices of intent, via scripts/discovery/tceq-client.ts) and files a
 * `new` lead for each recent permit that looks like a data center or crypto site.
 * The leads lane then works those leads in the same scheduled run, so a permit
 * lead reaches the same human approve gate as any public tip. This lane never
 * writes a facility or a submission.
 *
 * A permit row matches on ANY of:
 *   - keyword: a data-center / hyperscale / bitcoin / crypto word in the site
 *     name or permittee (deliberately no "mining": Texas has many sand and
 *     gravel mines);
 *   - SIC 7374 (computer processing and data preparation);
 *   - EXACT known-operator match: the permittee, normalized, equals the
 *     normalized `operator` or `parties.ownerEntity[].name` of an existing
 *     data_center / crypto_mining facility. Never a prefix or substring match:
 *     prefix matching hit an individual's name when measured on 2026-11-13.
 *
 * Privacy contract (structural, not a name classifier: any classifier of
 * "business vs person" leaks some individual's name). TCEQ permittees are
 * sometimes individuals, so the lane may store a name only when it is already
 * in our published dataset or the site is evidently the target:
 *   - the permittee is written only when it exactly matched a known operator;
 *     otherwise the note says "permittee withheld";
 *   - the site name and permit coordinates are written only when the site name
 *     contains a data-center keyword or the permittee exactly matched a known
 *     operator; otherwise "site name withheld";
 *   - always allowed: permit number, TCEQ summary URL, acres, receiving water
 *     and segment, county, dates, which rule matched.
 * A shown site name is also withheld by looksLikeAddress (tceq-names.ts): a digit
 * start, a 3+ digit run, a route designator plus number, or a street or residence
 * word. That guard is a best-effort heuristic on top of the structural rule; it
 * errs toward withholding, and a name it misses is printed only in an admin-only
 * lead note. Notes never include the permit's
 * Address or Site Location fields (the client never reads them); free text that
 * looks like an email or phone number is dropped; coordinates appear only with
 * a shown site name. stderr never carries a party name, site name or free text
 * (permit numbers, rules, counts and fixed messages only); stdout carries the
 * lead notes, which name a party only under the rules above. The reviewer opens
 * the TCEQ link for withheld details. Leads carry no attribution (it flows into
 * submission provenance).
 *
 * Outage boundary: a run stops after 3 consecutive transient failures (searches and
 * summary fetches share one counter; any success resets it). Candidates are rotated by
 * a per-day offset, so a cluster of persistently failing permits blocks different
 * candidates on different nights rather than the same ones; a failing permit stays
 * visible as a failure until it leaves the lookback window.
 *
 * Yield is not established: see docs/discovery-pipeline.md for dated snapshots.
 *
 * `runPermitLane` is the testable core; `main()` builds the real network/DB
 * deps lazily, so importing this module never opens a socket or touches a DB.
 *
 * Run via: npx tsx --env-file=.env.local scripts/discovery/permit-lane.ts
 *   [--limit=N] [--lookback-days=D] [--since=YYYY-MM-DD] [--dry-run] [--run-id=ID]
 * Exit: 0 clean, 1 when the search or any summary fetch / insert failed, 2 bad args.
 */
import type { Facility } from "../../lib/schema";
import { createDiscoveryLead, listLeadUrlsContaining, type DiscoveryLeadResult } from "../../lib/leads";
import { formatFatalError, redactedErrorCode } from "../../lib/db-error";
import { isEntrypoint } from "../is-entrypoint";
import { dropTrailingHighSurrogate } from "../../lib/intake-fields";
import { looksLikeAddress, normalizeName } from "./tceq-names";
import { loadFacilities } from "./load-facilities";
import {
  createTceqSession,
  dedupeByPermit,
  fetchTxr15Summary,
  searchTxr15,
  TceqNarrowSearchError,
  TceqRequestError,
  type TceqCriteria,
  type TceqRow,
  type TceqSummary,
} from "./tceq-client";

export const DEFAULT_LIMIT = 5;
export const DEFAULT_LOOKBACK_DAYS = 120;
/** One TCEQ search covers at most this many days; longer windows are split. */
export const MAX_CHUNK_DAYS = 30;
const WATER_MAX = 100;
const FIELD_MAX = 60;
export const MAX_LOOKBACK_DAYS = 365;
export const MAX_LIMIT = 50;
export const NOTE_MAX = 500;
/** Every TCEQ permit-summary url a lead or facility source carries contains this. */
export const TCEQ_URL_FRAGMENT = "www2.tceq.texas.gov/wq_dpa/";

export type PermitRule = "keyword" | "sic7374" | "knownOperator";

const RULE_LABEL: Record<PermitRule, string> = {
  keyword: "data-center or crypto keyword",
  sic7374: "SIC 7374",
  knownOperator: "known operator",
};

// ============================================================================
// Matching
// ============================================================================

const KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bdata\s*cent(?:er|re)s?\b/i,
  /\bdatacent(?:er|re)s?\b/i,
  /\bhyperscale\b/i,
  /\bbitcoin\b/i,
  /\bcrypto/i,
];

/** Trailing business-entity tokens, stripped from the END only, repeatedly. */
const ENTITY_SUFFIXES: readonly (readonly string[])[] = [
  ["p", "l", "l", "c"],
  ["l", "l", "c"],
  ["l", "l", "p"],
  ["l", "p"],
  ["pllc"],
  ["llc"],
  ["inc"],
  ["incorporated"],
  ["lp"],
  ["llp"],
  ["ltd"],
  ["limited"],
  ["corp"],
  ["corporation"],
  ["co"],
  ["company"],
];

const MIN_OPERATOR_KEY = 4;

function baseTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[.']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Normalized operator key, or "" when too short to match on. */
export function normalizeOperatorName(name: string): string {
  const tokens = baseTokens(name);
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const suffix of ENTITY_SUFFIXES) {
      const start = tokens.length - suffix.length;
      if (start > 0 && suffix.every((t, i) => tokens[start + i] === t)) {
        tokens.length = start;
        stripped = true;
        break;
      }
    }
  }
  const key = tokens.join(" ");
  return key.length >= MIN_OPERATOR_KEY ? key : "";
}

export interface KnownOperators {
  /** normalized operator key -> ids of the facilities that carry it */
  byKey: Map<string, string[]>;
  /** permit numbers already cited by any facility source url */
  sourcePermits: Set<string>;
}

export function permitFromUrl(url: string): string | undefined {
  const m = /[?&]lgl_ident_txt=([A-Za-z0-9]+)/i.exec(url);
  return m ? m[1].toUpperCase() : undefined;
}

export function buildKnownOperators(facilities: Facility[]): KnownOperators {
  const byKey = new Map<string, string[]>();
  const sourcePermits = new Set<string>();
  const add = (name: string | undefined, id: string) => {
    const key = name ? normalizeOperatorName(name) : "";
    if (!key) return;
    const ids = byKey.get(key) ?? [];
    if (!ids.includes(id)) ids.push(id);
    byKey.set(key, ids);
  };
  for (const f of facilities) {
    for (const s of f.sources ?? []) {
      const permit = permitFromUrl(s.url);
      if (permit) sourcePermits.add(permit);
    }
    if (f.facilityType !== "data_center" && f.facilityType !== "crypto_mining") continue;
    add(f.operator, f.id);
    for (const p of f.parties?.ownerEntity ?? []) add(p.name, f.id);
  }
  return { byKey, sourcePermits };
}

export function hasKeyword(text: string): boolean {
  return KEYWORD_PATTERNS.some((re) => re.test(text));
}

export interface RowMatch {
  rules: PermitRule[];
  /** facility ids sharing the exactly-matched operator; empty unless knownOperator matched */
  operatorFacilityIds: string[];
}

export function matchRow(row: TceqRow, known: KnownOperators): RowMatch | null {
  const rules: PermitRule[] = [];
  if (hasKeyword(`${row.siteName}\n${row.permittee}`)) rules.push("keyword");
  if (row.sic?.trim() === "7374") rules.push("sic7374");
  const key = normalizeOperatorName(row.permittee);
  const operatorFacilityIds = key ? (known.byKey.get(key) ?? []) : [];
  if (operatorFacilityIds.length > 0) rules.push("knownOperator");
  return rules.length > 0 ? { rules, operatorFacilityIds } : null;
}

// ============================================================================
// Note
// ============================================================================

const EMAIL_OR_PHONE_RE = /@|\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4}/;

/** Free text from TCEQ that is safe to repeat: no email- or phone-shaped content. */
function safeText(s: string | undefined): string | undefined {
  const t = (s ?? "").replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return t && !EMAIL_OR_PHONE_RE.test(t) ? t : undefined;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Receiving water is a filer-entered free-text field: withhold anything contact-shaped, cap the rest. */
export function receivingWaterText(raw: string | undefined): string | undefined {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (/@|http|\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/i.test(t)) return "withheld (free text)";
  return capText(t.replace(/"/g, "'"), WATER_MAX);
}

/** Cuts to `max` characters without splitting a surrogate pair; a trailing "…" marks the cut. */
function capText(s: string, max: number): string {
  return s.length > max ? `${dropTrailingHighSurrogate(s.slice(0, max))}…` : s;
}

const MAX_LISTED_IDS = 3;

export function buildNote(
  row: TceqRow,
  summary: TceqSummary,
  match: RowMatch,
): string {
  const knownOperator = match.rules.includes("knownOperator");
  // Gate on the exact string that would be printed, never on a different field's value.
  // The guard and the printed text are both the NFKC-normalized name.
  const siteRaw = normalizeName(summary.siteName ?? row.siteName);
  const siteShown = knownOperator || hasKeyword(siteRaw);
  const siteSafe = siteShown ? safeText(siteRaw) : undefined;
  const site = siteSafe && !looksLikeAddress(siteSafe) ? siteSafe : undefined;
  const permittee = knownOperator ? safeText(row.permittee) : undefined;
  const countyRaw = safeText(summary.county ?? row.county);
  const county = countyRaw ? capText(countyRaw, FIELD_MAX) : undefined;
  const water = receivingWaterText(summary.receivingWater);
  const segmentRaw = safeText(summary.segment ?? row.segment);
  const segment = segmentRaw ? capText(segmentRaw, FIELD_MAX) : undefined;
  const sic = row.sic?.trim();

  const ids = match.operatorFacilityIds;
  const listed = ids.slice(0, MAX_LISTED_IDS).join(", ");
  const existing =
    ids.length === 0 ? undefined : ids.length > MAX_LISTED_IDS ? `${listed} and ${ids.length - MAX_LISTED_IDS} more` : listed;

  const est =
    summary.estimatedStart && summary.estimatedEnd
      ? `est. construction ${summary.estimatedStart} to ${summary.estimatedEnd}`
      : summary.estimatedStart
        ? `est. construction start ${summary.estimatedStart}`
        : summary.estimatedEnd
          ? `est. construction end ${summary.estimatedEnd}`
          : undefined;
  const hasLocation = site !== undefined && summary.lat !== undefined && summary.lon !== undefined;

  // Optional parts, listed in the order they are dropped when the note would exceed NOTE_MAX.
  const optional: Record<string, string | undefined> = {
    existing,
    location: hasLocation ? `permit location ${summary.lat!.toFixed(6)}, ${summary.lon!.toFixed(6)}` : undefined,
    est,
    water: water ? `receiving water ${water}${segment ? ` (segment ${segment})` : ""}` : undefined,
    coverage: summary.coverageBegan ? `coverage began ${summary.coverageBegan}` : undefined,
    county: county ? `${titleCase(county)} County` : undefined,
    acres: summary.areaDisturbedAcres !== undefined ? `${summary.areaDisturbedAcres} acres disturbed` : undefined,
  };
  const dropOrder = ["existing", "location", "est", "water", "coverage", "county", "acres"] as const;
  const matched = match.rules.map((r) => RULE_LABEL[r]).join(", ");

  let siteWithheld = "site name withheld";
  const render = (drop: Set<string>, siteText: string | undefined): string => {
    const head =
      `TCEQ permit lane: TXR15 construction stormwater permit ${row.permitNumber}` +
      (siteText ? `, site "${siteText}"` : `, ${siteWithheld}`) +
      (permittee ? `, permittee ${permittee}` : ", permittee withheld") +
      (sic && /^\d{4}$/.test(sic) ? `, SIC ${sic}` : "");
    // Segment order mirrors the documented format; "existing" is the trailing sentence.
    const segments = (["acres", "water", "county", "coverage", "est", "location"] as const)
      .filter((k) => !drop.has(k))
      .map((k) => optional[k])
      .filter((v): v is string => Boolean(v));
    return (
      head +
      (segments.length ? `; ${segments.join("; ")}` : "") +
      `. Matched: ${matched}.` +
      (!drop.has("existing") && existing ? ` Existing records with this operator: ${existing}.` : "")
    );
  };

  const dropped = new Set<string>();
  let note = render(dropped, site);
  for (const key of dropOrder) {
    if (note.length <= NOTE_MAX) break;
    dropped.add(key);
    note = render(dropped, site);
  }
  if (note.length > NOTE_MAX && site) {
    // A site name is never printed cut short: withhold it, and the coordinates with it.
    siteWithheld = "site name withheld (too long)";
    dropped.add("location");
    note = render(dropped, undefined);
  }
  return note;
}

/** Fallback note: permit number and rules only, no TCEQ-sourced free text. */
export function buildMinimalNote(row: TceqRow, match: RowMatch, reason: "unreadable" | "refused"): string {
  const matched = match.rules.map((r) => RULE_LABEL[r]).join(", ");
  return (
    `TCEQ permit lane: TXR15 construction stormwater permit ${row.permitNumber}. Matched: ${matched}. ` +
    (reason === "unreadable" ? "TCEQ summary page unreadable; open the link." : "Details omitted; open the TCEQ link.")
  );
}

/** Only HTTP 404 and 410 are permanent; everything else (401/403, 5xx, redirects, parse errors, timeouts...) may clear. */
export function isPermanentSummaryError(err: unknown): boolean {
  return err instanceof TceqRequestError && err.permanent;
}

/** A fixed, content-free description of a search failure for stderr. */
function describeSearchError(err: unknown): string {
  if (err instanceof TceqRequestError) return `${err.kind}${err.status ? ` ${err.status}` : ""}`;
  return err instanceof TceqNarrowSearchError ? "too large" : `error ${redactedErrorCode(err)}`;
}

// ============================================================================
// Core
// ============================================================================

export interface PermitLaneOptions {
  limit: number;
  lookbackDays: number;
  /** ISO date; overrides lookbackDays for a manual backfill */
  since?: string;
  dryRun: boolean;
  runId: string;
}

export interface PermitLaneDeps {
  loadFacilitiesImpl: () => Promise<Facility[]>;
  searchImpl: (criteria: TceqCriteria) => Promise<{ reported: number; rows: TceqRow[]; droppedRows?: number }>;
  fetchSummaryImpl: (url: string) => Promise<TceqSummary>;
  listLeadUrlsImpl: (fragment: string) => Promise<string[]>;
  createLeadImpl: (input: { url: string; note: string }) => Promise<DiscoveryLeadResult>;
  now: () => Date;
  /** Progress and diagnostics (stderr). Permit numbers and rules only, never a name. */
  log: (message: string) => void;
}

export interface PermitLaneLead {
  permitNumber: string;
  url: string;
  note: string;
  rules: PermitRule[];
}

export interface PermitLaneSummary {
  runId: string;
  dryRun: boolean;
  window: { start: string; end: string };
  reported: number;
  rawRows: number;
  /** Result rows whose link was not a TCEQ summary URL (not fetchable; counted, not returned by the client). */
  droppedRows: number;
  /** TCEQ search calls made (a window over 30 days is split; a refused chunk is halved) */
  chunks: number;
  distinctPermits: number;
  matched: number;
  byRule: Record<PermitRule, number>;
  skippedDuplicate: number;
  /** Permanent summary failures (HTTP 404/410 only): filed with a minimal note so dedupe stops the repeat. */
  summaryUnreadable: number;
  /** Candidates not worked because of an outage (3 consecutive transient failures) or a database error. */
  deferredAfterOutage: number;
  /** Rows whose permit number was not TXR15 + 2-8 alphanumerics. */
  skippedBadPermit: number;
  inserted?: number;
  wouldInsert?: number;
  failures: number;
  leads: PermitLaneLead[];
}

interface DateRange {
  start: string;
  end: string;
}

const PERMIT_NUMBER_RE = /^TXR15[0-9A-Z]{2,8}$/;
/** This many CONSECUTIVE transient failures (searches and summary fetches share one counter) is an outage. */
const OUTAGE_THRESHOLD = 3;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Consecutive, non-overlapping inclusive ranges of at most `maxDays` days. */
export function chunkWindow(start: string, end: string, maxDays: number): DateRange[] {
  const out: DateRange[] = [];
  for (let from = start; from <= end; ) {
    const to = addDays(from, maxDays - 1);
    out.push({ start: from, end: to < end ? to : end });
    from = addDays(from, maxDays);
  }
  return out;
}

/** Two halves of a range, or null for a single day. */
function splitRange(r: DateRange): [DateRange, DateRange] | null {
  const days = daysBetween(r.start, r.end) + 1;
  if (days <= 1) return null;
  const mid = addDays(r.start, Math.ceil(days / 2) - 1);
  return [
    { start: r.start, end: mid },
    { start: addDays(mid, 1), end: r.end },
  ];
}

const TEXAS_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD for `now` in America/Chicago (TCEQ's calendar). */
export function texasToday(now: Date): string {
  return TEXAS_DATE.format(now);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function runPermitLane(rawOpts: PermitLaneOptions, deps: PermitLaneDeps): Promise<PermitLaneSummary> {
  if (rawOpts.since !== undefined) isoDate("since", rawOpts.since);
  // Clamped here too, so a caller other than the CLI cannot exceed the caps.
  const opts: PermitLaneOptions = {
    ...rawOpts,
    limit: Math.min(Math.max(1, Math.floor(rawOpts.limit) || 1), MAX_LIMIT),
    lookbackDays: Math.min(Math.max(1, Math.floor(rawOpts.lookbackDays) || 1), MAX_LOOKBACK_DAYS),
  };
  // Today's Texas date: TCEQ answers a search whose end date is still in the future in Texas
  // with the bare search form (no record count), so a UTC date after 19:00 EST would fail closed.
  const end = texasToday(deps.now());
  const earliest = addDays(end, 1 - MAX_LOOKBACK_DAYS);
  const start = opts.since ? (opts.since < earliest ? earliest : opts.since) : addDays(end, 1 - opts.lookbackDays);
  const summary: PermitLaneSummary = {
    runId: opts.runId,
    dryRun: opts.dryRun,
    window: { start, end },
    reported: 0,
    rawRows: 0,
    droppedRows: 0,
    chunks: 0,
    distinctPermits: 0,
    matched: 0,
    byRule: { keyword: 0, sic7374: 0, knownOperator: 0 },
    skippedDuplicate: 0,
    summaryUnreadable: 0,
    deferredAfterOutage: 0,
    skippedBadPermit: 0,
    failures: 0,
    leads: [],
  };

  // Both reads are fail-closed: without them a duplicate or a known operator cannot be recognized.
  const known = buildKnownOperators(await deps.loadFacilitiesImpl());
  const leadPermits = new Set<string>();
  for (const url of await deps.listLeadUrlsImpl(TCEQ_URL_FRAGMENT)) {
    const permit = permitFromUrl(url);
    if (permit) leadPermits.add(permit);
  }

  // One counter of consecutive transient failures across the search and summary phases;
  // any success resets it.
  let consecutive = 0;
  let searchesSkipped = false;
  const all: TceqRow[] = [];
  const searchRange = async (range: DateRange): Promise<void> => {
    if (consecutive >= OUTAGE_THRESHOLD) {
      searchesSkipped = true;
      return;
    }
    summary.chunks++;
    try {
      const found = await deps.searchImpl({ permitStatus: "ACTIVE", startDate: range.start, endDate: range.end });
      summary.reported += found.reported;
      summary.rawRows += found.rows.length;
      summary.droppedRows += found.droppedRows ?? 0;
      all.push(...found.rows);
      consecutive = 0;
    } catch (err) {
      if (err instanceof TceqNarrowSearchError) {
        const halves = splitRange(range);
        if (halves) {
          deps.log(`search ${range.start}..${range.end} too large, halving`);
          for (const half of halves) await searchRange(half);
          return;
        }
      }
      deps.log(`TCEQ search ${range.start}..${range.end} failed (${describeSearchError(err)})`);
      summary.failures++;
      consecutive++;
    }
  };
  for (const range of chunkWindow(start, end, MAX_CHUNK_DAYS)) await searchRange(range);
  if (searchesSkipped) deps.log("outage: remaining searches skipped");
  const rows = dedupeByPermit(all).filter((r) => {
    if (PERMIT_NUMBER_RE.test(r.permitNumber)) return true;
    summary.skippedBadPermit++;
    deps.log("skipped a row with a malformed permit number");
    return false;
  });
  summary.distinctPermits = rows.length;

  const candidates: { row: TceqRow; match: RowMatch }[] = [];
  for (const row of [...rows].sort((a, b) => a.permitNumber.localeCompare(b.permitNumber))) {
    const match = matchRow(row, known);
    if (!match) continue;
    summary.matched++;
    for (const rule of match.rules) summary.byRule[rule]++;
    const permit = row.permitNumber.toUpperCase();
    if (leadPermits.has(permit) || known.sourcePermits.has(permit)) {
      summary.skippedDuplicate++;
      deps.log(`${row.permitNumber}: skipped, already known (${match.rules.join(", ")})`);
      continue;
    }
    candidates.push({ row, match });
  }

  // Rotate the (permit-number ordered) candidates by a stateless per-day offset, so a cluster of
  // persistently failing permits blocks different candidates on different nights.
  if (candidates.length > 1) {
    const offset = Math.floor(Date.parse(`${end}T00:00:00Z`) / 86_400_000) % candidates.length;
    candidates.push(...candidates.splice(0, offset));
  }
  let done = 0;
  const deferRest = (index: number) => {
    summary.deferredAfterOutage = Math.min(candidates.length - index - 1, Math.max(0, opts.limit - done));
  };
  if (consecutive >= OUTAGE_THRESHOLD) {
    summary.deferredAfterOutage = Math.min(candidates.length, opts.limit);
    candidates.length = 0;
  }
  for (const [index, { row, match }] of candidates.entries()) {
    if (done >= opts.limit) break;
    let note: string;
    try {
      note = buildNote(row, await deps.fetchSummaryImpl(row.summaryUrl), match);
      consecutive = 0;
    } catch (err) {
      if (!isPermanentSummaryError(err)) {
        deps.log(`${row.permitNumber}: summary fetch failed (${err instanceof TceqRequestError ? err.kind : redactedErrorCode(err)})`);
        summary.failures++;
        consecutive++;
        if (consecutive >= OUTAGE_THRESHOLD) {
          deps.log("outage: stopping this run's summary fetches");
          deferRest(index);
          break;
        }
        continue;
      }
      consecutive = 0;
      deps.log(`${row.permitNumber}: summary unreadable, filing a minimal note`);
      summary.summaryUnreadable++;
      note = buildMinimalNote(row, match, "unreadable");
    }
    if (!opts.dryRun) {
      let outcome = await insertLead(deps, row, note);
      if (outcome === "refused") {
        deps.log(`${row.permitNumber}: lead refused, retrying with a minimal note`);
        note = buildMinimalNote(row, match, "refused");
        outcome = await insertLead(deps, row, note);
      }
      if (outcome === "error") {
        // A database error: stop rather than keep fetching summaries we cannot file.
        summary.failures++;
        deferRest(index);
        break;
      }
      if (outcome !== "ok") {
        summary.failures++;
        continue;
      }
    }
    done++;
    summary.leads.push({ permitNumber: row.permitNumber, url: row.summaryUrl, note, rules: match.rules });
    deps.log(`${row.permitNumber}: ${opts.dryRun ? "would insert" : "inserted"} lead (${match.rules.join(", ")})`);
  }
  if (opts.dryRun) summary.wouldInsert = done;
  else summary.inserted = done;
  return summary;
}

async function insertLead(deps: PermitLaneDeps, row: TceqRow, note: string): Promise<"ok" | "refused" | "error"> {
  try {
    const res = await deps.createLeadImpl({ url: row.summaryUrl, note });
    if (res.ok) return "ok";
    deps.log(`${row.permitNumber}: lead insert refused (${res.error})`);
    return "refused";
  } catch (err) {
    deps.log(`${row.permitNumber}: lead insert failed (${redactedErrorCode(err)})`);
    return "error";
  }
}

export function permitLaneExitCode(summary: PermitLaneSummary): number {
  return summary.failures > 0 ? 1 : 0;
}

// ============================================================================
// CLI
// ============================================================================

export class PermitLaneArgError extends Error {}

function positiveInt(flag: string, raw: string, max: number): number {
  if (!/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > max) {
    throw new PermitLaneArgError(`${flag} must be a positive integer of at most ${max}`);
  }
  return Number(raw);
}

function isoDate(flag: string, raw: string): string {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(raw) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  if (!ok) throw new PermitLaneArgError(`${flag} must be a real date as YYYY-MM-DD`);
  return raw;
}

export function parsePermitLaneArgs(argv: string[], now: () => Date = () => new Date()): PermitLaneOptions {
  const opts: PermitLaneOptions = {
    limit: DEFAULT_LIMIT,
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
    dryRun: false,
    runId: `permit-lane-${now().getTime()}`,
  };
  for (const flag of argv) {
    if (flag === "--dry-run") opts.dryRun = true;
    else if (flag.startsWith("--limit=")) opts.limit = positiveInt("--limit", flag.slice(8), MAX_LIMIT);
    else if (flag.startsWith("--lookback-days=")) opts.lookbackDays = positiveInt("--lookback-days", flag.slice(16), MAX_LOOKBACK_DAYS);
    else if (flag.startsWith("--since=")) opts.since = isoDate("--since", flag.slice(8));
    else if (flag.startsWith("--run-id=")) {
      const id = flag.slice(9);
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new PermitLaneArgError("--run-id must be 1-80 of [A-Za-z0-9._-]");
      opts.runId = id;
    } else throw new PermitLaneArgError(`unknown argument: ${flag.slice(0, 40)}`);
  }
  if (opts.since) {
    const today = texasToday(now());
    if (opts.since > today) throw new PermitLaneArgError("--since must not be in the future");
    if (daysBetween(opts.since, today) + 1 > MAX_LOOKBACK_DAYS) {
      throw new PermitLaneArgError(`--since must be within ${MAX_LOOKBACK_DAYS} days of today`);
    }
  }
  return opts;
}

/** Real network/DB deps. Called only from main(); building it opens nothing until a closure runs. */
export function buildRealDeps(): PermitLaneDeps {
  const session = createTceqSession();
  return {
    loadFacilitiesImpl: async () => {
      const loaded = await loadFacilities();
      console.error(`permit-lane: loaded ${loaded.facilities.length} facilities from ${loaded.source}`);
      if (loaded.dbError) console.error("permit-lane: WARN facilities read fell back to the local snapshot");
      return loaded.facilities;
    },
    searchImpl: (criteria) => searchTxr15(session, criteria),
    fetchSummaryImpl: (url) => fetchTxr15Summary(session, url),
    listLeadUrlsImpl: listLeadUrlsContaining,
    createLeadImpl: createDiscoveryLead,
    now: () => new Date(),
    log: (message) => console.error(`permit-lane: ${message}`),
  };
}

async function main(): Promise<void> {
  let opts: PermitLaneOptions;
  try {
    opts = parsePermitLaneArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof PermitLaneArgError)) throw err;
    // lint-no-raw-error-logs: allow -- PermitLaneArgError only (fixed argv messages built in this file; never a DB error)
    console.error(`permit-lane: ${err.message}`);
    process.exit(2);
  }
  const summary = await runPermitLane(opts, buildRealDeps());
  console.log(JSON.stringify(summary, null, 2));
  process.exit(permitLaneExitCode(summary));
}

if (isEntrypoint(import.meta.url)) {
  main().catch((err) => {
    console.error(formatFatalError(err));
    process.exit(1);
  });
}

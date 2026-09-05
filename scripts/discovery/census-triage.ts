/**
 * census-triage.ts — mechanical triage over the source census's pass-A rejections.
 *
 * READ-ONLY. It re-fetches pages and writes its own JSONL report under
 * discovery-logs/. It never writes Neon, never mutates data/facilities.json,
 * never POSTs to /api/submissions, and — the whole point — never calls a model.
 *
 * Why it exists: pass A asks a model "is this page about this facility?", and
 * its `rejected`s are review candidates, not defects. A sample of 14 press-source
 * rejections found that 13 of the 14 pages DO name the facility — a ~93% false
 * positive rate, because the model does near-literal name matching rather than
 * entity resolution and rejects genuine sources that call a site by a different
 * name (subsidiary, tenant, project codename, operator vs site name).
 *
 * This tool keeps only the intersection that is actually high precision: the
 * model rejected the source AND the page text genuinely never names the
 * facility. That intersection is what caught the one real bug in the sample
 * (aligned-dfw-03-tx, whose cited page contains zero tokens of the name).
 *
 * Candidates = pass-A records with verdict `rejected` and NO `transportFailure`.
 * A transport failure means the page was never read, so there is nothing to
 * re-check — those are ignored rather than counted as findings.
 *
 * Run via: npm run census-triage -- [--in=<path>] [--out=<path>]
 *                                   [--concurrency=N] [--limit=N]
 *
 * `--out` must name a `.jsonl` file under discovery-logs/ — the same guard
 * census-sources.ts uses, so a typo can never truncate a real data file.
 *
 * Uses relative imports throughout, matching scripts/discovery/census-sources.ts and check-sources.ts.
 */
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { fetchPageText, type FetchPageTextResult } from "./fetch-page-text";
import { runWithConcurrency } from "./net-guard";
import { distinctiveEntityTokens } from "./verify-source";

// --- the token rule --------------------------------------------------------

/**
 * Minimum length for a token to count as evidence that a page names a facility.
 *
 * `distinctiveEntityTokens` was written for the verification gate, which applies
 * "any token matches" to a SHORT QUOTE. Here the same test runs against a WHOLE
 * PAGE, where a two-letter token matches almost any English text — and the
 * failure direction is the dangerous one: a spurious match declares "the page
 * names it" and SUPPRESSES a real finding. Measured on the sample:
 * "Microsoft Boydton Campus (BN / Azure East US)" matched on `us`.
 */
export const MIN_STRONG_TOKEN_LENGTH = 4;

/**
 * Tokens that survive `distinctiveEntityTokens` and the length floor but still
 * appear on essentially any energy/infrastructure page, so a match on one of
 * them is no evidence at all. Same suppression hazard as the length floor —
 * observed in the sample, "Vernon LA Campus (with Goodman Group)" matched on
 * `with` and "Google Nebraska AI Campus (proposed)" matched on `proposed`.
 *
 * Deliberately an over-broad list of GENERIC words: dropping a token can only
 * move a facility toward `absent` or `no-strong-tokens` (both reviewed by a
 * human), while keeping one can hide a genuine defect.
 */
export const EXTENDED_STOPWORD_TOKENS: ReadonlySet<string> = new Set([
  "with",
  "proposed",
  "former",
  "new",
  "north",
  "south",
  "east",
  "west",
  "phase",
  "expansion",
  "holdings",
  "energy",
  "power",
  "technology",
  "technologies",
  "digital",
  "cloud",
  "systems",
  "partners",
  "properties",
  "development",
]);

/** A token distinctive enough that finding it on a page is real evidence. */
export function isStrongToken(token: string): boolean {
  return token.length >= MIN_STRONG_TOKEN_LENGTH && !EXTENDED_STOPWORD_TOKENS.has(token);
}

/** The strong tokens of a facility name, de-duplicated, in name order. */
export function strongEntityTokens(name: string): string[] {
  return [...new Set(distinctiveEntityTokens(name).filter(isStrongToken))];
}

/**
 * The distinctive-but-not-strong tokens: too short, or an extended stopword.
 * Tracked (not discarded) so a `weak-only` match is reported rather than
 * silently collapsing into `absent`.
 */
export function weakEntityTokens(name: string): string[] {
  return [...new Set(distinctiveEntityTokens(name).filter((token) => !isStrongToken(token)))];
}

/**
 * The page's lowercase alphanumeric word set. Whole-word membership, not
 * substring: substring matching would report "aligned" inside "misaligned".
 * The tradeoff runs the safe way — a page writing "DFW-03" tokenizes to
 * `dfw` + `03`, so a name token `dfw03` misses and the record lands in
 * `absent` (a human reads it) rather than being suppressed as `named`.
 */
export function pageTokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

// --- machine-data sources --------------------------------------------------

/**
 * A structural test on a URL. Each rule is named so a `machine-data` verdict
 * says WHICH signal fired, and so the whole list is reviewable and testable
 * the way `EXTENDED_STOPWORD_TOKENS` is.
 */
export interface MachineDataRule {
  name: string;
  /** Why absence of prose is expected for URLs matching this rule. */
  why: string;
  test: (url: URL) => boolean;
}

/**
 * Sources that are structurally not prose: GIS feature endpoints and OSM
 * objects. A third of the census's pass-A rejections cite one, and they would
 * ALL fall out as `absent` — an ArcGIS item page or an OSM way genuinely never
 * writes the facility's name in readable text, so "the page doesn't name it"
 * is the expected state, not evidence of a bad citation. Two facilities in the
 * validation slice (32-avenue-of-the-americas-ny, 60-hudson-street-ny) were
 * flagged on the same arcgis.com item URL for exactly this reason.
 *
 * They are classified before the token test and kept out of `absent` entirely,
 * because the only value that list has is precision.
 */
export const MACHINE_DATA_URL_RULES: readonly MachineDataRule[] = [
  {
    name: "arcgis-host",
    why: "an ArcGIS host serves map items and feature layers, not prose",
    // Substring, not suffix: covers arcgis.com, services5.arcgis.com, and
    // self-hosted servers like arcgisserver.digital.mass.gov.
    test: (url) => url.hostname.includes("arcgis"),
  },
  {
    name: "openstreetmap-host",
    why: "an OpenStreetMap object page describes tags, not the facility in prose",
    test: (url) => url.hostname === "openstreetmap.org" || url.hostname.endsWith(".openstreetmap.org"),
  },
  {
    name: "gis-service-path",
    why: "a FeatureServer/MapServer path is a data endpoint",
    test: (url) => /\/(feature|map)server(\/|$)/i.test(url.pathname),
  },
  {
    name: "data-format-query",
    why: "an f=json / f=geojson query asks for data, not a document",
    test: (url) => {
      const format = url.searchParams.get("f")?.toLowerCase();
      return format === "json" || format === "geojson";
    },
  },
];

/** The first machine-data rule a URL matches, or undefined. */
export function matchMachineDataRule(rawUrl: string): MachineDataRule | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Unparseable URLs are not assumed machine data — they fall through to the
    // token test, which is the direction that keeps a finding visible.
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  const normalized = new URL(url.href);
  normalized.hostname = hostname;
  return MACHINE_DATA_URL_RULES.find((rule) => rule.test(normalized));
}

/** Key for the (facility, url) → source-kind join against data/facilities.json. */
export function sourceKindKey(facilityId: string, url: string): string {
  return `${facilityId}\u0000${url}`;
}

// --- census input ----------------------------------------------------------

/** The subset of a census JSONL record this tool reads. */
export interface CensusRecord {
  pass: string;
  facilityId: string;
  facilityName: string;
  url: string;
  verdict: string;
  transportFailure?: unknown;
}

/**
 * A pass-A rejection whose page was actually read. A `rejected` carrying
 * `transportFailure` is a bot-wall or a rate limit, not a judgment about the
 * page's content — there is nothing to re-check, so it is never triaged.
 */
export function isTriageCandidate(record: CensusRecord): boolean {
  return record.pass === "a" && record.verdict === "rejected" && record.transportFailure == null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Parses one JSONL line, returning undefined for blank/malformed/unusable lines. */
export function parseCensusLine(line: string): CensusRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  const pass = asString(raw.pass);
  const facilityId = asString(raw.facilityId);
  const url = asString(raw.url);
  const verdict = asString(raw.verdict);
  if (!pass || !facilityId || !url || !verdict) return undefined;
  return {
    pass,
    facilityId,
    facilityName: asString(raw.facilityName) ?? "",
    url,
    verdict,
    transportFailure: raw.transportFailure ?? undefined,
  };
}

export function readCensusReport(reportPath: string): { records: CensusRecord[]; malformed: number } {
  const lines = readFileSync(reportPath, "utf8").split("\n");
  const records: CensusRecord[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseCensusLine(line);
    if (record) records.push(record);
    else malformed += 1;
  }
  return { records, malformed };
}

// --- triage ----------------------------------------------------------------

export type TriageBucket =
  | "absent"
  | "weak-only"
  | "named"
  | "unreadable"
  | "no-strong-tokens"
  | "machine-data";

export interface TriageRecord {
  facilityId: string;
  /** The name the tokens were derived from (live name where available). */
  facilityName: string;
  /** Set when data/facilities.json disagrees with the census record's name. */
  censusName?: string;
  nameSource: "live" | "census";
  url: string;
  bucket: TriageBucket;
  strongTokens: string[];
  matchedStrong: string[];
  weakTokens: string[];
  matchedWeak: string[];
  /** Present only for `unreadable`. */
  fetchFailure?: string;
  /** Present only for `machine-data` — which signal fired (source kind or URL rule). */
  machineDataReason?: string;
  triagedAt: string;
}

export interface TriageProgress {
  completed: number;
  total: number;
}

export interface TriageDeps {
  /** Preferred injection point — tests supply a stub so nothing touches DNS. */
  fetchPageTextImpl?: (url: string) => Promise<FetchPageTextResult>;
  /** Convenience for callers that only have a fetch; ignored if the above is set. */
  fetchImpl?: typeof fetch;
  /** Live facility names by id; a missing id falls back to the census record's name. */
  liveNames?: ReadonlyMap<string, string>;
  /**
   * Source `kind` by `sourceKindKey(facilityId, url)`, joined from
   * data/facilities.json. `osm` marks a machine-data source that no URL rule
   * would necessarily catch.
   */
  sourceKinds?: ReadonlyMap<string, string>;
  concurrency?: number;
  limit?: number;
  onRecord?: (record: TriageRecord) => void;
  onProgress?: (progress: TriageProgress) => void;
  now?: () => Date;
}

/** Fetches reported every N completions, so a long run is never silent. */
export const PROGRESS_INTERVAL = 25;

export const DEFAULT_CONCURRENCY = 5;

/** The one directory this tool is allowed to write. */
export const REPORT_DIR = "discovery-logs";

export const DEFAULT_INPUT = `${REPORT_DIR}/census-passA.jsonl`;

function describeFetchFailure(result: Extract<FetchPageTextResult, { ok: false }>): string {
  return result.httpStatus === undefined ? result.reason : `${result.reason} (HTTP ${result.httpStatus})`;
}

/**
 * Why this source is machine data, or undefined if it is prose. Either signal
 * qualifies: the curated source `kind` (which knows an OSM citation even when
 * the URL does not say so) or a structural URL rule.
 */
export function machineDataReason(
  record: CensusRecord,
  sourceKinds?: ReadonlyMap<string, string>,
): string | undefined {
  const kind = sourceKinds?.get(sourceKindKey(record.facilityId, record.url));
  if (kind === "osm") return "source kind osm";
  const rule = matchMachineDataRule(record.url);
  return rule === undefined ? undefined : `${rule.name}: ${rule.why}`;
}

/**
 * Re-checks every candidate mechanically. Fetches are de-duplicated by URL (one
 * page can be cited by several facilities) and run in parallel — unlike the
 * census, there is no model in the loop to serialize on.
 */
export async function runTriage(records: CensusRecord[], deps: TriageDeps = {}): Promise<TriageRecord[]> {
  const { fetchImpl, liveNames, sourceKinds, onRecord, onProgress } = deps;
  const fetchPageTextImpl =
    deps.fetchPageTextImpl ??
    (fetchImpl ? (url: string) => fetchPageText(url, { fetchImpl }) : undefined);
  const now = deps.now ?? (() => new Date());
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const candidates = records.filter(isTriageCandidate);
  const selected = deps.limit === undefined ? candidates : candidates.slice(0, deps.limit);

  interface Unit {
    record: CensusRecord;
    facilityName: string;
    censusName?: string;
    nameSource: "live" | "census";
    strongTokens: string[];
    weakTokens: string[];
    /** Set when the source is machine data — the token test does not apply. */
    machineDataReason?: string;
  }

  const units: Unit[] = selected.map((record) => {
    const live = liveNames?.get(record.facilityId);
    const facilityName = live ?? record.facilityName;
    return {
      record,
      facilityName,
      censusName: live !== undefined && live !== record.facilityName ? record.facilityName : undefined,
      nameSource: live !== undefined ? "live" : "census",
      strongTokens: strongEntityTokens(facilityName),
      weakTokens: weakEntityTokens(facilityName),
      machineDataReason: machineDataReason(record, sourceKinds),
    };
  });

  // Neither a machine-data source nor a name with no strong tokens can be
  // tested, so neither may reach the high-precision `absent` list — and
  // neither needs a fetch.
  const testable = units.filter(
    (unit) => unit.machineDataReason === undefined && unit.strongTokens.length > 0,
  );
  const urls = [...new Set(testable.map((unit) => unit.record.url))];

  const pages = new Map<string, FetchPageTextResult>();
  let completed = 0;
  await runWithConcurrency(urls, concurrency, async (url) => {
    let result: FetchPageTextResult;
    try {
      if (!fetchPageTextImpl) throw new Error("no fetch implementation was provided");
      result = await fetchPageTextImpl(url);
    } catch {
      // runWithConcurrency does not catch worker throws, and an uncaught one
      // would reject the whole batch. Bucket it as unreadable instead.
      result = { ok: false, reason: "network_error" };
    }
    pages.set(url, result);
    completed += 1;
    if (completed % PROGRESS_INTERVAL === 0) onProgress?.({ completed, total: urls.length });
  });

  const triagedAt = now().toISOString();
  const out: TriageRecord[] = [];
  for (const unit of units) {
    const base = {
      facilityId: unit.record.facilityId,
      facilityName: unit.facilityName,
      ...(unit.censusName === undefined ? {} : { censusName: unit.censusName }),
      nameSource: unit.nameSource,
      url: unit.record.url,
      strongTokens: unit.strongTokens,
      weakTokens: unit.weakTokens,
      triagedAt,
    };

    let record: TriageRecord;
    if (unit.machineDataReason !== undefined) {
      // Checked BEFORE the token test: a GIS/OSM endpoint not naming the
      // facility in prose is the expected state, not a bad citation.
      record = {
        ...base,
        bucket: "machine-data",
        matchedStrong: [],
        matchedWeak: [],
        machineDataReason: unit.machineDataReason,
      };
    } else if (unit.strongTokens.length === 0) {
      record = { ...base, bucket: "no-strong-tokens", matchedStrong: [], matchedWeak: [] };
    } else {
      const page = pages.get(unit.record.url);
      if (!page || !page.ok) {
        record = {
          ...base,
          bucket: "unreadable",
          matchedStrong: [],
          matchedWeak: [],
          fetchFailure: page ? describeFetchFailure(page) : "not fetched",
        };
      } else {
        const tokens = pageTokenSet(page.text);
        const matchedStrong = unit.strongTokens.filter((token) => tokens.has(token));
        const matchedWeak = unit.weakTokens.filter((token) => tokens.has(token));
        const bucket: TriageBucket =
          matchedStrong.length > 0 ? "named" : matchedWeak.length > 0 ? "weak-only" : "absent";
        record = { ...base, bucket, matchedStrong, matchedWeak };
      }
    }

    out.push(record);
    onRecord?.(record);
  }

  return out;
}

// --- reporting -------------------------------------------------------------

export function tallyBuckets(records: TriageRecord[]): Record<TriageBucket, number> {
  const tallies: Record<TriageBucket, number> = {
    absent: 0,
    "weak-only": 0,
    named: 0,
    unreadable: 0,
    "no-strong-tokens": 0,
    "machine-data": 0,
  };
  for (const record of records) tallies[record.bucket] += 1;
  return tallies;
}

/** Human summary: the actionable `absent` list first, then counts. */
export function formatSummary(records: TriageRecord[], elapsedMs?: number): string {
  const tallies = tallyBuckets(records);
  const absent = records.filter((record) => record.bucket === "absent");
  const lines: string[] = [];

  lines.push("");
  lines.push(`REVIEW THESE — ${absent.length} candidate(s) where the page never names the facility`);
  lines.push("=".repeat(72));
  if (absent.length === 0) {
    lines.push("  (none — every readable page named its facility)");
  }
  for (const record of absent) {
    lines.push(`  ${record.facilityId} — ${record.facilityName}`);
    lines.push(`    ${record.url}`);
    lines.push(`    searched for (none found): ${record.strongTokens.join(", ")}`);
    if (record.censusName !== undefined) {
      lines.push(`    note: census recorded the name as "${record.censusName}"`);
    }
  }

  lines.push("");
  lines.push("Other buckets (not findings)");
  lines.push("-".repeat(72));
  lines.push(`  named             ${tallies.named}  page names the facility — model rejection was a false positive`);
  lines.push(`  weak-only         ${tallies["weak-only"]}  only short/generic tokens matched — inconclusive`);
  lines.push(`  unreadable        ${tallies.unreadable}  re-fetch failed now (bot-wall / rate limit)`);
  lines.push(`  no-strong-tokens  ${tallies["no-strong-tokens"]}  name yields no testable token — this check cannot speak to them`);
  lines.push(`  machine-data      ${tallies["machine-data"]}  GIS/OSM data citation — a missing facility name in page text is expected, not a bad source`);
  lines.push("");
  lines.push(`  triaged ${records.length} candidate(s)${elapsedMs === undefined ? "" : ` in ${(elapsedMs / 1000).toFixed(0)}s`}`);
  lines.push(`  ABSENT COUNT: ${absent.length}`);

  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------

/**
 * Guards the one path this tool writes — mirrors census-sources.ts. Without it
 * `--out=data/facilities.json` would truncate the live dataset on first open().
 */
export function assertSafeReportPath(candidate: string, cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd, candidate);
  const relative = path.relative(path.resolve(cwd, REPORT_DIR), resolved);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`--out must be a path under ${REPORT_DIR}/ (got "${candidate}")`);
  }
  if (!resolved.endsWith(".jsonl")) {
    throw new Error(`--out must name a .jsonl report file (got "${candidate}")`);
  }
  return candidate;
}

export interface CliOptions {
  in: string;
  out: string;
  concurrency: number;
  limit?: number;
}

/** Timestamped run id — deterministic from the clock, never `Math.random`. */
export function makeRunId(now = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/[:]/g, "-");
}

function parsePositiveInt(arg: string, flag: string): number {
  const value = Number(arg.slice(`${flag}=`.length));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${arg}")`);
  }
  return value;
}

export function parseArgs(argv: string[], runId: string): CliOptions {
  let input = DEFAULT_INPUT;
  let out: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  let limit: number | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--in=")) {
      input = arg.slice("--in=".length);
      if (input.length === 0) throw new Error("--in requires a path");
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      if (out.length === 0) throw new Error("--out requires a path");
      assertSafeReportPath(out);
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parsePositiveInt(arg, "--concurrency");
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg, "--limit");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    in: input,
    out: out ?? `${REPORT_DIR}/census-triage-${runId}.jsonl`,
    concurrency,
    limit,
  };
}

/**
 * The live dataset's names (so triage tokenizes the current name, not a stale
 * one) and its per-source `kind` (so an `osm` citation is recognized even when
 * its URL matches no structural rule).
 */
export function loadFacilityIndex(): { names: Map<string, string>; sourceKinds: Map<string, string> } {
  const facilitiesPath = path.join(process.cwd(), "data", "facilities.json");
  const parsed: unknown = JSON.parse(readFileSync(facilitiesPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${facilitiesPath} is not a JSON array`);
  }
  const names = new Map<string, string>();
  const sourceKinds = new Map<string, string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    const id = asString(raw.id);
    const name = asString(raw.name);
    if (!id) continue;
    if (name) names.set(id, name);
    if (!Array.isArray(raw.sources)) continue;
    for (const source of raw.sources) {
      if (typeof source !== "object" || source === null) continue;
      const rawSource = source as Record<string, unknown>;
      const url = asString(rawSource.url);
      const kind = asString(rawSource.kind);
      if (url && kind) sourceKinds.set(sourceKindKey(id, url), kind);
    }
  }
  return { names, sourceKinds };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2), makeRunId());
  const outPath = path.resolve(process.cwd(), assertSafeReportPath(options.out));
  mkdirSync(path.dirname(outPath), { recursive: true });

  const { records, malformed } = readCensusReport(path.resolve(process.cwd(), options.in));
  const { names: liveNames, sourceKinds } = loadFacilityIndex();
  const candidateCount = records.filter(isTriageCandidate).length;

  console.error(`[triage] read ${records.length} census record(s) from ${options.in}`);
  if (malformed > 0) console.error(`[triage] skipped ${malformed} malformed line(s)`);
  console.error(`[triage] ${candidateCount} pass-A rejection(s) with a readable page · concurrency ${options.concurrency}`);
  console.error(`[triage] report -> ${options.out}`);

  const stream = createWriteStream(outPath, { flags: "w" });
  let triaged: TriageRecord[];
  try {
    triaged = await runTriage(records, {
      // Real deps are constructed only here, inside main() — module scope stays
      // import-safe (no network), the way census-sources.ts keeps it.
      fetchImpl: fetch,
      liveNames,
      sourceKinds,
      concurrency: options.concurrency,
      limit: options.limit,
      onRecord: (record) => stream.write(`${JSON.stringify(record)}\n`),
      onProgress: ({ completed, total }) => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.error(`[triage] fetched ${completed}/${total} · ${elapsed}s`);
      },
    });
  } finally {
    await new Promise<void>((resolve) => stream.end(resolve));
  }

  console.log(formatSummary(triaged, Date.now() - startedAt));
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

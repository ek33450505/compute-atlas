/**
 * triage-disagreements.ts — mechanical post-processor over a verify-fields.ts report.
 *
 * READ-ONLY, standalone, and deliberately NOT wired into the verification sweep
 * (issue #217's "outstanding deliverable"). It never opens a DB connection, never
 * calls a model, never makes a network request, and never writes anything except
 * an optional `--out` JSON report and stdout/stderr. Given any past verify-fields
 * report, it can be re-run at any time without re-verifying a single source.
 *
 * === WHY THIS EXISTS ===
 * The full-dataset sweep verify-fields.ts asks for is already done: 766/766
 * capacity values checked, 747 machine-confirmed, 149 disagreements, 2,706 source
 * checks attempted. This tool does NOT re-sweep and does NOT touch the
 * verification prompt (bench-measured at P=100%/R=100% for
 * `capacityMw.operational` — see verify-fields.ts's header; editing that prompt
 * invalidates the measurement). It exists because the disagreement LIST itself
 * is inflated by a structural false positive this project creates on purpose:
 * a compute site and its co-located generation (or a campus split into several
 * buildings, or a company-wide filing) are recorded as SEPARATE facilities that
 * cite the SAME source document — so a model checking one facility's value can
 * read the OTHER site's figure out of a shared page and report a "disagreement"
 * that is not a data defect at all.
 *
 * Measured on the real sweep at 215/766 values checked: of 7 disagreements, 4
 * shared a source with a sibling facility and were explained by the records' own
 * `notes`; only 3 shared no source with anything and were the real triage queue.
 * The clearest tell observed was a MIRROR-IMAGE pair — two facilities whose
 * recorded and source-stated values are exact swaps of each other (facility A
 * recorded 1400, its source said 1000; facility B recorded 1000, its source said
 * 1400 — a shared-document campus split, not two wrong numbers). That pattern
 * gets its own label below because it is the strongest possible signal that a
 * "disagreement" is actually one document describing two related facilities.
 *
 * === THE FILTER IS A SET INTERSECTION. NO MODEL. NO NETWORK. ===
 * For every `outcome === "disagreement"` result in the report, this tool finds
 * every OTHER facility in data/facilities.json whose own `sources[].url` set
 * intersects the disagreeing facility's `sources[].url` set, and partitions on
 * whether any such sibling exists. That is the entire mechanism.
 *
 * === MACHINE-DATA URLS ARE EXCLUDED FROM THE INTERSECTION — A REAL FINDING, NOT SPECULATION ===
 * Running the naive version of this filter against the real 2026-09-05 nightly
 * report produced a false explosion: `aligned-ord-01-il` "shared a source" with
 * over 280 unrelated facilities, because it cites the same generic ArcGIS map
 * item (`arcgis.com/home/item.html?id=...`) that 307 of this dataset's 1,405
 * facilities cite as a supplementary source (see
 * compute-atlas-nondocument-sources-are-real-provenance memory — that URL is
 * real provenance for `energy.utility`, but it is structurally an index/map, not
 * a project-specific document, so sharing it is zero evidence of a same-campus
 * split). Left in, it would have buried the one real signal for that facility —
 * after excluding it, `aligned-ord-01-il` instead correctly surfaces its actual
 * siblings: two other Aligned buildings on the same Chicago campus that share a
 * campus marketing page. The exclusion reuses `matchMachineDataRule` from
 * census-triage.ts VERBATIM (import, not duplicated) — that module already
 * carries the tested, documented rule set for "this URL is structurally not
 * prose" (ArcGIS/OSM hosts, FeatureServer/MapServer paths, f=json|geojson
 * queries), built for an unrelated purpose (page-text token matching) but the
 * same underlying fact — a shared index page proves nothing about the two
 * citing facilities being related — transfers directly here.
 *
 * === URL NORMALIZATION ===
 * Two URLs are treated as the same source if they agree after lowercasing the
 * scheme and host, stripping a trailing `#fragment`, and stripping a single
 * trailing slash from the path. Query strings are NEVER stripped or ignored —
 * on a permit portal or a paginated filing, the query string can be the entire
 * identity of the specific record being cited, so treating `?id=1` and `?id=2`
 * as "the same source" would manufacture false siblings out of two genuinely
 * different documents on the same host.
 *
 * === FRAMING (also emitted in the printed summary and the --out JSON) ===
 * A `sharedSourceSiblings` entry is DEPRIORITIZED, NOT DISMISSED, and a
 * `uniqueSource` entry is a CANDIDATE, not a confirmed defect. This tool cannot
 * read a record's `notes` or adjudicate which number is right — see
 * verify-fields.ts's own header on why a disagreement is a QUESTION, never an
 * auto-applied correction. Every entry here — in both buckets — still needs a
 * human to read its cited sources and notes. Also worth carrying forward: 27%
 * of source checks in the full sweep came back `unreachable` (link rot,
 * paywalls, bot-walls), so the underlying report's `confirmed` count is a
 * floor on correctness, never a clean bill of health.
 *
 * Run via: npx tsx scripts/discovery/triage-disagreements.ts --report=<path>.json
 *                                                             [--facilities=data/facilities.json]
 *                                                             [--out=<path>.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { matchMachineDataRule } from "./census-triage";
import type { SourceVerification, VerifyFieldsSummary } from "./verify-fields";
import type { Facility } from "../../lib/schema";

// ============================================================================
// URL normalization
// ============================================================================

/**
 * Normalizes a source URL for set-membership comparison. Lowercases the scheme
 * and host, strips a trailing `#fragment`, and strips one trailing slash from a
 * non-root path — but leaves the query string byte-for-byte, since a query
 * string can be the whole identity of a specific cited record (see file header).
 * Falls back to a best-effort string normalization for a value `new URL()`
 * cannot parse, so a malformed source URL still participates in comparisons
 * (as itself) rather than silently dropping out of every intersection.
 */
export function normalizeSourceUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl.trim().replace(/#.*$/, "").replace(/([^/])\/$/, "$1").toLowerCase();
  }
  url.hash = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

// ============================================================================
// Facility source-URL index — the whole mechanism runs over this
// ============================================================================

/**
 * Facility id -> the normalized set of its cited source URLs, EXCLUDING any URL
 * `matchMachineDataRule` flags as structurally not prose (see file header). A
 * facility's entire cited-source set is used, not just the one source URL named
 * in a particular disagreement result — a sibling facility can share a DIFFERENT
 * one of the disagreeing facility's sources than the one the model happened to
 * flag.
 */
export function buildSourceUrlIndex(facilities: Facility[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const facility of facilities) {
    const urls = new Set<string>();
    for (const source of facility.sources ?? []) {
      if (matchMachineDataRule(source.url)) continue;
      urls.add(normalizeSourceUrl(source.url));
    }
    index.set(facility.id, urls);
  }
  return index;
}

export function buildFacilityNameIndex(facilities: Facility[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const facility of facilities) names.set(facility.id, facility.name);
  return names;
}

// ============================================================================
// Mirror-image detection
// ============================================================================

// COUPLING: mirrors verify-fields.ts's (and, upstream, extract-fields.ts's)
// unexported `RECONCILE_TOLERANCE = 0.05` — the same 5% relative tolerance used
// to decide whether two numbers count as "the same fact". Mirrored locally,
// not imported, so this read-only triage tool has zero RUNTIME coupling to the
// verification pipeline it post-processes — only TYPES are imported from
// verify-fields.ts (see file header). Keep this in sync if that constant ever
// changes; this file's own test suite would not catch a drift.
const RECONCILE_TOLERANCE = 0.05;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) < RECONCILE_TOLERANCE;
}

/**
 * A disagreement's mirror partner: another disagreement, on a facility that
 * shares a source with this one, on the SAME field, where the two values are an
 * exact swap — A's recorded value matches B's source-stated value AND B's
 * recorded value matches A's source-stated value (both within the 5% numeric
 * tolerance above). This is the strongest available signal that one document
 * describes two related facilities rather than that either record is wrong.
 * Only ever considered for the two numeric-field cases this tool's callers
 * exercise; a non-numeric field (`energy.source`/`energy.utility`) can never
 * match here, which is correct — a "swap" is not a meaningful concept for
 * strings compared by exact-ish equality.
 */
export function findMirrorImage(
  entry: SourceVerification,
  siblingIds: ReadonlySet<string>,
  allDisagreements: readonly SourceVerification[],
): SourceVerification | undefined {
  // Narrowed into locals before the closure below: TypeScript does not retain
  // a property narrowing (`entry.recordedValue`) across a nested closure
  // boundary, only a narrowing of the local `const` itself.
  const entryRecorded = entry.recordedValue;
  const entrySourceStated = entry.sourceStatedValue;
  if (!isFiniteNumber(entryRecorded) || !isFiniteNumber(entrySourceStated)) {
    return undefined;
  }
  return allDisagreements.find((other) => {
    if (other === entry) return false;
    if (!siblingIds.has(other.facilityId)) return false;
    if (other.field !== entry.field) return false;
    const otherRecorded = other.recordedValue;
    const otherSourceStated = other.sourceStatedValue;
    if (!isFiniteNumber(otherRecorded) || !isFiniteNumber(otherSourceStated)) return false;
    return (
      approximatelyEqual(entryRecorded, otherSourceStated) && approximatelyEqual(otherRecorded, entrySourceStated)
    );
  });
}

// ============================================================================
// Triage — the core, testable function
// ============================================================================

export interface SiblingMatch {
  facilityId: string;
  facilityName: string;
  /** The specific normalized URL(s) shared with this sibling, named explicitly
   * so a human can check the claim rather than trust the label. */
  sharedSourceUrls: string[];
}

export interface MirrorImageMatch {
  facilityId: string;
  facilityName: string;
  recordedValue: number | string;
  sourceStatedValue: number | string | null | undefined;
}

export type DisagreementCategory = "sharedSourceSiblings" | "uniqueSource";

export interface TriagedDisagreement {
  facilityId: string;
  facilityName: string;
  field: SourceVerification["field"];
  recordedValue: number | string;
  sourceStatedValue: number | string | null | undefined;
  verbatimQuote?: string | null;
  sourceUrl: string;
  /** DEPRIORITIZED, not dismissed (sharedSourceSiblings) vs. a CANDIDATE, not a
   * confirmed defect (uniqueSource) — see file header's FRAMING section. Never
   * read this field as a verdict. */
  category: DisagreementCategory;
  /** Always empty for `uniqueSource`; always non-empty for `sharedSourceSiblings`. */
  siblings: SiblingMatch[];
  /** Present only when `findMirrorImage` found a reciprocal partner — see that
   * function's doc-comment. Implies `category === "sharedSourceSiblings"`. */
  mirrorImage?: MirrorImageMatch;
}

export interface TriageDisagreementsResult {
  runId: string;
  /** `generatedAt` of the SOURCE verify-fields report, not of this triage run —
   * this tool has no clock-dependent behavior of its own worth timestamping. */
  sourceReportGeneratedAt: string;
  totalDisagreements: number;
  sharedSourceSiblings: TriagedDisagreement[];
  uniqueSource: TriagedDisagreement[];
  /** Count of INDIVIDUAL entries flagged with `mirrorImage` set — a true mirror
   * pair contributes 2 to this count (once from each side), since each side is
   * reported as its own `TriagedDisagreement`. */
  mirrorImageCount: number;
  /** A disagreement whose `facilityId` was not found in the loaded facilities
   * file — an anomaly (stale report vs. current dataset, or a `--facilities`
   * pointed at the wrong file), never silently swallowed. That entry still gets
   * triaged using only its own single `sourceUrl` as its source set. */
  warnings: string[];
}

export function triageDisagreements(
  summary: VerifyFieldsSummary,
  facilities: Facility[],
): TriageDisagreementsResult {
  const disagreements = summary.results.filter((r) => r.outcome === "disagreement");
  const urlIndex = buildSourceUrlIndex(facilities);
  const nameIndex = buildFacilityNameIndex(facilities);
  const warnings: string[] = [];

  const sharedSourceSiblings: TriagedDisagreement[] = [];
  const uniqueSource: TriagedDisagreement[] = [];
  let mirrorImageCount = 0;

  for (const entry of disagreements) {
    let myUrls = urlIndex.get(entry.facilityId);
    if (myUrls === undefined) {
      warnings.push(
        `facility "${entry.facilityId}" (from the report) was not found in the loaded facilities ` +
          `file — falling back to its single reported source URL for sibling detection`,
      );
      myUrls = matchMachineDataRule(entry.sourceUrl) ? new Set() : new Set([normalizeSourceUrl(entry.sourceUrl)]);
    }

    const siblings: SiblingMatch[] = [];
    for (const [otherId, otherUrls] of urlIndex) {
      if (otherId === entry.facilityId) continue;
      const shared = [...myUrls].filter((url) => otherUrls.has(url));
      if (shared.length > 0) {
        siblings.push({ facilityId: otherId, facilityName: nameIndex.get(otherId) ?? otherId, sharedSourceUrls: shared });
      }
    }

    const siblingIds = new Set(siblings.map((s) => s.facilityId));
    const mirrorPartner = findMirrorImage(entry, siblingIds, disagreements);

    const triaged: TriagedDisagreement = {
      facilityId: entry.facilityId,
      facilityName: nameIndex.get(entry.facilityId) ?? entry.facilityName,
      field: entry.field,
      recordedValue: entry.recordedValue,
      sourceStatedValue: entry.sourceStatedValue,
      verbatimQuote: entry.verbatimQuote,
      sourceUrl: entry.sourceUrl,
      category: siblings.length > 0 ? "sharedSourceSiblings" : "uniqueSource",
      siblings,
    };

    if (mirrorPartner) {
      triaged.mirrorImage = {
        facilityId: mirrorPartner.facilityId,
        facilityName: nameIndex.get(mirrorPartner.facilityId) ?? mirrorPartner.facilityName,
        recordedValue: mirrorPartner.recordedValue,
        sourceStatedValue: mirrorPartner.sourceStatedValue,
      };
      mirrorImageCount += 1;
    }

    if (triaged.category === "sharedSourceSiblings") sharedSourceSiblings.push(triaged);
    else uniqueSource.push(triaged);
  }

  return {
    runId: summary.runId,
    sourceReportGeneratedAt: summary.generatedAt,
    totalDisagreements: disagreements.length,
    sharedSourceSiblings,
    uniqueSource,
    mirrorImageCount,
    warnings,
  };
}

// ============================================================================
// Report / facilities loading — clear errors, never a raw stack trace
// ============================================================================

export function loadReport(reportPath: string): VerifyFieldsSummary {
  let raw: string;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch (err) {
    throw new Error(`could not read verify-fields report at "${reportPath}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"${reportPath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { results?: unknown }).results)
  ) {
    throw new Error(`"${reportPath}" does not look like a verify-fields report (missing a top-level "results" array)`);
  }
  return parsed as VerifyFieldsSummary;
}

export function loadFacilitiesFile(facilitiesPath: string): Facility[] {
  let raw: string;
  try {
    raw = readFileSync(facilitiesPath, "utf8");
  } catch (err) {
    throw new Error(`could not read facilities file at "${facilitiesPath}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"${facilitiesPath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`"${facilitiesPath}" is not a JSON array of facilities`);
  }
  return parsed as Facility[];
}

// ============================================================================
// Human-readable summary
// ============================================================================

/**
 * Disagreements first, framing reminders always printed (never only in a
 * doc-comment a report reader will never see), then the `uniqueSource` queue as
 * a table (the actionable list), then `sharedSourceSiblings` with the specific
 * shared URL(s) named per sibling.
 */
export function formatSummary(result: TriageDisagreementsResult): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`=== DISAGREEMENT TRIAGE — run ${result.runId} (source report generated ${result.sourceReportGeneratedAt}) ===`);
  lines.push(
    `${result.totalDisagreements} disagreement(s): ${result.uniqueSource.length} uniqueSource · ` +
      `${result.sharedSourceSiblings.length} sharedSourceSiblings · ${result.mirrorImageCount} flagged mirror-image`,
  );
  lines.push(
    "A sharedSourceSiblings entry is DEPRIORITIZED, NOT DISMISSED; a uniqueSource entry is a CANDIDATE, " +
      "not a confirmed defect. This tool cannot read a record's notes or cited sources — a human still must.",
  );
  lines.push(
    "Reminder: 27% of source checks in the full sweep came back unreachable — the underlying report's " +
      "`confirmed` count is a floor, not a clean bill of health.",
  );

  lines.push("");
  lines.push(`--- uniqueSource (${result.uniqueSource.length}) — the real triage queue ---`);
  if (result.uniqueSource.length === 0) {
    lines.push("  (none)");
  } else {
    for (const d of result.uniqueSource) {
      lines.push(`  ${d.facilityId}  [${d.field}]  recorded=${d.recordedValue}  source=${d.sourceStatedValue}`);
      lines.push(`    ${d.sourceUrl}`);
    }
  }

  lines.push("");
  lines.push(`--- sharedSourceSiblings (${result.sharedSourceSiblings.length}) — deprioritized, not dismissed ---`);
  if (result.sharedSourceSiblings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const d of result.sharedSourceSiblings) {
      const mirrorTag = d.mirrorImage ? " [MIRROR IMAGE]" : "";
      lines.push(`  ${d.facilityId}${mirrorTag}  [${d.field}]  recorded=${d.recordedValue}  source=${d.sourceStatedValue}`);
      for (const sibling of d.siblings) {
        lines.push(`    shares with ${sibling.facilityId}: ${sibling.sharedSourceUrls.join(", ")}`);
      }
      if (d.mirrorImage) {
        lines.push(
          `    mirror partner: ${d.mirrorImage.facilityId} recorded=${d.mirrorImage.recordedValue} source=${d.mirrorImage.sourceStatedValue}`,
        );
      }
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`--- warnings (${result.warnings.length}) ---`);
    for (const warning of result.warnings) lines.push(`  ${warning}`);
  }

  return lines.join("\n");
}

// ============================================================================
// CLI
// ============================================================================

export const DEFAULT_FACILITIES_PATH = "data/facilities.json";

export interface CliOptions {
  reportPath: string;
  facilitiesPath: string;
  outPath?: string;
}

export function parseArgs(argv: string[]): CliOptions {
  let reportPath: string | undefined;
  let facilitiesPath = DEFAULT_FACILITIES_PATH;
  let outPath: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--report=")) {
      reportPath = arg.slice("--report=".length);
    } else if (arg.startsWith("--facilities=")) {
      facilitiesPath = arg.slice("--facilities=".length);
    } else if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!reportPath) {
    throw new Error("--report=<path> is required (a verify-fields.ts JSON report)");
  }

  return { reportPath, facilitiesPath, outPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reportPath = path.resolve(process.cwd(), options.reportPath);
  const facilitiesPath = path.resolve(process.cwd(), options.facilitiesPath);

  const summary = loadReport(reportPath);
  const facilities = loadFacilitiesFile(facilitiesPath);
  const result = triageDisagreements(summary, facilities);

  console.log(formatSummary(result));

  if (options.outPath) {
    const outPath = path.resolve(process.cwd(), options.outPath);
    // This tool is READ-ONLY with respect to the dataset — refuse to let a typo'd
    // --out clobber the facilities file it just read (mirrors the spirit of
    // census-triage.ts's own assertSafeReportPath guard, scoped to the one file
    // that must never be touched here).
    if (outPath === facilitiesPath) {
      throw new Error(`--out must not point at the facilities file ("${options.outPath}")`);
    }
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.error(`[triage-disagreements] wrote ${outPath}`);
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(`[triage-disagreements] ${(err as Error).message ?? err}`);
    process.exit(1);
  });
}

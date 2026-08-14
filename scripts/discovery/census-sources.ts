/**
 * Source-verification census — runs the Track 1 verification gate
 * (verify-source.ts) over the whole live dataset and reports where a cited
 * source does not actually back the record.
 *
 * READ-ONLY. It never writes Neon, never mutates data/facilities.json, never
 * POSTs to /api/submissions. The only thing it writes is its own JSONL report
 * under discovery-logs/. Like check-sources.ts this is a flag/report tool.
 *
 * Two passes, because the two known live bugs fail in different ways and a
 * single flat run cannot find both:
 *
 *   Pass A — entity binding. For every (facility, source) pair, ask the gate
 *     whether the page is about this facility at all, with NO numeric hints.
 *     Catches e.g. aligned-dfw-03-tx citing the Wikipedia page for Oncor
 *     Electric Delivery, a utility company.
 *     Its `rejected`s are REVIEW CANDIDATES, not defects. The model does
 *     near-literal name matching rather than entity resolution, so a genuine
 *     source that calls the site by a different name — subsidiary, tenant,
 *     project codename, operator vs site name — is rejected too. Measured on
 *     springfieldohio.gov's "5C Data Center FAQs", a page entirely about the
 *     facility: our name "5C Group / Vultr Data Center (Prime Ohio)" is
 *     rejected, "5C Data Center" is verified. Expect a substantial
 *     false-positive rate and read each entry before changing any data.
 *
 *   Pass B — capacity backing. For each numeric capacityMw figure, check
 *     whether AT LEAST ONE cited source supports it; the facility is a finding
 *     only when zero sources do. Catches e.g. the Springfield, OH record
 *     claiming planned 150 MW whose cited WYSO article contains no "150".
 *
 * Neither `unavailable` nor `escalate` is ever a finding. Both mean "we could
 * not check" — the model was unreachable, or the fetcher could not structurally
 * ingest the page (size cap / content type) — not "the source is bad". Nor is a
 * `rejected` that carries `transportFailure`: the gate maps most fetch failures
 * to `rejected` because it normally judges untrusted model-proposed URLs, but
 * over a curated dataset a 403 is a bot-wall and a 429 is rate-limiting, not a
 * bad citation. A figure is called unsupported only when a source was actually
 * read and did not back it; unreadable sources are counted and disclosed in the
 * finding's reason, and a unit with no readable source makes no claim at all —
 * it is reported in its own "could not check" section instead. `unavailable`
 * gets its own tally bucket, and three in a row aborts the run loudly rather
 * than manufacturing findings out of an outage.
 *
 * Run via: npm run census-sources -- [--limit=N] [--concurrency=N]
 *                                    [--pass=a|b|both] [--out=<path>] [--resume]
 *
 * `--out` must name a `.jsonl` file under discovery-logs/ — the tool refuses any
 * other path so a typo can never truncate a real data file. `--resume` without
 * `--out` picks up the newest existing report in discovery-logs/ and always says
 * which file it read and how many records it found, including zero.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path alias,
 * matching scripts/discovery/check-sources.ts and submit-candidates.ts.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { runWithConcurrency } from "./net-guard";
import type { VerifyClaim, VerificationResult } from "./verify-source";

// --- types -----------------------------------------------------------------

export type CensusPass = "a" | "b";

export interface CensusSource {
  url?: unknown;
}

/**
 * The subset of a facility this census reads. Deliberately narrower than the
 * `Facility` schema type: the census walks the raw JSON export and must not
 * fail on a record shape it does not care about.
 */
export interface CensusFacility {
  id: string;
  name: string;
  capacityMw?: Record<string, unknown> | null;
  sources?: CensusSource[];
}

/** One line of the JSONL report — one gate call. */
export interface CensusRecord {
  pass: CensusPass;
  facilityId: string;
  facilityName: string;
  url: string;
  /** capacityMw key for pass B; empty string for pass A. */
  hintLabel: string;
  hintValue?: number;
  verdict: VerificationResult["verdict"];
  reason: string;
  viaWayback?: boolean;
  /**
   * Set by the gate only when the page could not be fetched AT ALL (direct
   * fetch failed and Wayback did not rescue it) — never when a page was read.
   * The verdict on those is usually `rejected`, which is right for an untrusted
   * model-proposed URL and wrong for a curated source behind a bot-wall, so the
   * census treats this field as authoritative over the verdict.
   */
  transportFailure?: VerificationResult["transportFailure"];
  checkedAt: string;
}

/**
 * One thing a human should look at. Strength varies by pass: a pass-B entry is
 * a figure that was read and not backed, while a pass-A entry is only a REVIEW
 * CANDIDATE — the model did not recognise our name for the facility on that
 * page, which a genuine source using a different name also produces.
 */
export interface CensusFinding {
  pass: CensusPass;
  facilityId: string;
  facilityName: string;
  /** The unrecognised URL (pass A) or every source checked (pass B). */
  url: string;
  hintLabel?: string;
  hintValue?: number;
  reason: string;
  /** Pass B only: how many of the facility's sources could not be read at all. */
  unreadableSources?: number;
}

export type VerdictTallies = Record<VerificationResult["verdict"], number>;

export interface CensusProgress {
  completed: number;
  /** Upper bound — pass B short-circuits, so the real total lands lower. */
  total: number;
  tallies: VerdictTallies;
}

export interface CensusSummary {
  tallies: VerdictTallies;
  checksRun: number;
  checksSkipped: number;
  /**
   * Things a human should look at. Never includes escalate/unavailable, and
   * never a transport failure — a page we could not fetch is not a citation we
   * disproved. Pass B entries are figures that were read and not backed; pass A
   * entries are review candidates only (see `CensusFinding`), so this list is
   * not a defect count.
   */
  findings: CensusFinding[];
  /** Pass A sources we could not read — for a human to look at, not findings. */
  escalations: CensusFinding[];
  /**
   * Pass B figures where NOT ONE cited source could be read. Nothing was checked,
   * so the figure is neither supported nor unsupported — reported separately so a
   * `Pass B findings: 0` line can never quietly mean "never looked".
   */
  unchecked: CensusFinding[];
  aborted: boolean;
  abortReason?: string;
}

export type VerifyImpl = (url: string, claim: VerifyClaim) => Promise<VerificationResult>;

export interface RunCensusOptions {
  /** Injected gate. Tests pass a fake; main() passes the real verifySource. */
  verifyImpl: VerifyImpl;
  passes: CensusPass[];
  concurrency: number;
  /** Called for every fresh result; the CLI appends it to the JSONL report. */
  onRecord: (record: CensusRecord) => void | Promise<void>;
  /**
   * Records from a resumed report. Their keys are skipped, and their verdicts
   * are replayed into the tallies and findings so a resumed run's summary
   * matches an uninterrupted one.
   */
  priorRecords?: CensusRecord[];
  /**
   * Keys (see `recordKey`) to skip with no known verdict. A skipped check is
   * not evidence either way, so pass B declines to flag a figure whose sources
   * it did not actually see.
   */
  completed?: Set<string>;
  onProgress?: (progress: CensusProgress) => void;
  /** Emit progress every N completed checks. Default 25. */
  progressEvery?: number;
}

// --- constants -------------------------------------------------------------

/**
 * Numeric hints below this are too collision-prone to be evidence: a hint of
 * `2` matches a bare `\b2\b` anywhere on the page — dates, list numbers,
 * paragraph counts (s91 review concern).
 */
export const MIN_NUMERIC_HINT = 10;

/** Consecutive `unavailable` verdicts that mean the checker itself is down. */
export const UNAVAILABLE_ABORT_THRESHOLD = 3;

/**
 * Consecutive failed report writes that mean results are no longer being
 * recorded. Separate from the `unavailable` threshold on purpose: the checks are
 * still working, the disk is not.
 */
export const REPORT_WRITE_ABORT_THRESHOLD = 3;

/**
 * How long to wait for the report stream to flush before giving up on it. An
 * errored stream can leave `end()` never firing its callback, which parks an
 * 8-12 hour run forever with no output and no error.
 */
export const STREAM_END_TIMEOUT_MS = 10_000;

export const DEFAULT_CONCURRENCY = 5;

/** The one directory this tool is allowed to write. */
export const REPORT_DIR = "discovery-logs";

/** Report filenames this tool produces, and the only ones `--resume` will adopt. */
export const REPORT_FILE_PATTERN = /^source-census-.+\.jsonl$/;

// --- helpers ---------------------------------------------------------------

/**
 * ⚠️ Known hazard, deliberately not fixed: the key omits `hintValue`. If a
 * capacityMw figure is edited between runs, `--resume` matches the old key and
 * replays the prior verdict — a pass-B answer about a number the data no longer
 * claims. Harmless for a fresh run (no priors) and for pass A (which has no
 * hint), so it is left alone while pass B is parked. Before resuming a pass-B
 * run over edited data, start a fresh report instead of reusing the old one.
 */
export function recordKey(pass: CensusPass, facilityId: string, url: string, hintLabel: string): string {
  return `${pass}\u0000${facilityId}\u0000${url}\u0000${hintLabel}`;
}

/** Numeric capacityMw entries worth checking, with the sub-10 hints dropped. */
export function numericCapacityEntries(
  capacityMw: CensusFacility["capacityMw"],
): Array<{ label: string; value: number }> {
  if (!capacityMw || typeof capacityMw !== "object") return [];
  const entries: Array<{ label: string; value: number }> = [];
  for (const [label, raw] of Object.entries(capacityMw)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (raw < MIN_NUMERIC_HINT) continue;
    entries.push({ label, value: raw });
  }
  return entries;
}

/** Distinct http(s) source URLs, in citation order. */
export function sourceUrls(facility: CensusFacility): string[] {
  const urls: string[] = [];
  for (const source of facility.sources ?? []) {
    const url = source?.url;
    if (typeof url !== "string" || url.length === 0) continue;
    if (urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * True when a record means "we could not read the page", as opposed to "we read
 * it and it did not check out". A transport failure lands here whatever verdict
 * it carries: the gate maps a failed fetch to `rejected` because it is built to
 * judge model-proposed URLs, but over curated sources a 403 is a bot-wall and a
 * 429 is rate-limiting — neither is evidence about what the page says.
 */
export function isUnreadable(record: CensusRecord): boolean {
  return (
    record.transportFailure !== undefined ||
    record.verdict === "unavailable" ||
    record.verdict === "escalate"
  );
}

/**
 * Whether a prior record represents a COMPLETED check that `--resume` may replay
 * instead of redoing. `verified` and `rejected` are real answers; `escalate` is
 * deterministic (size cap / content type) so replaying it saves time and changes
 * nothing. `unavailable` and transport failures are transient — the outage or
 * bot-wall that produced them is exactly what a resumed run exists to retry.
 */
export function isReplayable(record: CensusRecord): boolean {
  if (record.transportFailure !== undefined) return false;
  return record.verdict !== "unavailable";
}

/**
 * Splits the raw JSON export into records this census can actually check and
 * records it must not. A record with no string `name` would call the gate with
 * `entityName: undefined`; the `rejected` that comes back would be reported as a
 * finding against a facility we never actually named — a fabricated finding,
 * which is the one output this tool must never produce. A record with no `id`
 * cannot be keyed for `--resume` or acted on by a human. Skipped records are
 * returned, not dropped, so the summary can disclose them.
 */
export function selectCheckableFacilities(parsed: unknown[]): {
  facilities: CensusFacility[];
  skipped: string[];
} {
  const facilities: CensusFacility[] = [];
  const skipped: string[] = [];
  parsed.forEach((entry, index) => {
    const record = entry as Partial<CensusFacility> | null;
    const hasId = typeof record?.id === "string" && record.id.length > 0;
    const hasName = typeof record?.name === "string" && record.name.length > 0;
    if (hasId && hasName) {
      facilities.push(record as CensusFacility);
      return;
    }
    const missing = [!hasId && "id", !hasName && "name"].filter(Boolean).join(" and ");
    const label = hasId ? (record as CensusFacility).id : `record #${index}`;
    skipped.push(`${label} — no ${missing}; cannot be checked without naming what to look for`);
  });
  return { facilities, skipped };
}

/** Stable ordering so two censuses of the same data diff cleanly. */
export function compareFindings(a: CensusFinding, b: CensusFinding): number {
  return (
    a.pass.localeCompare(b.pass) ||
    a.facilityId.localeCompare(b.facilityId) ||
    (a.hintLabel ?? "").localeCompare(b.hintLabel ?? "") ||
    a.url.localeCompare(b.url)
  );
}

/**
 * Guards the one path this tool writes. The header promises it only ever writes
 * its own JSONL report; without this, `--out=data/facilities.json` would truncate
 * the live dataset before the first check ran. Returns the cwd-relative path.
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

/**
 * The newest report in a `discovery-logs/` listing, or undefined. Run ids are
 * ISO-8601 timestamps, so lexicographic order is chronological order. Pure —
 * the caller does the readdir — so it is testable without a fixture directory.
 */
export function latestReportName(entries: string[]): string | undefined {
  return entries
    .filter((entry) => REPORT_FILE_PATTERN.test(entry))
    .sort()
    .at(-1);
}

// --- census ----------------------------------------------------------------

interface PassACheck {
  facility: CensusFacility;
  url: string;
}

/** A pass-B unit: one capacity figure, checked against each source in turn. */
interface CapacityUnit {
  facility: CensusFacility;
  hintLabel: string;
  hintValue: number;
  urls: string[];
}

export async function runCensus(
  facilities: CensusFacility[],
  options: RunCensusOptions,
): Promise<CensusSummary> {
  const {
    verifyImpl,
    passes,
    concurrency,
    onRecord,
    priorRecords = [],
    completed = new Set<string>(),
    onProgress,
    progressEvery = 25,
  } = options;

  const tallies: VerdictTallies = { verified: 0, rejected: 0, escalate: 0, unavailable: 0 };
  const findings: CensusFinding[] = [];
  const escalations: CensusFinding[] = [];
  const unchecked: CensusFinding[] = [];
  let checksRun = 0;
  let checksSkipped = 0;
  let consecutiveUnavailable = 0;
  let consecutiveWriteFailures = 0;
  let aborted = false;
  let abortReason: string | undefined;

  const priorByKey = new Map<string, CensusRecord>();
  for (const record of priorRecords) {
    priorByKey.set(recordKey(record.pass, record.facilityId, record.url, record.hintLabel), record);
  }

  // --- work units -----------------------------------------------------------

  const passAChecks: PassACheck[] = [];
  if (passes.includes("a")) {
    for (const facility of facilities) {
      for (const url of sourceUrls(facility)) {
        passAChecks.push({ facility, url });
      }
    }
  }

  const capacityUnits: CapacityUnit[] = [];
  if (passes.includes("b")) {
    for (const facility of facilities) {
      const urls = sourceUrls(facility);
      if (urls.length === 0) continue;
      for (const { label, value } of numericCapacityEntries(facility.capacityMw)) {
        capacityUnits.push({ facility, hintLabel: label, hintValue: value, urls });
      }
    }
  }

  const total =
    passAChecks.length + capacityUnits.reduce((sum, unit) => sum + unit.urls.length, 0);

  // --- one check ------------------------------------------------------------

  /**
   * Runs a single gate call unless the key is already done. Returns `null` when
   * the check was skipped with no known verdict — "we did not look" is not
   * evidence, and callers must not treat it as one.
   */
  async function check(
    pass: CensusPass,
    facility: CensusFacility,
    url: string,
    hint?: { label: string; value: number },
  ): Promise<CensusRecord | null> {
    const hintLabel = hint?.label ?? "";
    const key = recordKey(pass, facility.id, url, hintLabel);

    // Only a COMPLETED prior check is replayed. Re-checking the rest is the
    // whole point of --resume: main() tells the operator to rerun once the
    // model is back, and replaying an `unavailable` would make that a no-op.
    const prior = priorByKey.get(key);
    if (prior && isReplayable(prior)) {
      checksSkipped += 1;
      tallies[prior.verdict] += 1;
      reportProgress();
      return prior;
    }
    if (completed.has(key)) {
      checksSkipped += 1;
      reportProgress();
      return null;
    }

    const claim: VerifyClaim = { entityName: facility.name };
    if (hint) claim.numericHints = [{ label: hint.label, value: hint.value }];

    const result = await verifyImpl(url, claim);
    const record: CensusRecord = {
      pass,
      facilityId: facility.id,
      facilityName: facility.name,
      url,
      hintLabel,
      hintValue: hint?.value,
      verdict: result.verdict,
      reason: result.reason,
      viaWayback: result.viaWayback,
      checkedAt: new Date().toISOString(),
    };
    if (result.transportFailure !== undefined) record.transportFailure = result.transportFailure;

    // Counted and classified BEFORE the report is written. The verdict is a
    // fact the run already owns; letting a failing `onRecord` throw past this
    // point rewrote the check as `unavailable` and turned a genuine `rejected`
    // into a non-finding — a disk-full run would then print "findings: 0" and
    // read exactly like a clean one.
    checksRun += 1;
    tallies[result.verdict] += 1;

    // `unavailable` means "we could not check", never "the source is bad".
    // Three in a row is an outage, not a dataset problem — stop the run.
    if (result.verdict === "unavailable") {
      consecutiveUnavailable += 1;
      if (consecutiveUnavailable >= UNAVAILABLE_ABORT_THRESHOLD && !aborted) {
        aborted = true;
        abortReason =
          `${consecutiveUnavailable} consecutive 'unavailable' verdicts — the verification ` +
          `model could not be reached, so nothing after this point was actually checked.`;
      }
    } else {
      consecutiveUnavailable = 0;
    }

    // A failed report write is its own failure class: the check happened and
    // stands, but the run can no longer produce a resumable record of it.
    // Counted and abortable, never laundered into "we could not check".
    try {
      await onRecord(record);
      consecutiveWriteFailures = 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consecutiveWriteFailures += 1;
      console.error(`[census] could not write the report line for ${url}: ${message}`);
      if (consecutiveWriteFailures >= REPORT_WRITE_ABORT_THRESHOLD && !aborted) {
        aborted = true;
        abortReason =
          `${consecutiveWriteFailures} consecutive report-write failures (${message}) — the ` +
          `checks still ran, but results are no longer reaching the report, so this run cannot ` +
          `be resumed from what is on disk.`;
      }
    }

    reportProgress();
    return record;
  }

  function reportProgress(): void {
    const done = checksRun + checksSkipped;
    if (onProgress && done % progressEvery === 0) {
      onProgress({ completed: done, total, tallies: { ...tallies } });
    }
  }

  /**
   * A thrown work unit is recorded as `unavailable` — we could not check — and
   * NEVER as evidence against the source. It deliberately does not touch the
   * consecutive-unavailable counter: that abort exists to detect the
   * verification model being down, which `check()` already signals with a real
   * `unavailable` verdict. A bug here, a stream error or an OOM is a different
   * failure class, and three unrelated throws must not be laundered into "the
   * model is down" and kill a 55-minute run.
   */
  async function recordThrow(
    pass: CensusPass,
    facility: CensusFacility,
    url: string,
    hint: { label: string; value: number } | undefined,
    error: unknown,
  ): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    const reason = `census error while checking ${url}: ${message}`;
    const record: CensusRecord = {
      pass,
      facilityId: facility.id,
      facilityName: facility.name,
      url,
      hintLabel: hint?.label ?? "",
      hintValue: hint?.value,
      verdict: "unavailable",
      reason,
      checkedAt: new Date().toISOString(),
    };
    try {
      await onRecord(record);
    } catch {
      // The report stream itself is failing; losing one line beats losing the run.
    }
    checksRun += 1;
    tallies.unavailable += 1;
    return reason;
  }

  // --- run ------------------------------------------------------------------

  // Aborting is a flag rather than a throw so the shared runWithConcurrency
  // helper still settles cleanly: in-flight workers finish, queued ones no-op.
  await runWithConcurrency(passAChecks, concurrency, async ({ facility, url }) => {
    if (aborted) return;
    let record: CensusRecord | null;
    try {
      record = await check("a", facility, url);
    } catch (error) {
      escalations.push({
        pass: "a",
        facilityId: facility.id,
        facilityName: facility.name,
        url,
        reason: await recordThrow("a", facility, url, undefined, error),
      });
      return;
    }
    if (!record) return;
    // Checked BEFORE the verdict, because the verdict on a transport failure
    // really is `rejected` — and reporting a bot-walled page as a misbinding
    // sends a maintainer to "correct" data that was right all along.
    if (isUnreadable(record)) {
      // Not a finding — these exist precisely to route a source we could not
      // read to a human instead of dropping it silently or blaming it.
      escalations.push({
        pass: "a",
        facilityId: facility.id,
        facilityName: facility.name,
        url,
        reason: record.reason,
      });
    } else if (record.verdict === "rejected") {
      findings.push({
        pass: "a",
        facilityId: facility.id,
        facilityName: facility.name,
        url,
        reason: record.reason,
      });
    }
  });

  await runWithConcurrency(capacityUnits, concurrency, async (unit) => {
    if (aborted) return;
    const reasons: string[] = [];
    const unreadableNotes: string[] = [];

    for (const url of unit.urls) {
      if (aborted) return;
      let record: CensusRecord | null;
      try {
        record = await check("b", unit.facility, url, {
          label: unit.hintLabel,
          value: unit.hintValue,
        });
      } catch (error) {
        // The unit is now incomplete: a later source might have backed the
        // figure. Abandon it rather than claim "no source supports this".
        const reason = await recordThrow(
          "b",
          unit.facility,
          url,
          { label: unit.hintLabel, value: unit.hintValue },
          error,
        );
        pushUnchecked(unit, [...unreadableNotes, reason], unit.urls.length);
        return;
      }
      // "We could not read it" is not evidence against the figure. That covers
      // a resume-skipped check, an `unavailable` (model down), an `escalate` —
      // "the source may be genuine but the fetcher could not structurally
      // ingest it (size cap / content type)" — and a transport failure, where
      // the page was never fetched at all. A capacity figure stated in an
      // oversized SEC filing, a PDF, or behind a bot-wall must not be reported
      // as unsupported. Checked before the `verified` short-circuit so an
      // unreadable page can never settle the unit either way.
      if (record === null) {
        unreadableNotes.push(`${url}: skipped (already recorded)`);
        continue;
      }
      if (isUnreadable(record)) {
        unreadableNotes.push(`${url}: ${record.reason}`);
        continue;
      }
      // Short-circuit: one supporting source is enough to back the figure.
      if (record.verdict === "verified") return;
      reasons.push(`${url}: ${record.reason}`);
    }

    // Report only when at least one source was actually read and did not
    // support the figure. A unit whose every source was unreadable makes no
    // claim at all — a fabricated finding is indistinguishable from a real one —
    // so it goes to `unchecked`, where a human can see it was never checked.
    if (reasons.length === 0) {
      if (unreadableNotes.length > 0) pushUnchecked(unit, unreadableNotes, unit.urls.length);
      return;
    }

    const unreadableNote =
      unreadableNotes.length > 0
        ? ` ;; ${unreadableNotes.length} of ${unit.urls.length} source(s) could not be read (unavailable/escalate/fetch failure) — not evidence either way`
        : "";

    findings.push({
      pass: "b",
      facilityId: unit.facility.id,
      facilityName: unit.facility.name,
      url: unit.urls.join(" | "),
      hintLabel: unit.hintLabel,
      hintValue: unit.hintValue,
      reason: `${reasons.join(" ;; ")}${unreadableNote}`,
      unreadableSources: unreadableNotes.length,
    });
  });

  function pushUnchecked(unit: CapacityUnit, notes: string[], total: number): void {
    unchecked.push({
      pass: "b",
      facilityId: unit.facility.id,
      facilityName: unit.facility.name,
      url: unit.urls.join(" | "),
      hintLabel: unit.hintLabel,
      hintValue: unit.hintValue,
      reason: `no cited source could be read (${notes.length} of ${total}) — ${notes.join(" ;; ")}`,
      unreadableSources: notes.length,
    });
  }

  // Workers finish in nondeterministic order; sort so two runs diff cleanly.
  findings.sort(compareFindings);
  escalations.sort(compareFindings);
  unchecked.sort(compareFindings);

  return { tallies, checksRun, checksSkipped, findings, escalations, unchecked, aborted, abortReason };
}

// --- CLI -------------------------------------------------------------------

export interface CliOptions {
  limit?: number;
  out: string;
  /**
   * Whether `--out` was given. A resumed run without it must adopt the newest
   * existing report — the run-id default names a file that cannot exist yet, so
   * resuming into it silently discarded ~55 minutes of completed checks.
   */
  outExplicit: boolean;
  concurrency: number;
  resume: boolean;
  passes: CensusPass[];
}

/** Timestamped run id — deterministic from the clock, never `Math.random`. */
export function makeRunId(now = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, "").replace(/[:]/g, "-");
}

export function parseArgs(argv: string[], runId: string): CliOptions {
  let limit: number | undefined;
  let out: string | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  let resume = false;
  let passes: CensusPass[] = ["a", "b"];

  for (const arg of argv) {
    if (arg === "--resume") {
      resume = true;
    } else if (arg.startsWith("--limit=")) {
      limit = parsePositiveInt(arg, "--limit");
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parsePositiveInt(arg, "--concurrency");
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      if (out.length === 0) throw new Error("--out requires a path");
      // Fail here, before a single check runs — `--out=data/facilities.json`
      // would otherwise truncate the live dataset on the first open().
      assertSafeReportPath(out);
    } else if (arg.startsWith("--pass=")) {
      const value = arg.slice("--pass=".length);
      if (value === "a") passes = ["a"];
      else if (value === "b") passes = ["b"];
      else if (value === "both") passes = ["a", "b"];
      else throw new Error(`--pass must be a, b, or both (got "${value}")`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    limit,
    out: out ?? `${REPORT_DIR}/source-census-${runId}.jsonl`,
    outExplicit: out !== undefined,
    concurrency,
    resume,
    passes,
  };
}

/**
 * The report a resumed run should read and append to: `--out` when given, else
 * the newest existing report. Throws when `--resume` has nothing to resume —
 * silently starting a full 55-minute re-run is the failure this prevents.
 */
export function resolveResumePath(
  options: CliOptions,
  listDir: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
): string {
  if (options.outExplicit) return options.out;
  const newest = latestReportName(listDir(REPORT_DIR));
  if (newest === undefined) {
    throw new Error(
      `--resume: no existing ${REPORT_DIR}/source-census-*.jsonl to resume from. ` +
        `Pass --out=<path> to name one, or drop --resume to start a fresh run.`,
    );
  }
  return path.join(REPORT_DIR, newest);
}

function parsePositiveInt(arg: string, flag: string): number {
  const value = Number(arg.slice(flag.length + 1));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${arg}")`);
  }
  return value;
}

const VERDICTS: ReadonlySet<string> = new Set(["verified", "rejected", "escalate", "unavailable"]);

/**
 * Shape-checks a parsed report line. Without this an out-of-enum verdict makes
 * `tallies[verdict]` NaN with no error at all, and a bare `null` line crashes
 * the run on property access.
 */
function isCensusRecord(value: unknown): value is CensusRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.pass === "a" || record.pass === "b") &&
    typeof record.facilityId === "string" &&
    typeof record.facilityName === "string" &&
    typeof record.url === "string" &&
    typeof record.hintLabel === "string" &&
    typeof record.verdict === "string" &&
    VERDICTS.has(record.verdict) &&
    typeof record.reason === "string"
  );
}

/**
 * Re-reads a JSONL report; a truncated trailing line from a killed run is
 * dropped, and so is any line that does not parse into a real record — a
 * malformed line must cost us one re-check, never a NaN tally or a crash.
 */
export function readReport(reportPath: string): CensusRecord[] {
  if (!existsSync(reportPath)) return [];
  const records: CensusRecord[] = [];
  let malformed = 0;
  for (const line of readFileSync(reportPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Partially-written last line — ignore it and re-check that key.
      malformed += 1;
      continue;
    }
    if (!isCensusRecord(parsed)) {
      malformed += 1;
      continue;
    }
    records.push(parsed);
  }
  if (malformed > 0) {
    console.warn(`[census] ${reportPath}: skipped ${malformed} unreadable line(s); those keys will be re-checked`);
  }
  return records;
}

/**
 * `skippedRecords` describes input this census refused to check (see
 * `selectCheckableFacilities`). It is a separate argument rather than a new
 * `CensusSummary` field because it is a fact about the input, not a result.
 */
export function formatSummary(
  summary: CensusSummary,
  elapsedMs: number,
  skippedRecords: string[] = [],
): string {
  const { tallies } = summary;
  const lines: string[] = [
    "",
    "Source-verification census",
    "==========================",
    `checks run ${summary.checksRun} (skipped via resume ${summary.checksSkipped}) in ${(elapsedMs / 1000).toFixed(0)}s`,
    `verified ${tallies.verified}  rejected ${tallies.rejected}  escalate ${tallies.escalate}  unavailable ${tallies.unavailable}`,
    "  unavailable = could not check (never a finding, never merged into rejected)",
    `records skipped as uncheckable (missing id or name): ${skippedRecords.length}`,
  ];
  for (const skipped of skippedRecords) {
    lines.push(`  ${skipped}`);
  }

  const passA = summary.findings.filter((finding) => finding.pass === "a");
  const passB = summary.findings.filter((finding) => finding.pass === "b");

  lines.push(
    "",
    `Pass A — review candidates: the model did not recognise this facility's name on the page: ${passA.length}`,
    "  (NOT confirmed defects. The check is near-literal name matching, not entity",
    "   resolution, so a genuine source that calls the site something else — subsidiary,",
    "   tenant, project codename, operator name vs site name — is rejected too. Measured:",
    "   springfieldohio.gov's \"5C Data Center FAQs\" page rejects our name",
    "   \"5C Group / Vultr Data Center (Prime Ohio)\" and verifies \"5C Data Center\".",
    "   Expect a substantial false-positive rate — read the page before changing any data)",
  );
  for (const finding of passA) {
    lines.push(`  ${finding.facilityId} — ${finding.facilityName}`);
    lines.push(`    ${finding.url}`);
    lines.push(`    ${finding.reason}`);
  }

  lines.push("", `Pass B — capacity figures no cited source supports: ${passB.length}`);
  for (const finding of passB) {
    lines.push(
      `  ${finding.facilityId} — ${finding.facilityName} (capacityMw.${finding.hintLabel} = ${finding.hintValue})`,
    );
    lines.push(`    sources checked: ${finding.url}`);
    lines.push(`    ${finding.reason}`);
  }

  lines.push(
    "",
    `Pass A — could not check, needs a human look: ${summary.escalations.length}`,
    "  (not findings — the source may well be genuine; the fetcher could not ingest it,",
    "   or could not reach it at all: a 403 bot-wall, a 429, a timeout)",
  );
  for (const escalation of summary.escalations) {
    lines.push(`  ${escalation.facilityId} — ${escalation.facilityName}`);
    lines.push(`    ${escalation.url}`);
    lines.push(`    ${escalation.reason}`);
  }

  lines.push(
    "",
    `Pass B — could not check, needs a human look: ${summary.unchecked.length}`,
    "  (not findings, and not counted as clean either — NOT ONE cited source could be",
    "   read, so these figures were never actually checked against anything)",
  );
  for (const unit of summary.unchecked) {
    lines.push(
      `  ${unit.facilityId} — ${unit.facilityName} (capacityMw.${unit.hintLabel} = ${unit.hintValue})`,
    );
    lines.push(`    sources: ${unit.url}`);
    lines.push(`    ${unit.reason}`);
  }

  if (summary.aborted) lines.push("", `ABORTED: ${summary.abortReason}`);
  lines.push("");
  return lines.join("\n");
}

/** The writable surface this tool needs — narrow so tests can pass a plain stream. */
export interface ReportStream {
  write(chunk: string): unknown;
  end(callback: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Wraps the report stream so a write failure becomes a thrown error at the call
 * site instead of an uncaught async exception. A `WriteStream` with no `'error'`
 * listener throws asynchronously on ENOSPC/EACCES, which `main().catch()` cannot
 * catch — the process dies mid-run, and an already-errored stream may never fire
 * `end()`'s callback, parking the run instead of ending it. Once the stream has
 * errored every subsequent write throws, which `runCensus` counts and aborts on.
 */
export function createReportWriter(
  stream: ReportStream,
  log: (message: string) => void = console.error,
): (record: CensusRecord) => void {
  let failure: Error | undefined;
  stream.on("error", (error: Error) => {
    if (failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    log(`[census] report stream failed: ${failure.message} — results can no longer be recorded`);
  });
  return (record: CensusRecord) => {
    if (failure) throw new Error(`report stream is unusable: ${failure.message}`);
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

/**
 * Ends the stream, but never waits forever: an errored stream can leave the
 * `end()` callback unfired, and this sits in a `finally`, so a hang here parks
 * the whole run with no output and no error. Resolving on timeout loses at worst
 * the last buffered lines; hanging loses the entire run.
 */
export function endReportStream(
  stream: Pick<ReportStream, "end">,
  timeoutMs: number = STREAM_END_TIMEOUT_MS,
  log: (message: string) => void = console.error,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log(`[census] report stream did not flush within ${timeoutMs}ms — continuing without it`);
      resolve();
    }, timeoutMs);
    timer.unref?.();
    stream.end(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function loadFacilities(limit?: number): { facilities: CensusFacility[]; skipped: string[] } {
  const facilitiesPath = path.join(process.cwd(), "data", "facilities.json");
  const parsed: unknown = JSON.parse(readFileSync(facilitiesPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${facilitiesPath} is not a JSON array`);
  }
  const { facilities, skipped } = selectCheckableFacilities(parsed);
  return {
    facilities: limit === undefined ? facilities : facilities.slice(0, limit),
    skipped,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2), makeRunId());
  const { facilities, skipped } = loadFacilities(options.limit);

  const reportPath = options.resume ? resolveResumePath(options) : options.out;
  const outPath = path.resolve(process.cwd(), assertSafeReportPath(reportPath));
  mkdirSync(path.dirname(outPath), { recursive: true });

  const priorRecords = options.resume ? readReport(outPath) : [];
  const stream = createWriteStream(outPath, { flags: options.resume ? "a" : "w" });
  const writeRecord = createReportWriter(stream);

  // Real deps are constructed only here, inside main() — module scope must stay
  // import-safe (no network, no Ollama) the way submit-candidates.ts keeps it.
  const [{ verifySource }, { fetchPageText }, { callOllama }] = await Promise.all([
    import("./verify-source"),
    import("./fetch-page-text"),
    import("./ollama-client"),
  ]);
  const verifyImpl: VerifyImpl = (url, claim) =>
    verifySource(url, claim, {
      fetchPageTextImpl: (pageUrl) => fetchPageText(pageUrl, { fetchImpl: fetch }),
      callOllamaImpl: (opts) => callOllama({ ...opts, fetchImpl: fetch }),
    });

  console.error(
    `[census] ${facilities.length} facilities · pass ${options.passes.join("+")} · concurrency ${options.concurrency}`,
  );
  console.error(`[census] report -> ${reportPath}`);
  if (skipped.length > 0) {
    // Said up front, not just in the summary 8-12 hours later.
    console.error(`[census] skipping ${skipped.length} record(s) with no usable id/name:`);
    for (const entry of skipped) console.error(`[census]   ${entry}`);
  }
  if (options.resume) {
    // Logged unconditionally, zero included: a resume that quietly found nothing
    // and restarted from scratch is indistinguishable from a real one.
    const replayable = priorRecords.filter(isReplayable).length;
    console.error(
      `[census] resuming from ${reportPath} — ${priorRecords.length} prior record(s), ` +
        `${replayable} replayable; the rest (unavailable / fetch failures) will be re-checked`,
    );
  }

  let summary: CensusSummary;
  try {
    summary = await runCensus(facilities, {
      verifyImpl,
      passes: options.passes,
      concurrency: options.concurrency,
      priorRecords,
      onRecord: writeRecord,
      onProgress: ({ completed, total, tallies }) => {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        console.error(
          `[census] ${completed}/${total} · ${elapsed}s · verified ${tallies.verified} · rejected ${tallies.rejected} · escalate ${tallies.escalate} · unavailable ${tallies.unavailable}`,
        );
      },
    });
  } finally {
    await endReportStream(stream);
  }

  console.log(formatSummary(summary, Date.now() - startedAt, skipped));

  if (summary.aborted) {
    console.error(
      `[census] ABORTED: ${summary.abortReason}\n` +
        `[census] Check that the verification model is reachable:\n` +
        `[census]   OLLAMA_BASE_URL (default http://127.0.0.1:11434)\n` +
        `[census]   OLLAMA_VERIFY_MODEL (must be pulled)\n` +
        `[census] Partial results are in ${reportPath} — rerun with --resume once it is back.`,
    );
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

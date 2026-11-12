/**
 * Deterministic core of the discovery pipeline: takes a JSON array of
 * candidate facility docs (or `{ facility, provenance }` wrappers), compact
 * `{ statusUpdate, provenance }` status-transition intents, or compact
 * `{ enrichmentUpdate, provenance }` fill-missing intents, validates and
 * dedupes them against the live facility set, and stages the survivors
 * as `pending` submissions via POST /api/submissions. Never writes live
 * facilities directly — that stays a human decision via the CLI
 * (`scripts/submissions.ts`).
 *
 * `statusUpdate` and `enrichmentUpdate` intents exist to avoid reconstructing
 * a full facility doc from a compact projection (see lib/status-update.ts and
 * lib/enrichment-update.ts) — the server applies them append-only, appending
 * new sources rather than rebuilding the array. Discovery (net-new facilities
 * + status refreshes) is processed ahead of enrichment against the shared
 * `--max` cap — see the `ordered` partition in `runSubmit`.
 *
 * Before dedupe/cap, every candidate's cited sources also pass through an
 * optional mechanical verification gate (`verifyCandidateSources`, composing
 * verify-source.ts/fetch-page-text.ts/ollama-client.ts) that fetches and
 * content-checks each URL against a local model — closing the project's
 * documented fabricated-source-URL defect class. The gate can only ever
 * REDUCE what reaches `pending`; see `RunSubmitDeps.verifyImpl`'s doc-comment
 * for exactly when it runs and when it is skipped.
 *
 * Run via: tsx scripts/discovery/submit-candidates.ts <candidates.json> [flags]
 * Requires API_INTAKE_TOKEN — or, as a fallback, API_ADMIN_TOKEN unless
 * DISCOVERY_REQUIRE_INTAKE_TOKEN=1 — in the environment (e.g. via
 * --env-file=.env.local). See `submissionToken`: staging is the only
 * capability this lane needs, so prefer the intake token.
 *
 * Uses relative imports throughout, matching scripts/seed.ts and scripts/submissions.ts.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { formatErrorSummary, formatFatalError, redactedErrorCode, scrubUriCredentials } from "../../lib/db-error";
import { facilitySchema, type Facility, type Source } from "../../lib/schema";
import { statusUpdateIntentSchema, type StatusUpdateIntent } from "../../lib/status-update";
import { enrichmentUpdateIntentSchema, type EnrichmentUpdateIntent } from "../../lib/enrichment-update";
import { isRestrictedSourceUrl } from "../../lib/restricted-sources";
import { normalizeSourceUrl } from "./source-url";
import { verifySource, type VerifyClaim, type VerificationResult } from "./verify-source";
import { fetchPageText, type FetchPageTextResult } from "./fetch-page-text";
import { fetchPdfText, type FetchPdfTextResult } from "./fetch-pdf-text";
import { callOllama, probeOllama, type ProbeOllamaResult } from "./ollama-client";
import { loadFacilities } from "./load-facilities";
import { isEntrypoint } from "../is-entrypoint";

// --- environment -------------------------------------------------------------

/**
 * The slice of the environment the helpers below read. Deliberately NOT
 * `NodeJS.ProcessEnv`: Next's type augmentation makes `NODE_ENV` required, so
 * that type cannot be satisfied by a test-supplied literal — which would put
 * these two parse rules back out of reach of a unit test, the exact problem
 * `verificationEnabled` exists to fix. `process.env` satisfies this.
 */
type EnvLike = Record<string, string | undefined>;

/**
 * The bearer token this lane presents to `POST /api/submissions`.
 *
 * Prefers `API_INTAKE_TOKEN` — the least-privilege, staging-only credential
 * accepted by that one route (see `requireIntake` in lib/api-auth.ts) — and by
 * default falls back to `API_ADMIN_TOKEN`, which the route still accepts, so
 * manual runs keep working where the intake token is not configured.
 *
 * `DISCOVERY_REQUIRE_INTAKE_TOKEN=1` (set by the scheduled run) is strict mode:
 * `API_INTAKE_TOKEN` only, never the admin token, so the scheduled run opts out
 * of the fallback. Note this limits the token, not the pipeline: its
 * `.env.local` still holds the owner `DATABASE_URL`, which the leads lane
 * (createSubmission, updateLeadStatus, promoteLead via lib/db/client), retention
 * prune and publish-heartbeat use for writes (see docs/maintainers.md). The CI
 * watchdog checks run on the `ci_monitor` Actions secret instead.
 *
 * Returns `undefined` (never the string "undefined") when neither is set, so
 * `main()`'s preflight can refuse to run rather than sending
 * `Authorization: Bearer undefined` and reading the 401s as submit errors.
 */
export function submissionToken(env: EnvLike = process.env): string | undefined {
  if (env.DISCOVERY_REQUIRE_INTAKE_TOKEN === "1") return env.API_INTAKE_TOKEN || undefined;
  return env.API_INTAKE_TOKEN || env.API_ADMIN_TOKEN || undefined;
}

/**
 * Whether the mechanical source-verification gate runs. Default-ON: ONLY the
 * exact string "false" disables it; every other value — including `"FALSE"`,
 * a `"flase"` typo, `"0"`, `"no"`, `""`, and unset — leaves it ENABLED.
 *
 * ⚠️ The polarity is the safety property, and it is asymmetric: a
 * false-negative here costs one aborted run, while a false-positive stages
 * unverified candidates on EVERY run with the whole suite still green (the
 * gate's absence produces no error, just weaker data — see
 * `RunSubmitDeps.verifyImpl`). Extracted from `main()` for exactly that
 * reason: inside `main()` no unit test could pin it, so `!== "true"` or a
 * truthiness check would have been a silent, reviewable-looking refactor. Do
 * not "simplify" this to a truthy/falsy test — see the typo cases in
 * submit-candidates.test.ts.
 */
export function verificationEnabled(env: EnvLike = process.env): boolean {
  return env.VERIFY_SOURCES_ENABLED !== "false";
}

// --- types -----------------------------------------------------------------

export interface CandidateProvenance {
  sources?: string[];
  confidence?: string;
  discoveredBy?: string;
  runId?: string;
  discoveredAt?: string;
  note?: string;
}

/**
 * Normalized candidate shape. `facility` covers both the historical bare-doc
 * and `{ facility, provenance }` wrapper forms (unchanged reconstruct-and-
 * validate path). `status_update` covers the compact-intent form emitted for
 * Responsibility 2 (status-refresh) — see lib/status-update.ts for why this
 * is append-only rather than a rebuilt full doc. `enrichment_update` covers
 * the fill-missing compact-intent form emitted for Responsibility 3
 * (enrichment) — see lib/enrichment-update.ts.
 */
export type NormalizedCandidate =
  | { type: "facility"; doc: unknown; provenance: CandidateProvenance }
  | {
      type: "status_update";
      targetFacilityId: unknown;
      intent: unknown;
      provenance: CandidateProvenance;
    }
  | {
      type: "enrichment_update";
      targetFacilityId: unknown;
      intent: unknown;
      provenance: CandidateProvenance;
    };

export interface RunSubmitOptions {
  runId: string;
  max: number;
  dryRun: boolean;
  baseUrl: string;
  state?: string;
  discoveredAt: string;
}

export interface RunSubmitDeps {
  /** Test seam for the POST retry backoff; defaults to setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
  fetchImpl: typeof fetch;
  existingFacilities: Facility[];
  /**
   * Optional source-verification gate: checks whether a candidate source URL
   * genuinely supports a claim about `entityName` before the candidate that
   * cites it is allowed to reach dedupe/submission (see `verifyCandidateSources`
   * below). Deliberately never a module-level self-initializing import —
   * `main()` builds the real implementation (composing verify-source.ts +
   * fetch-page-text.ts + ollama-client.ts) lazily inside itself via
   * `buildRealVerifyImpl()`, so importing this module for tests never opens a
   * socket (tests/discovery/run.bats's retry-gate check really does execute
   * this module's top-level scope for real, with no Ollama available in CI).
   *
   * When absent (test callers, or `VERIFY_SOURCES_ENABLED=false`), the gate is
   * skipped entirely and candidates proceed unchanged — the gate can only
   * ever REDUCE what reaches pending, so its absence is a strictly weaker
   * state, never a silent promote path.
   */
  verifyImpl?: (url: string, claim: VerifyClaim) => Promise<VerificationResult>;
  /**
   * Called ONCE with the still-empty summary, before any candidate is
   * processed. The object handed over is the LIVE one `runSubmit` mutates in
   * place, so a caller that keeps the reference can read a PARTIAL summary
   * even when the run never returns — the only way to see how far a run got
   * when `verifyCandidateSources` throws `VerificationGateUnavailableError`
   * mid-way (see `runSubmitAndLog`, which uses this to write
   * `run-<runId>.json` on an abort; an absent log is indistinguishable from a
   * state that never ran at all).
   *
   * Observability only: nothing in `runSubmit` reads it back, and it must not
   * mutate what it is given.
   */
  onSummaryInit?: (summary: RunSubmitSummary) => void;
  /**
   * Ollama health probe, consulted ONLY after a source's verification call hit
   * its per-call timeout (`VerificationResult.modelTimedOut`). Healthy (answers
   * quickly, verify model present) means one slow page: that candidate is held
   * for manual review and the run continues. Unhealthy aborts as before. When
   * absent, a timeout aborts exactly like any other "unavailable". Like
   * `verifyImpl`, `main()` builds the real one lazily (`buildRealProbe()`).
   */
  probeOllama?: () => Promise<ProbeOllamaResult>;
  /** Max healthy-probe timeouts tolerated per `runSubmit` call; the next one
   * aborts. Default `DEFAULT_TIMEOUT_BUDGET` (3). */
  timeoutBudget?: number;
}

export interface RunSubmitSummary {
  runId: string;
  state: string | null;
  discovered: number;
  submitted: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  skippedOverCap: number;
  /** Zero of the candidate's cited sources reached "verified" (and none
   * reached "escalate" either) — kept distinct from `skippedInvalid` because
   * this is a verification-gate failure, not a schema failure, and the two
   * must not be blurred together in `run-<runId>.json`. */
  skippedUnverified: number;
  /** A candidate's cited source(s) included a licence-restricted domain (see
   * lib/restricted-sources.ts) that could not be safely stripped before
   * staging — either every source the candidate carried was restricted, or
   * a sourceIndex/sourceRel reference pointed at the one that was removed
   * and could not be remapped by URL identity (see
   * `stripRestrictedFromSources`'s doc comment). Kept distinct from
   * `skippedInvalid` and `skippedUnverified`: this is neither a schema
   * failure nor "nothing verified" — the candidate may otherwise be
   * perfectly good, it is unstageable ONLY because of the licence
   * restriction. A restricted source that WAS safely stripped is NOT
   * counted here — the candidate still stages, minus that one citation
   * (see the "stripped restricted source(s)" log line). */
  skippedRestrictedSource: number;
  errors: number;
  submittedIds: string[];
}

// --- normalization -----------------------------------------------------------

/**
 * Accepts a bare Facility doc, a `{ facility, provenance }` wrapper (both
 * classified as `type: "facility"`), a `{ statusUpdate, provenance }`
 * compact intent (classified as `type: "status_update"`), or an
 * `{ enrichmentUpdate, provenance }` compact intent (classified as
 * `type: "enrichment_update"`).
 */
/**
 * Removes `stakeholders` from a raw candidate doc before it is validated.
 *
 * `stakeholders` names real private individuals, so it is maintainer-curated
 * and site-level ONLY (lib/schema.ts's `stakeholderSchema`): every entry needs
 * a source tying that person to this specific site, and — per the curation
 * rule at `stakeholderRoleEnum` — a public capacity. CLAUDE.md states the
 * field is "excluded from public intake and discovery enrichment"; this makes
 * the submission lane agree. No discovery prompt asks for the field, so today
 * this strips something nothing produces — deliberately: it closes a generic
 * pass-through so a future prompt change cannot quietly open the path, and the
 * cost of being wrong here is one omitted curated field, versus staging a
 * model-invented name attached to a parcel.
 *
 * `notRecorded` is stripped for the same reason: it is a maintainer judgement
 * that a value was deliberately left out, and a model must not be able to
 * suppress a field on its own say-so.
 *
 * Applied to the RAW doc (before `facilitySchema.safeParse`) rather than the
 * validated `Facility`, because `Facility` is a discriminated union on
 * `facilityType` and rebuilding one field-wise needs the per-branch dance in
 * `applyDocSourceStrip`. Returns the input unchanged when there is nothing to
 * strip, so the overwhelmingly common case allocates nothing.
 */
export function stripCuratedFields(doc: unknown): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return doc;
  }
  if (!("stakeholders" in doc) && !("notRecorded" in doc)) {
    return doc;
  }
  const rest = { ...(doc as Record<string, unknown>) };
  delete rest.stakeholders;
  delete rest.notRecorded;
  return rest;
}

export function normalizeCandidates(raw: unknown[]): NormalizedCandidate[] {
  return raw.map((entry) => {
    if (entry && typeof entry === "object" && "statusUpdate" in (entry as Record<string, unknown>)) {
      const wrapped = entry as { statusUpdate: unknown; provenance?: CandidateProvenance };
      const intent = wrapped.statusUpdate as Record<string, unknown> | null | undefined;
      const targetFacilityId =
        intent && typeof intent === "object" ? intent.targetFacilityId : undefined;
      return {
        type: "status_update",
        targetFacilityId,
        intent: wrapped.statusUpdate,
        provenance: wrapped.provenance ?? {},
      };
    }
    if (entry && typeof entry === "object" && "enrichmentUpdate" in (entry as Record<string, unknown>)) {
      const wrapped = entry as { enrichmentUpdate: unknown; provenance?: CandidateProvenance };
      const intent = wrapped.enrichmentUpdate as Record<string, unknown> | null | undefined;
      const targetFacilityId =
        intent && typeof intent === "object" ? intent.targetFacilityId : undefined;
      return {
        type: "enrichment_update",
        targetFacilityId,
        intent: wrapped.enrichmentUpdate,
        provenance: wrapped.provenance ?? {},
      };
    }
    if (entry && typeof entry === "object" && "facility" in (entry as Record<string, unknown>)) {
      const wrapped = entry as { facility: unknown; provenance?: CandidateProvenance };
      return {
        type: "facility",
        doc: stripCuratedFields(wrapped.facility),
        provenance: wrapped.provenance ?? {},
      };
    }
    return { type: "facility", doc: stripCuratedFields(entry), provenance: {} };
  });
}

// --- dedup helpers -----------------------------------------------------------

function normKey(name: string, state: string, city: string): string {
  return `${name.trim().toLowerCase()}|${state.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

function buildExistingIndex(existing: Facility[]): {
  ids: Set<string>;
  nameStateCity: Set<string>;
  byId: Map<string, Facility>;
} {
  const ids = new Set<string>();
  const nameStateCity = new Set<string>();
  const byId = new Map<string, Facility>();
  for (const f of existing) {
    ids.add(f.id);
    nameStateCity.add(normKey(f.name, f.location.state, f.location.city ?? ""));
    byId.set(f.id, f);
  }
  return { ids, nameStateCity, byId };
}

/**
 * Shared provenance assembly for the facility, status_update, and
 * enrichment_update POST paths. `verdictNote` (the per-URL verdict list
 * from the verification gate — see `verifyCandidateSources`) is appended to any
 * existing `provenance.note` rather than replacing it, so a note the
 * discovery pipeline already wrote is never silently dropped.
 */
function buildProvenance(
  provenance: CandidateProvenance,
  runId: string,
  discoveredAt: string,
  verdictNote?: string
) {
  const noteParts = [provenance.note, verdictNote].filter(
    (part): part is string => typeof part === "string" && part.length > 0
  );
  return {
    sources: provenance.sources ?? [],
    confidence: provenance.confidence,
    discoveredBy: provenance.discoveredBy ?? "discovery-pipeline",
    runId: provenance.runId ?? runId,
    discoveredAt: provenance.discoveredAt ?? discoveredAt,
    note: noteParts.length > 0 ? noteParts.join(" | ") : undefined,
  };
}

// --- verification gate --------------------------------------------------

/**
 * Thrown when a source's verdict is `"unavailable"` — the verification model
 * itself could not be reached (Ollama down, model not pulled, network
 * error), never a judgment that the source is bad (see verify-source.ts's
 * `VerificationResult` doc-comment on why the two must never be conflated).
 * Must propagate all the way out of `runSubmit` uncaught: catching it and
 * continuing would risk a whole batch reading as "unverified", indistinguishable
 * from a batch that was genuinely full of fabricated URLs — the same
 * fail-open trap this project already got burned by once
 * (`vercel-ignore-build.sh` #141, a broken gate that looks like a working
 * one). The message is written to be diagnosable without reading code:
 * `http_error_404` is the likeliest real-world trigger (OLLAMA_VERIFY_MODEL
 * not pulled on a fresh machine).
 */
export class VerificationGateUnavailableError extends Error {
  constructor(url: string, reason: string) {
    super(
      `source verification is UNAVAILABLE (could not check — this is not the same as "rejected") ` +
        `for ${url}: ${reason}. This almost always means Ollama itself is unreachable or ` +
        `OLLAMA_VERIFY_MODEL is not pulled locally (a "http_error_404" reason usually means the ` +
        `model is not pulled) — check OLLAMA_BASE_URL/OLLAMA_VERIFY_MODEL. Aborting the entire run ` +
        `rather than silently submitting candidates as unverified. Set VERIFY_SOURCES_ENABLED=false ` +
        `to explicitly bypass the gate if that is intentional.`
    );
    this.name = "VerificationGateUnavailableError";
  }
}

/** Healthy-probe timeouts tolerated per `runSubmit` call (see `verifyCandidateSources`). */
const DEFAULT_TIMEOUT_BUDGET = 3;

/** Probe timeout, ms: a healthy Ollama answers `/api/tags` in milliseconds. */
const PROBE_TIMEOUT_MS = 5_000;

/** Per-`runSubmit` state for the timeout rule, shared across all candidates. */
interface TimeoutGuard {
  probe?: () => Promise<ProbeOllamaResult>;
  remaining: number;
}

/**
 * One-line summary of why a single source's verification was not "verified",
 * for the "skip unverified" log line and `rejectionDetail`. Distinguishes a
 * source that could never be READ at all (`transportFailure` set — the URL
 * was dead, blocked, or the fetcher/Wayback fallback could not structurally
 * ingest or rescue it) from one that WAS actually read and mechanically
 * checked against the claim and did not hold up (`result.reason` alone,
 * sourced from the model's own reasonDetail) — the exact distinction the
 * flat "no cited source could be mechanically verified" wording this
 * replaces used to erase. See verify-source.ts's `VerificationResult`
 * doc-comment for precisely what sets `transportFailure`.
 */
function describeRejectedSource(result: VerificationResult): string {
  if (result.transportFailure) {
    const status = result.transportFailure.httpStatus !== undefined ? `, http ${result.transportFailure.httpStatus}` : "";
    return `could not be read: ${result.transportFailure.reason}${status}`;
  }
  return result.reason;
}

/**
 * Every URL the candidate will PUBLISH: the payload's own `sources[].url`
 * (what the reviewer sees cited on the facility) plus `provenance.sources`
 * (what the submission envelope records), de-duplicated in first-seen order.
 * The gate must verify this whole set — verifying only `provenance.sources`
 * left payload URLs nothing had ever fetched (A-OPS-02).
 */
function collectPublishedUrls(payloadSources: Source[], provenanceSources: string[]): string[] {
  return [...new Set([...payloadSources.map((s) => s.url), ...provenanceSources])];
}

/** Per-URL outcome the gate records; `dropped` URLs are stripped from the staged payload. */
interface UrlVerdictLine {
  url: string;
  outcome: "verified" | "dropped" | "kept-unverified";
  /** Fixed outcome word + reason CODE only: this lands in provenance.note. */
  code: string;
}

/**
 * The reason CODE for a non-verified result, safe for provenance.note (which
 * the admin submission list renders). `VerificationResult.reason` can embed
 * page-sourced text (a quote fragment, see verify-source.ts), so it is NEVER
 * used here: only the structural `transportFailure` enum (+ HTTP status) or a
 * fixed word.
 */
function urlOutcomeCode(result: VerificationResult): string {
  const word = result.verdict === "escalate" ? "escalated" : "rejected";
  if (result.transportFailure) {
    const status = result.transportFailure.httpStatus !== undefined ? `_${result.transportFailure.httpStatus}` : "";
    return `${word}: ${result.transportFailure.reason}${status}`;
  }
  // verifySource rejects licence-restricted domains before any fetch, so no transportFailure is set.
  if (isRestrictedSourceUrl(result.sourceUrl)) return `${word}: restricted_source`;
  return `${word}: ${result.verdict === "escalate" ? "unconfirmed" : "content_mismatch"}`;
}

const MAX_NOTE_URL_CHARS = 200;
const MAX_VERDICT_NOTE_CHARS = 2_000;

/** One URL, made safe and bounded for the note: control/whitespace chars become "_", length capped. */
function noteUrl(url: string): string {
  const safe = url.replace(/[\s\u0000-\u001f\u007f]/g, "_");
  return safe.length > MAX_NOTE_URL_CHARS ? `${safe.slice(0, MAX_NOTE_URL_CHARS)}...` : safe;
}

/**
 * Renders the per-URL verdict list for provenance.note, bounded to
 * `MAX_VERDICT_NOTE_CHARS`. Dropped entries come first, then kept-unverified,
 * then verified, so truncation (`+N more`) hides the least interesting ones.
 */
function renderVerdictNote(lines: UrlVerdictLine[]): string | undefined {
  if (lines.every((l) => l.outcome === "verified")) return undefined;
  const rank = { dropped: 0, "kept-unverified": 1, verified: 2 } as const;
  const entries = [...lines]
    .sort((x, y) => rank[x.outcome] - rank[y.outcome])
    .map((l) => `${noteUrl(l.url)} ${l.outcome === "dropped" ? "DROPPED" : "kept"} (${l.code})`);
  const prefix = "Source verification: ";
  let out = prefix;
  for (let i = 0; i < entries.length; i++) {
    const piece = (i === 0 ? "" : "; ") + entries[i];
    const reserve = i < entries.length - 1 ? `; +${entries.length - i - 1} more`.length : 0;
    if (out.length + piece.length + reserve > MAX_VERDICT_NOTE_CHARS && i > 0) {
      return `${out}; +${entries.length - i} more`;
    }
    out += piece;
  }
  return out;
}

/**
 * Runs the verification gate over every URL in `urls` for `claim` (the
 * published set — see `collectPublishedUrls`). Never called when
 * `opts.dryRun` or `deps.verifyImpl` is absent — callers check that before
 * invoking this.
 *
 * - URLs are de-duplicated by `normalizeSourceUrl` (case, fragment, trailing
 *   slash): spellings of one URL share one verdict and one `verifyImpl` call,
 *   and a drop applies to every raw spelling.
 * - Any source verdict of `"unavailable"` throws `VerificationGateUnavailableError`
 *   immediately, stopping BEFORE checking the candidate's remaining sources —
 *   if the model is unreachable for one URL it is unreachable for all of
 *   them, so there is nothing to gain by continuing to ask.
 *   ONE exception: an `"unavailable"` flagged `modelTimedOut` (a single model
 *   call hit its per-call timeout) first consults `guard.probe`. If Ollama
 *   answers and the verify model is present, that source simply does not
 *   verify (the remaining sources are still checked). An unhealthy or
 *   throwing probe, no probe, or an exhausted `guard.remaining` budget (a
 *   degraded Ollama) throws as above. A non-timeout "unavailable" never
 *   reaches the probe.
 * - Each URL is judged individually. `dropUrls` holds every URL that is not
 *   `"verified"` and not kept-escalated; callers strip those from what gets
 *   staged, so one verified URL no longer carries dead or fabricated siblings.
 * - >=1 `"verified"` URL -> survives. `"escalate"` URLs (page too large, or
 *   not readable even through the PDF path) are KEPT only because some other
 *   URL verified, and are labelled "unverified (escalated: <code>)" in the
 *   note. Rejected and timed-out URLs are dropped.
 * - 0 `"verified"` -> does not survive, even if some URL escalated: an
 *   escalation alone is not mechanical verification. `rejectionDetail` (a
 *   log line, never persisted) summarizes each URL (`describeRejectedSource`),
 *   including whether it was ever actually read.
 * - `urls` is empty -> does not survive, with a `rejectionDetail` that says
 *   plainly nothing was cited.
 * - `verdictNote` lists every URL's outcome whenever any URL was dropped or
 *   kept unverified. It carries ONLY the URL plus a fixed reason code
 *   (`urlOutcomeCode`) — never `VerificationResult.reason`, which can contain
 *   page-sourced text — and is bounded (`renderVerdictNote`).
 */
async function verifyCandidateSources(
  urls: string[],
  claim: VerifyClaim,
  verifyImpl: (url: string, claim: VerifyClaim) => Promise<VerificationResult>,
  guard: TimeoutGuard
): Promise<{ survives: boolean; verdictNote?: string; rejectionDetail?: string; dropUrls: Set<string> }> {
  // canonical key -> every raw spelling seen (first one is the one verified).
  const spellings = new Map<string, string[]>();
  for (const url of urls) {
    const key = normalizeSourceUrl(url);
    const seen = spellings.get(key);
    if (seen) {
      if (!seen.includes(url)) seen.push(url);
    } else {
      spellings.set(key, [url]);
    }
  }

  const results: Array<{ url: string; result: VerificationResult }> = [];
  const timedOutUrls: string[] = [];
  for (const [, [url]] of spellings) {
    const result = await verifyImpl(url, claim);
    if (result.verdict === "unavailable") {
      if (!result.modelTimedOut || !guard.probe) {
        throw new VerificationGateUnavailableError(url, result.reason);
      }
      let probe: ProbeOllamaResult;
      try {
        probe = await guard.probe();
      } catch (err) {
        // A probe that throws proves nothing about health: treat as unhealthy.
        probe = { ok: false, reason: `probe threw: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (!probe.ok) {
        throw new VerificationGateUnavailableError(
          url,
          `${result.reason}; health probe also failed (${probe.reason})`
        );
      }
      if (guard.remaining <= 0) {
        throw new VerificationGateUnavailableError(
          url,
          `${result.reason}; the per-run timeout budget is exhausted (Ollama answers its health probe but ` +
            `model calls keep timing out, so it is degraded)`
        );
      }
      guard.remaining--;
      timedOutUrls.push(url);
      continue;
    }
    results.push({ url, result });
  }

  const allSpellings = (url: string): string[] => spellings.get(normalizeSourceUrl(url)) ?? [url];
  const dropUrls = new Set<string>();
  const lines: UrlVerdictLine[] = [];
  const logParts: string[] = [];
  const anyVerified = results.some(({ result }) => result.verdict === "verified");
  for (const { url, result } of results) {
    if (result.verdict === "verified") {
      lines.push({ url, outcome: "verified", code: "verified" });
    } else if (result.verdict === "escalate" && anyVerified) {
      lines.push({ url, outcome: "kept-unverified", code: `unverified (${urlOutcomeCode(result)})` });
    } else {
      for (const spelling of allSpellings(url)) dropUrls.add(spelling);
      lines.push({ url, outcome: "dropped", code: urlOutcomeCode(result) });
    }
    if (result.verdict !== "verified") {
      logParts.push(`${url} (${result.verdict === "escalate" ? `escalated: ${result.reason}` : describeRejectedSource(result)})`);
    }
  }
  for (const url of timedOutUrls) {
    for (const spelling of allSpellings(url)) dropUrls.add(spelling);
    lines.push({ url, outcome: "dropped", code: "timed_out" });
    logParts.push(`${url} (verification call timed out while Ollama was healthy)`);
  }

  if (anyVerified) {
    return { survives: true, verdictNote: renderVerdictNote(lines), dropUrls };
  }

  return {
    survives: false,
    rejectionDetail: logParts.length === 0 ? "no sources were cited, so there was nothing to verify" : logParts.join("; "),
    dropUrls,
  };
}

// --- restricted-source guard ------------------------------------------------
//
// A candidate can SURVIVE the verification gate above via a non-restricted
// source while still carrying a restricted one (isRestrictedSourceUrl,
// lib/restricted-sources.ts) that verify-source.ts rejected without even
// fetching it — the gate only decides whether the candidate as a WHOLE
// survives, it never removes the individual source that failed. Left alone,
// that restricted URL rides in on the verified sibling and reaches
// `pending`, then `live` — exactly how 3 NY facilities cited
// interconnection.fyi in prod despite the gate correctly rejecting it
// per-source (2026-09-21). This section is the fix: strip every restricted
// source out of what actually gets staged, independent of whether the
// verification gate even ran (it is skipped entirely in dry-run and when
// VERIFY_SOURCES_ENABLED=false, and a restricted source must never reach
// `pending` in ANY of those runs).
//
// The hazard this must respect: removing an entry from a `sources[]` array
// shifts every LATER index down by one — always back INTO range — so the
// schema's own bounds validators (`checkSourceIndexBounds` in
// lib/schema.ts, `enrichmentUpdateIntentSchema`'s superRefine) cannot catch
// a `sourceIndex`/`sourceRel` that now resolves to the WRONG source; they
// only reject an index that falls OUT of range. `stripRestrictedFromSources`
// below builds the old-index -> new-index mapping POSITIONALLY, in the same
// pass that filters restricted entries out, so the remap can never confuse
// two sources that share a URL with different metadata (a shape this
// project's live data actually has: duplicate URLs with different
// `label`/`kind`). URL IDENTITY is then asserted on top, as a cheap
// invariant check rather than the lookup mechanism: for every reference a
// record carries, the URL it resolved to BEFORE the strip must still equal
// the URL it resolves to AFTER. If a reference's own source was the one
// removed, there is no honest remap — the candidate is reported unstageable
// rather than risk pointing a citation at the wrong source.

/**
 * URLs the verification gate dropped (see `verifyCandidateSources`'s
 * `dropUrls`), stripped alongside restricted ones by the two functions below.
 * Empty when the gate did not run (dry-run, VERIFY_SOURCES_ENABLED=false).
 */
const NO_DROPPED_URLS: ReadonlySet<string> = new Set();

/**
 * Reports a strip that could not be honored and counts it. When a citation
 * pointed at the stripped source (`failingUrl`), the counter follows THAT
 * URL: restricted -> `skippedRestrictedSource`, dropped as unverified ->
 * `skippedUnverified`, whatever else was stripped alongside. With no failing
 * reference (the strip would empty the list), it is an unverified skip iff the
 * gate dropped any non-restricted URL.
 */
function skipOnStripFailure(
  label: string,
  failure: { removedUrls: string[]; reason: string; failingUrl?: string },
  dropUrls: ReadonlySet<string>,
  summary: RunSubmitSummary
): void {
  const unverifiedDrop = (u: string) => dropUrls.has(u) && !isRestrictedSourceUrl(u);
  const unverified =
    failure.failingUrl !== undefined ? unverifiedDrop(failure.failingUrl) : failure.removedUrls.some(unverifiedDrop);
  console.log(
    `skip ${unverified ? "unverified" : "restricted"}: ${label} — ${failure.reason} (${unverified ? "unverified/restricted" : "restricted"} source(s): ${failure.removedUrls.join(", ")})`
  );
  if (unverified) summary.skippedUnverified++;
  else summary.skippedRestrictedSource++;
}

interface SourceIndexRef {
  /** Human-readable path for logging, e.g. "subsidies[2].sourceIndex". */
  path: string;
  index: number;
}

/**
 * Strips restricted-source entries out of `sources` and remaps every
 * `SourceIndexRef` in `refs` to the new position of its OWN source,
 * computed positionally in the same pass that filters (see the section doc
 * comment above for why: two sources can share a URL with different
 * metadata, and a URL-search remap would silently resolve to the wrong
 * one). URL identity is still asserted on top, as a verifying invariant.
 * Returns `{ ok: false }` when a reference cannot be honestly remapped (its
 * own source was the one restricted, or the identity assertion fails) or
 * when stripping would leave `sources` empty — both cases mean the
 * candidate cannot be safely staged and callers must skip it, not submit a
 * corrupted or citation-less record.
 *
 * A restricted source is always verdict "rejected" by verify-source.ts,
 * never "verified"/"escalate" — so a candidate that SURVIVED the
 * verification gate can never lose its one surviving source here; only a
 * candidate that never went through the gate (dry-run, no verifyImpl) can
 * hit the "would leave sources empty" case from restriction alone.
 */
function stripRestrictedFromSources(
  sources: Source[],
  refs: SourceIndexRef[],
  dropUrls: ReadonlySet<string> = NO_DROPPED_URLS
):
  | { ok: true; sources: Source[]; removedUrls: string[]; remapped: Map<string, number> }
  | { ok: false; removedUrls: string[]; reason: string; failingUrl?: string } {
  const removedUrls: string[] = [];
  const oldToNew = new Map<number, number>();
  const kept: Source[] = [];
  sources.forEach((s, i) => {
    if (isRestrictedSourceUrl(s.url) || dropUrls.has(s.url)) {
      removedUrls.push(s.url);
      return;
    }
    oldToNew.set(i, kept.length);
    kept.push(s);
  });

  if (removedUrls.length === 0) {
    // Nothing restricted — identity remap, nothing to rebuild.
    return { ok: true, sources, removedUrls: [], remapped: new Map(refs.map((r) => [r.path, r.index])) };
  }

  if (kept.length === 0) {
    return { ok: false, removedUrls, reason: "stripping restricted source(s) would leave sources empty" };
  }

  const remapped = new Map<string, number>();
  for (const ref of refs) {
    const newIndex = oldToNew.get(ref.index);
    if (newIndex === undefined) {
      return {
        ok: false,
        removedUrls,
        reason: `${ref.path} (index ${ref.index}) referenced a stripped source`,
        failingUrl: sources[ref.index]?.url,
      };
    }
    // Verifying invariant, not the lookup mechanism: the positional map
    // above should make this unfalsifiable by construction, but assert it
    // anyway so a future edit that desyncs the two paths fails loudly
    // instead of silently mis-citing a source.
    if (kept[newIndex]?.url !== sources[ref.index]?.url) {
      return {
        ok: false,
        removedUrls,
        reason: `${ref.path} (index ${ref.index}) remapped to a source with a mismatched URL — refusing to stage`,
        failingUrl: sources[ref.index]?.url,
      };
    }
    remapped.set(ref.path, newIndex);
  }

  return { ok: true, sources: kept, removedUrls, remapped };
}

/**
 * Sibling of `stripRestrictedFromSources` for `provenance.sources` — a flat
 * list of plain URL strings with no index references into it anywhere in
 * this module, so no remap is needed. Still guards against emptying: if
 * every cited provenance URL turns out restricted, that candidate cannot be
 * safely staged either.
 */
function stripRestrictedUrls(
  urls: string[],
  dropUrls: ReadonlySet<string> = NO_DROPPED_URLS
): { ok: true; kept: string[]; removedUrls: string[] } | { ok: false; removedUrls: string[]; reason: string } {
  const removedUrls: string[] = [];
  const kept = urls.filter((u) => {
    if (isRestrictedSourceUrl(u) || dropUrls.has(u)) {
      removedUrls.push(u);
      return false;
    }
    return true;
  });
  if (removedUrls.length > 0 && kept.length === 0) {
    return { ok: false, removedUrls, reason: "stripping restricted source(s) would leave provenance.sources empty" };
  }
  return { ok: true, kept, removedUrls };
}

/**
 * Rebuilds a validated Facility doc with a stripped `sources` array and
 * every retained sourceIndex remapped. `Facility` is a discriminatedUnion on
 * `facilityType` — a plain `{...doc, ...overrides}` spread can lose the
 * branch's literal `facilityType` narrowing across a union (see
 * lib/status-update.ts's `applyStatusUpdate` for the same pattern), so this
 * switches on it instead of spreading generically.
 */
function applyDocSourceStrip(doc: Facility, sources: Source[], remapped: Map<string, number>): Facility {
  const statusHistory = doc.statusHistory.map((event, i) => {
    const idx = remapped.get(`statusHistory[${i}].sourceIndex`);
    return idx === undefined ? event : { ...event, sourceIndex: idx };
  });
  const subsidies = doc.subsidies?.map((s, i) => {
    const idx = remapped.get(`subsidies[${i}].sourceIndex`);
    return idx === undefined ? s : { ...s, sourceIndex: idx };
  });
  // Unreachable in THIS lane — `normalizeCandidates` strips `stakeholders`
  // before validation (see `stripCuratedFields`) — but kept so this function
  // stays correct for any `Facility`: silently leaving a stale sourceIndex
  // behind would mis-cite a named person, which is worse than a no-op branch.
  const stakeholders = doc.stakeholders?.map((s, i) => ({
    ...s,
    sourceIndex: remapped.get(`stakeholders[${i}].sourceIndex`) ?? s.sourceIndex,
  }));
  const jobs = doc.jobs
    ? { ...doc.jobs, sourceIndex: remapped.get("jobs.sourceIndex") ?? doc.jobs.sourceIndex }
    : doc.jobs;
  const community = doc.community
    ? { ...doc.community, sourceIndex: remapped.get("community.sourceIndex") ?? doc.community.sourceIndex }
    : doc.community;
  const emissions = doc.emissions
    ? { ...doc.emissions, sourceIndex: remapped.get("emissions.sourceIndex") ?? doc.emissions.sourceIndex }
    : doc.emissions;

  const overrides = {
    sources,
    statusHistory,
    ...(subsidies !== undefined ? { subsidies } : {}),
    ...(stakeholders !== undefined ? { stakeholders } : {}),
    ...(jobs !== undefined ? { jobs } : {}),
    ...(community !== undefined ? { community } : {}),
    ...(emissions !== undefined ? { emissions } : {}),
  };

  switch (doc.facilityType) {
    case "data_center":
      return { ...doc, ...overrides };
    case "crypto_mining":
      return { ...doc, ...overrides };
    case "power_generation":
      return { ...doc, ...overrides };
  }
}

/**
 * Sibling of `applyDocSourceStrip` for an enrichment_update intent — a plain
 * (non-discriminated-union) object, so a direct spread is safe.
 */
function applyEnrichmentIntentSourceStrip(
  intent: EnrichmentUpdateIntent,
  sources: Source[],
  remapped: Map<string, number>
): EnrichmentUpdateIntent {
  const fields = { ...intent.fields };
  if (fields.jobs) {
    fields.jobs = { ...fields.jobs, sourceRel: remapped.get("fields.jobs.sourceRel") ?? fields.jobs.sourceRel };
  }
  if (fields.community) {
    fields.community = {
      ...fields.community,
      sourceRel: remapped.get("fields.community.sourceRel") ?? fields.community.sourceRel,
    };
  }
  if (fields.subsidies) {
    fields.subsidies = fields.subsidies.map((s, i) => ({
      ...s,
      sourceRel: remapped.get(`fields.subsidies[${i}].sourceRel`) ?? s.sourceRel,
    }));
  }
  const reSourced = intent.reSourced?.map((r, i) => ({
    ...r,
    sourceRel: remapped.get(`reSourced[${i}].sourceRel`) ?? r.sourceRel,
  }));

  return {
    ...intent,
    sources,
    fields,
    ...(reSourced !== undefined ? { reSourced } : {}),
  };
}

// --- core --------------------------------------------------------------------

/** Retries after a failed connect; total attempts = 1 + this. */
const POST_CONNECT_RETRIES = 2;
const POST_RETRY_BASE_MS = 5000;
/** Server error bodies are logged bounded: they come from the network. */
const MAX_ERROR_BODY_CHARS = 300;

/**
 * ⚠️ LOAD-BEARING SAFETY LIST. `POST /api/submissions` has NO idempotency key, so
 * a retry is safe ONLY when the request provably never reached the server. NEVER
 * add ECONNRESET, read/headers timeouts or any HTTP status here: the server may
 * have processed the request and a retry would stage a second `pending` row (a
 * human still reviews it, but it is a duplicate).
 *
 * Error codes proving the request NEVER reached the server, so a retry cannot
 * double-stage a submission. ECONNRESET / read timeouts are deliberately absent:
 * the server may have processed the POST, and a retry could create a second
 * pending row. 2026-11-04..06: a single UND_ERR_CONNECT_TIMEOUT (10s) on one
 * POST failed the whole state ("submit failed") in TX/VA/AZ.
 */
const PRE_CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Codes on the error, its cause, and the cause's AggregateError children (multi-address connects). */
function failureCodes(err: unknown): unknown[] {
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: unknown; errors?: unknown } | undefined;
  const children = Array.isArray(cause?.errors) ? (cause.errors as Array<{ code?: unknown } | null>) : [];
  return [(err as { code?: unknown } | null)?.code, cause?.code, ...children.map((c) => c?.code)];
}

function isPreConnectFailure(err: unknown): boolean {
  // Every DEFINED code must be whitelisted: one non-whitelisted code (e.g. an
  // ECONNRESET child) means a connection may have been made, so no retry.
  const defined = failureCodes(err).filter((c) => c !== undefined && c !== null);
  return defined.length > 0 && defined.every((c) => typeof c === "string" && PRE_CONNECT_CODES.has(c));
}

/** Summaries whose state hit an exhausted pre-connect retry budget: skip the rest of their POSTs. */
const connectOutage = new WeakSet<RunSubmitSummary>();

/**
 * POST one envelope to /api/submissions and count the outcome. Failures log
 * `error: submit {failed|threw} for <id> (stage=POST[, attempt n/m]) — <status> <body>`
 * so launchd.out alone names the candidate, stage and server answer.
 */
async function postSubmission(
  deps: RunSubmitDeps,
  opts: RunSubmitOptions,
  envelope: unknown,
  id: string,
  summary: RunSubmitSummary
): Promise<void> {
  if (connectOutage.has(summary)) {
    summary.errors++;
    return;
  }
  const sleep = deps.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = 1 + POST_CONNECT_RETRIES;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await deps.fetchImpl(`${opts.baseUrl}/api/submissions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${submissionToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        const body = scrubUriCredentials((await res.text().catch(() => "")).replace(/[\r\n]+/g, " ")).slice(0, MAX_ERROR_BODY_CHARS);
        console.log(`error: submit failed for ${id} (stage=POST) — ${res.status} ${body}`);
        summary.errors++;
        return;
      }
      summary.submitted++;
      summary.submittedIds.push(id);
      return;
    } catch (err) {
      if (attempt < attempts && isPreConnectFailure(err)) {
        console.log(`retry: submit connect failed for ${id} (attempt ${attempt}/${attempts}) — ${formatErrorSummary(err)}`);
        await sleep(POST_RETRY_BASE_MS * attempt);
        continue;
      }
      console.log(`error: submit threw for ${id} (stage=POST, attempt ${attempt}/${attempts}) — ${formatErrorSummary(err)}`);
      summary.errors++;
      if (isPreConnectFailure(err)) {
        connectOutage.add(summary);
        console.log(`error: connect retry budget exhausted for ${id}; skipping the remaining POSTs for this run (each counted as an error, state fails)`);
      }
      return;
    }
  }
}

/**
 * Testable core: validates, dedupes, classifies, caps, and (optionally)
 * submits candidates. The CLI `main()` below wraps this with argv parsing,
 * file I/O, and process.exit — tests call this directly with injected
 * `fetch`/`existingFacilities` so nothing shells out.
 */
export async function runSubmit(
  candidates: unknown[],
  opts: RunSubmitOptions,
  deps: RunSubmitDeps
): Promise<RunSubmitSummary> {
  const summary: RunSubmitSummary = {
    runId: opts.runId,
    state: opts.state ?? null,
    discovered: candidates.length,
    submitted: 0,
    skippedDuplicate: 0,
    skippedInvalid: 0,
    skippedOverCap: 0,
    skippedUnverified: 0,
    skippedRestrictedSource: 0,
    errors: 0,
    submittedIds: [],
  };

  // Before ANY work, so a caller holding this reference can still log how far
  // the run got if it aborts (see `RunSubmitDeps.onSummaryInit`).
  deps.onSummaryInit?.(summary);

  const timeoutGuard: TimeoutGuard = {
    probe: deps.probeOllama,
    remaining: deps.timeoutBudget ?? DEFAULT_TIMEOUT_BUDGET,
  };

  if (!opts.dryRun && !deps.verifyImpl) {
    console.warn(
      "WARN: source verification gate is not wired (deps.verifyImpl is absent) — candidates will be " +
        "submitted WITHOUT mechanical source verification. Expected for test callers or an explicit " +
        "VERIFY_SOURCES_ENABLED=false; unexpected in any other real run."
    );
  }

  const normalized = normalizeCandidates(candidates);
  const { ids: existingIds, nameStateCity: existingNameStateCity, byId: existingById } = buildExistingIndex(
    deps.existingFacilities
  );

  // Shared --max cap across all kinds, but net-new discovery + status refreshes
  // take priority: process them first so a burst of enrichment can never starve
  // discovery review. Enrichment fills leftover cap budget. (Ed's review-load
  // calibration is a single daily number spanning both streams.)
  const ordered = [
    ...normalized.filter((c) => c.type !== "enrichment_update"),
    ...normalized.filter((c) => c.type === "enrichment_update"),
  ];

  for (const candidate of ordered) {
    if (candidate.type === "enrichment_update") {
      const targetFacilityId = candidate.targetFacilityId;
      const idLabel = typeof targetFacilityId === "string" && targetFacilityId ? targetFacilityId : "(no id)";

      if (typeof targetFacilityId !== "string" || targetFacilityId.length === 0) {
        console.log(`skip invalid: ${idLabel} — targetFacilityId is required`);
        summary.skippedInvalid++;
        continue;
      }
      if (!existingIds.has(targetFacilityId)) {
        console.log(`skip invalid: ${targetFacilityId} — enrichment_update target not found`);
        summary.skippedInvalid++;
        continue;
      }

      // enrichmentUpdateIntentSchema is `.strict()` and does not declare
      // targetFacilityId — it lives inside the wrapper alongside the intent
      // fields (see lib/enrichment-update.ts), not as an intent field itself.
      // Strip it before validating or a strict-schema extra-key rejection
      // fires even on an otherwise well-formed intent.
      const intentSource = (candidate.intent as Record<string, unknown>) ?? {};
      const intentBody = Object.fromEntries(
        Object.entries(intentSource).filter(([key]) => key !== "targetFacilityId")
      );
      const parsedIntent = enrichmentUpdateIntentSchema.safeParse(intentBody);
      if (!parsedIntent.success) {
        console.log(
          `skip invalid: ${targetFacilityId} — ${parsedIntent.error.issues[0]?.message ?? "enrichment_update schema validation failed"}`
        );
        summary.skippedInvalid++;
        continue;
      }

      // Checked before the gate (no Ollama spend); a duplicate arriving at the cap counts as skippedOverCap.
      if (summary.submitted >= opts.max) {
        console.log(`skip over cap: ${targetFacilityId} — --max=${opts.max} already reached`);
        summary.skippedOverCap++;
        continue;
      }

      let verdictNote: string | undefined;
      let dropUrls: ReadonlySet<string> = NO_DROPPED_URLS;
      if (!opts.dryRun && deps.verifyImpl) {
        const entityName = existingById.get(targetFacilityId)?.name ?? targetFacilityId;
        const gate = await verifyCandidateSources(
          collectPublishedUrls(parsedIntent.data.sources, candidate.provenance.sources ?? []),
          { entityName },
          deps.verifyImpl,
          timeoutGuard
        );
        if (!gate.survives) {
          console.log(`skip unverified: ${targetFacilityId} — ${gate.rejectionDetail}`);
          summary.skippedUnverified++;
          continue;
        }
        verdictNote = gate.verdictNote;
        dropUrls = gate.dropUrls;
      }

      // Same asymmetry as the docSourceRefs block above, for the enrichment
      // schema — but here it is the CONTAINER that is optional, not the
      // field: fields.jobs and fields.community are optional objects, so
      // `?.sourceRel` yields undefined when they are absent and the guard is
      // required. fields.subsidies[] and reSourced[] are arrays whose
      // elements each declare sourceRel as required (lib/enrichment-update.ts),
      // so pushing unconditionally there is correct, not an oversight.
      const enrichmentSourceRefs: SourceIndexRef[] = [];
      if (parsedIntent.data.fields.jobs?.sourceRel !== undefined) {
        enrichmentSourceRefs.push({ path: "fields.jobs.sourceRel", index: parsedIntent.data.fields.jobs.sourceRel });
      }
      if (parsedIntent.data.fields.community?.sourceRel !== undefined) {
        enrichmentSourceRefs.push({
          path: "fields.community.sourceRel",
          index: parsedIntent.data.fields.community.sourceRel,
        });
      }
      parsedIntent.data.fields.subsidies?.forEach((s, i) => {
        enrichmentSourceRefs.push({ path: `fields.subsidies[${i}].sourceRel`, index: s.sourceRel });
      });
      parsedIntent.data.reSourced?.forEach((r, i) => {
        enrichmentSourceRefs.push({ path: `reSourced[${i}].sourceRel`, index: r.sourceRel });
      });

      const enrichmentSourceStrip = stripRestrictedFromSources(parsedIntent.data.sources, enrichmentSourceRefs, dropUrls);
      if (!enrichmentSourceStrip.ok) {
        skipOnStripFailure(targetFacilityId, enrichmentSourceStrip, dropUrls, summary);
        continue;
      }
      const enrichmentProvenanceStrip = stripRestrictedUrls(candidate.provenance.sources ?? [], dropUrls);
      if (!enrichmentProvenanceStrip.ok) {
        skipOnStripFailure(targetFacilityId, enrichmentProvenanceStrip, dropUrls, summary);
        continue;
      }
      let enrichmentPayload = parsedIntent.data;
      if (enrichmentSourceStrip.removedUrls.length > 0) {
        enrichmentPayload = applyEnrichmentIntentSourceStrip(
          parsedIntent.data,
          enrichmentSourceStrip.sources,
          enrichmentSourceStrip.remapped
        );
        console.log(
          `stripped restricted/unverified source(s) from ${targetFacilityId}: ${enrichmentSourceStrip.removedUrls.join(", ")}`
        );
      }

      const envelope = {
        kind: "enrichment_update" as const,
        targetFacilityId,
        payload: enrichmentPayload,
        provenance: buildProvenance(
          { ...candidate.provenance, sources: enrichmentProvenanceStrip.kept },
          opts.runId,
          opts.discoveredAt,
          verdictNote
        ),
      };

      if (opts.dryRun) {
        console.log(`dry-run: would submit enrichment_update for ${targetFacilityId}`);
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
        continue;
      }

      await postSubmission(deps, opts, envelope, targetFacilityId, summary);
      continue;
    }

    if (candidate.type === "status_update") {
      const targetFacilityId = candidate.targetFacilityId;
      const idLabel = typeof targetFacilityId === "string" && targetFacilityId ? targetFacilityId : "(no id)";

      if (typeof targetFacilityId !== "string" || targetFacilityId.length === 0) {
        console.log(`skip invalid: ${idLabel} — targetFacilityId is required`);
        summary.skippedInvalid++;
        continue;
      }
      if (!existingIds.has(targetFacilityId)) {
        console.log(`skip invalid: ${targetFacilityId} — status_update target not found`);
        summary.skippedInvalid++;
        continue;
      }

      const parsedIntent = statusUpdateIntentSchema.safeParse(candidate.intent);
      if (!parsedIntent.success) {
        console.log(
          `skip invalid: ${targetFacilityId} — ${parsedIntent.error.issues[0]?.message ?? "status_update schema validation failed"}`
        );
        summary.skippedInvalid++;
        continue;
      }

      // Checked before the gate (no Ollama spend); a duplicate arriving at the cap counts as skippedOverCap.
      if (summary.submitted >= opts.max) {
        console.log(`skip over cap: ${targetFacilityId} — --max=${opts.max} already reached`);
        summary.skippedOverCap++;
        continue;
      }

      let verdictNote: string | undefined;
      let dropUrls: ReadonlySet<string> = NO_DROPPED_URLS;
      if (!opts.dryRun && deps.verifyImpl) {
        const entityName = existingById.get(targetFacilityId)?.name ?? targetFacilityId;
        const gate = await verifyCandidateSources(
          collectPublishedUrls(parsedIntent.data.sources, candidate.provenance.sources ?? []),
          { entityName },
          deps.verifyImpl,
          timeoutGuard
        );
        if (!gate.survives) {
          console.log(`skip unverified: ${targetFacilityId} — ${gate.rejectionDetail}`);
          summary.skippedUnverified++;
          continue;
        }
        verdictNote = gate.verdictNote;
        dropUrls = gate.dropUrls;
      }

      // status_update's intent carries no sourceIndex/sourceRel refs of its
      // own (sourceIndex is computed at APPLY time as existing.sources.length
      // — see lib/status-update.ts), so there is nothing to remap here.
      const statusSourceStrip = stripRestrictedFromSources(parsedIntent.data.sources, [], dropUrls);
      if (!statusSourceStrip.ok) {
        skipOnStripFailure(targetFacilityId, statusSourceStrip, dropUrls, summary);
        continue;
      }
      const statusProvenanceStrip = stripRestrictedUrls(candidate.provenance.sources ?? [], dropUrls);
      if (!statusProvenanceStrip.ok) {
        skipOnStripFailure(targetFacilityId, statusProvenanceStrip, dropUrls, summary);
        continue;
      }
      let statusPayload: StatusUpdateIntent = parsedIntent.data;
      if (statusSourceStrip.removedUrls.length > 0) {
        statusPayload = { ...parsedIntent.data, sources: statusSourceStrip.sources };
        console.log(
          `stripped restricted/unverified source(s) from ${targetFacilityId}: ${statusSourceStrip.removedUrls.join(", ")}`
        );
      }

      const envelope = {
        kind: "status_update" as const,
        targetFacilityId,
        payload: statusPayload,
        provenance: buildProvenance(
          { ...candidate.provenance, sources: statusProvenanceStrip.kept },
          opts.runId,
          opts.discoveredAt,
          verdictNote
        ),
      };

      if (opts.dryRun) {
        console.log(`dry-run: would submit status_update for ${targetFacilityId}`);
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
        continue;
      }

      await postSubmission(deps, opts, envelope, targetFacilityId, summary);
      continue;
    }

    const parsed = facilitySchema.safeParse(candidate.doc);
    if (!parsed.success) {
      const id =
        typeof (candidate.doc as { id?: unknown })?.id === "string"
          ? (candidate.doc as { id: string }).id
          : "(no id)";
      console.log(
        `skip invalid: ${id} — ${parsed.error.issues[0]?.message ?? "schema validation failed"}`
      );
      summary.skippedInvalid++;
      continue;
    }
    const doc = parsed.data;

    const sources = candidate.provenance.sources ?? [];
    if (sources.length === 0) {
      console.log(`skip invalid: ${doc.id} — provenance.sources must be non-empty`);
      summary.skippedInvalid++;
      continue;
    }

    // Checked before the gate (no Ollama spend); a duplicate arriving at the cap counts as skippedOverCap.
    if (summary.submitted >= opts.max) {
      console.log(`skip over cap: ${doc.id} — --max=${opts.max} already reached`);
      summary.skippedOverCap++;
      continue;
    }

    let verdictNote: string | undefined;
    let dropUrls: ReadonlySet<string> = NO_DROPPED_URLS;
    if (!opts.dryRun && deps.verifyImpl) {
      const gate = await verifyCandidateSources(
        collectPublishedUrls(doc.sources, sources),
        { entityName: doc.name },
        deps.verifyImpl,
        timeoutGuard
      );
      if (!gate.survives) {
        console.log(`skip unverified: ${doc.id} — ${gate.rejectionDetail}`);
        summary.skippedUnverified++;
        continue;
      }
      verdictNote = gate.verdictNote;
      dropUrls = gate.dropUrls;
    }

    const isIdDuplicate = existingIds.has(doc.id);
    const isNameDuplicate = existingNameStateCity.has(
      normKey(doc.name, doc.location.state, doc.location.city ?? "")
    );

    const kind: "create" | "update" = isIdDuplicate ? "update" : "create";

    // Only a name/state/city match on a NEW id counts as a duplicate skip —
    // an id match is legitimately an update, not a duplicate.
    if (!isIdDuplicate && isNameDuplicate) {
      console.log(`skip duplicate: ${doc.id} — matches an existing facility by name/state/city`);
      summary.skippedDuplicate++;
      continue;
    }

    // The undefined-guard below tracks each field's schema optionality, not an
    // oversight: statusHistory[].sourceIndex (lib/schema.ts:66) and
    // subsidies[].sourceIndex (lib/schema.ts:330) are `.optional()`, so without
    // the guard an unset index would push `index: undefined` and spuriously
    // skip the candidate. stakeholders[].sourceIndex is required by its schema,
    // so a guard there would be dead code — it pushes unconditionally on
    // purpose. (`doc.stakeholders` is always undefined here: the field is
    // stripped in `normalizeCandidates` — see `stripCuratedFields` — so this
    // loop is belt-and-braces for a doc that reached validation with one.)
    const docSourceRefs: SourceIndexRef[] = [];
    doc.statusHistory.forEach((event, i) => {
      if (event.sourceIndex !== undefined) {
        docSourceRefs.push({ path: `statusHistory[${i}].sourceIndex`, index: event.sourceIndex });
      }
    });
    doc.subsidies?.forEach((s, i) => {
      if (s.sourceIndex !== undefined) {
        docSourceRefs.push({ path: `subsidies[${i}].sourceIndex`, index: s.sourceIndex });
      }
    });
    doc.stakeholders?.forEach((s, i) => {
      docSourceRefs.push({ path: `stakeholders[${i}].sourceIndex`, index: s.sourceIndex });
    });
    if (doc.jobs?.sourceIndex !== undefined) {
      docSourceRefs.push({ path: "jobs.sourceIndex", index: doc.jobs.sourceIndex });
    }
    if (doc.community?.sourceIndex !== undefined) {
      docSourceRefs.push({ path: "community.sourceIndex", index: doc.community.sourceIndex });
    }
    if (doc.emissions?.sourceIndex !== undefined) {
      docSourceRefs.push({ path: "emissions.sourceIndex", index: doc.emissions.sourceIndex });
    }

    const docSourceStrip = stripRestrictedFromSources(doc.sources, docSourceRefs, dropUrls);
    if (!docSourceStrip.ok) {
      skipOnStripFailure(doc.id, docSourceStrip, dropUrls, summary);
      continue;
    }
    const docProvenanceStrip = stripRestrictedUrls(candidate.provenance.sources ?? [], dropUrls);
    if (!docProvenanceStrip.ok) {
      skipOnStripFailure(doc.id, docProvenanceStrip, dropUrls, summary);
      continue;
    }
    let finalDoc = doc;
    if (docSourceStrip.removedUrls.length > 0) {
      finalDoc = applyDocSourceStrip(doc, docSourceStrip.sources, docSourceStrip.remapped);
      console.log(`stripped restricted/unverified source(s) from ${doc.id}: ${docSourceStrip.removedUrls.join(", ")}`);
    }

    const envelope = {
      kind,
      targetFacilityId: isIdDuplicate ? doc.id : undefined,
      payload: finalDoc,
      provenance: buildProvenance(
        { ...candidate.provenance, sources: docProvenanceStrip.kept },
        opts.runId,
        opts.discoveredAt,
        verdictNote
      ),
    };

    if (opts.dryRun) {
      console.log(`dry-run: would submit ${kind} for ${doc.id}`);
      summary.submitted++;
      summary.submittedIds.push(doc.id);
      continue;
    }

    await postSubmission(deps, opts, envelope, doc.id, summary);
  }

  return summary;
}

// --- CLI -----------------------------------------------------------------

/**
 * Parses the candidates JSON. `claude -p` sometimes prepends a prose preamble
 * (e.g. "I've verified six facilities...\n\n[ ... ]") despite the prompt
 * forbidding it, which breaks a naive JSON.parse. Fast path: the whole file is
 * a JSON array. Fallback: slice from the first `[` to the last `]` and parse.
 */
export function parseCandidatesJson(fileContents: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(fileContents);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to the preamble-tolerant slice
  }
  const start = fileContents.indexOf("[");
  const end = fileContents.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const parsed: unknown = JSON.parse(fileContents.slice(start, end + 1));
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("input did not contain a JSON array of candidates");
}

interface CliArgs {
  inputPath: string;
  runId: string;
  max: number;
  dryRun: boolean;
  baseUrl: string;
  state?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const [inputPath, ...flags] = argv;
  if (!inputPath) {
    console.error(
      "Usage: submit-candidates.ts <candidates.json> [--run-id=ID] [--max=N] [--dry-run] [--base-url=URL] [--state=XX]"
    );
    process.exit(1);
  }

  let runId = `local-${Date.now()}`;
  let max = 5;
  let dryRun = false;
  let baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
  let state: string | undefined;

  for (const flag of flags) {
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag.startsWith("--run-id=")) {
      runId = flag.slice("--run-id=".length);
    } else if (flag.startsWith("--max=")) {
      // A non-numeric value (e.g. MAX_CANDIDATES=abc) would otherwise yield
      // NaN, and `submitted >= NaN` is always false — silently disabling the
      // cap. Clamp to a positive integer, falling back to the default.
      const parsed = Number(flag.slice("--max=".length));
      max = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
    } else if (flag.startsWith("--base-url=")) {
      baseUrl = flag.slice("--base-url=".length);
    } else if (flag.startsWith("--state=")) {
      state = flag.slice("--state=".length);
    }
  }

  return { inputPath, runId, max, dryRun, baseUrl, state };
}

function writeLog(summary: RunSubmitSummary): void {
  const dir = process.env.DISCOVERY_LOG_DIR ?? path.join(process.cwd(), "discovery-logs");
  mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `run-${summary.runId}.json`);
  writeFileSync(logPath, JSON.stringify(summary, null, 2));
}

/**
 * `runSubmit` with the run log written in a `finally` — on the success path AND
 * on an abort, exactly once either way.
 *
 * Why this exists: a `VerificationGateUnavailableError` (Ollama down, model not
 * pulled) aborts the run by design, and the previous `writeLog(summary)` call
 * sat AFTER `runSubmit` returned, so an aborted state wrote no
 * `run-<runId>.json` at all. That made the post-mortem of an outage impossible
 * in the one direction that matters — how many candidates had already reached
 * `pending` before the abort — and left an aborted state looking exactly like
 * a state that never ran.
 *
 * Observability only: the error is rethrown unchanged, so the caller's nonzero
 * exit and the abort semantics are untouched. A failure to WRITE the log is
 * reported but deliberately swallowed — it must not replace the aborting error
 * on its way out of the `finally`, which is how a diagnosable "Ollama is
 * unreachable" message would otherwise turn into an EACCES on the log dir.
 */
export async function runSubmitAndLog(
  candidates: unknown[],
  opts: RunSubmitOptions,
  deps: RunSubmitDeps,
  writeLogImpl: (summary: RunSubmitSummary) => void = writeLog
): Promise<RunSubmitSummary> {
  let partial: RunSubmitSummary | undefined;
  try {
    return await runSubmit(candidates, opts, {
      ...deps,
      onSummaryInit: (summary) => {
        partial = summary;
      },
    });
  } finally {
    if (partial) {
      try {
        writeLogImpl(partial);
      } catch (err) {
        // `redactedErrorCode` rather than `.message`, even though this is an fs
        // error with no bound params and `scripts/` is outside the lint's
        // SCAN_ROOTS. For an fs failure the errno IS the diagnosis (ENOSPC,
        // EACCES, ENOENT) and `.message` adds only the path, which this program
        // already determines. So the pattern the 2026-09-27 wave built a gate
        // against buys nothing here — and an instance that has to be argued safe
        // is what makes the next one arguable.
        console.error(`error: could not write run log (code: ${redactedErrorCode(err)})`);
      }
    }
  }
}

/**
 * Page fetch with the same PDF fallback `extract-fields.ts` uses
 * (`fetchSourceText`): a `bad_content_type` rejection (the page fetcher
 * refuses `application/pdf` on principle) is retried once through
 * `fetchPdfText` (pdftotext) and the extracted text is verified like any other
 * page. A THROWING PDF path is caught and treated as a failure. When the PDF path cannot read it either, the ORIGINAL
 * `bad_content_type` result is returned so verify-source escalates exactly as
 * before; a missing poppler therefore degrades to an escalation, never to a
 * silent accept.
 */
export async function fetchTextWithPdfRetry(
  url: string,
  deps: {
    fetchPageTextImpl: (url: string) => Promise<FetchPageTextResult>;
    fetchPdfTextImpl: (url: string) => Promise<FetchPdfTextResult>;
  }
): Promise<FetchPageTextResult> {
  const pageResult = await deps.fetchPageTextImpl(url);
  if (pageResult.ok || pageResult.reason !== "bad_content_type") return pageResult;
  let pdfResult: FetchPdfTextResult;
  try {
    pdfResult = await deps.fetchPdfTextImpl(url);
  } catch (err) {
    // The PDF path touches the filesystem (temp dir, pdftotext); a throw must
    // degrade to the original bad_content_type (an escalation), never crash the run.
    console.log(`pdf-retry-failed: ${url} — ${formatErrorSummary(err)}`);
    return pageResult;
  }
  return pdfResult.ok
    ? { ok: true, text: pdfResult.text, finalUrl: pdfResult.finalUrl, httpStatus: pdfResult.httpStatus, contentType: pdfResult.contentType }
    : pageResult;
}

/**
 * Constructs the real verification gate: verify-source.ts composed with
 * fetch-page-text.ts (default DNS-pinned fetch) and ollama-client.ts (bound
 * to the global `fetch`, as Ollama is localhost). Called ONLY from inside
 * `main()`, never at module scope — tests/discovery/run.bats's retry-gate
 * check (`candidates_file_shape()`) really does execute this module's
 * top-level scope, via a real `tsx -e` with no Ollama available in CI (see
 * run.bats:43-52 and its Task 7 "import safety" regression tests).
 * Importing `verifySource`/`fetchPageText`/`callOllama` at the top of this
 * file is safe (function references only), and merely CALLING this
 * function is also safe — it just returns a closure, it does not invoke
 * `verifySource` itself. The actual
 * risk is a step further: `main()` both builds AND passes this closure to
 * `runSubmit`, which — if a candidate has sources — genuinely INVOKES it,
 * reaching out over the network. Keeping construction confined to `main()`
 * keeps that one path (guarded by the `isMain` check below) the only place
 * this closure can ever be built or reached at all, rather than relying on
 * "nothing calls it yet" being true at some other, less obviously-guarded
 * call site.
 */
function buildRealVerifyImpl(): (url: string, claim: VerifyClaim) => Promise<VerificationResult> {
  return (url, claim) =>
    verifySource(url, claim, {
      fetchPageTextImpl: (pageUrl) =>
        fetchTextWithPdfRetry(pageUrl, {
          fetchPageTextImpl: (u) => fetchPageText(u, {}),
          fetchPdfTextImpl: (u) => fetchPdfText(u, {}),
        }),
      callOllamaImpl: (opts) => callOllama({ ...opts, fetchImpl: fetch }),
    });
}

/** Real health probe for `RunSubmitDeps.probeOllama`. Built only from `main()`,
 * like `buildRealVerifyImpl()`, so importing this module opens no sockets. */
function buildRealProbe(): () => Promise<ProbeOllamaResult> {
  return () => probeOllama({ timeoutMs: PROBE_TIMEOUT_MS, fetchImpl: fetch });
}

/**
 * The process exit code for a completed run: nonzero iff work was LOST.
 *
 * Until this existed, `main()` ended in an unconditional `process.exit(0)`, so
 * a state in which every single candidate failed to POST printed
 * `"errors": 42` and exited 0 — indistinguishable, to every automated consumer,
 * from a clean run. Only a human reading the summary JSON could tell.
 *
 * What a nonzero exit now sets in motion, end to end — this is the whole point,
 * so do not "simplify" it back to `exit(0)` without understanding what that
 * switches off:
 *   1. Both of `run.sh`'s call sites — the per-state discovery lane and the
 *      enrichment lane — are `if ! npx tsx ... submit-candidates.ts ...`. The
 *      `if !` is deliberate: it guards `set -e` so one state's failure cannot
 *      abort the remaining states in the sweep.
 *   2. That branch logs `WARN: submit-candidates failed ...` and appends to
 *      `FAILURES` (`"<STATE>: submit failed"` / `"enrichment: submit failed"`).
 *   3. A non-empty `FAILURES` publishes the heartbeat as `degraded`.
 *   4. A `degraded` heartbeat fails the GitHub-Actions watchdog — i.e. it
 *      reaches a human.
 * Every link but this one already existed; the exit code was the missing one.
 *
 * ONLY `errors` counts. The five `skipped*` counters are the gates WORKING AS
 * DESIGNED and must never fail the run:
 *   - `skippedDuplicate` — we already track this facility.
 *   - `skippedInvalid` — a per-candidate content rejection. ⚠️ NOT only a
 *     `facilitySchema` failure: of its eight sites only one is that, one is a
 *     provenance rule, and six are intent-shape or target-resolution. The
 *     distinction matters — a stale facility index turns "target not found"
 *     into `skippedInvalid`, so a spike here can mean lost work rather than
 *     bad candidates. This counter has a nonzero HEALTHY baseline, which is
 *     why it cannot gate a binary exit code; a RATE threshold would be the
 *     right instrument and does not exist yet.
 *   - `skippedOverCap` — the run hit its `--max` bound.
 *   - `skippedUnverified` — the source-verification gate correctly REFUSED to
 *     stage something it could not verify. That is the gate succeeding, and on
 *     a bad night it is the majority of a run.
 *   - `skippedRestrictedSource` — a licence-restricted citation could not be
 *     safely stripped.
 * Widening this to any of them would make the healthy operation of a safety
 * gate page a human, and the predictable repair for that is to turn the
 * alerting off. `errors` means something else entirely: we tried to stage a
 * candidate we had already decided was good, and it broke.
 *
 * Deliberately ONE nonzero code, not a graded scale ("some failed" vs "all
 * failed"). The sole consumer is a shell `if !`, which can only see
 * zero/nonzero; a graded code would be a distinction no caller can act on, and
 * a second thing to keep in sync. The graded information is not lost — it is in
 * the summary JSON, which `main()` prints before exiting on the completed-run
 * path (⚠️ not on every path: a `VerificationGateUnavailableError` reaches
 * `main().catch` and prints no summary to stdout — `writeLog` still persists
 * the partial, so diagnosis survives) and
 * `writeLog` persists to `run-<runId>.json`. Exit codes answer "did this run
 * lose work"; the JSON answers "how much, and which". Note too that every other
 * failure path in `main()` already exits 1, so a distinct code here would imply
 * a difference in kind that does not exist.
 */
export function exitCodeForSummary(summary: Pick<RunSubmitSummary, "errors">): number {
  return summary.errors > 0 ? 1 : 0;
}

/**
 * Exported ONLY so a test can prove the wiring below: that the summary JSON is
 * printed and that the exit code is `exitCodeForSummary(summary)` rather than a
 * hardcoded 0. Unit-testing the pure function alone would pass just as happily
 * against the `process.exit(0)` this replaced. The `isMain` guard at the bottom
 * of the file — not the absence of `export` — is what keeps an import from
 * running the CLI.
 */
export async function main(): Promise<void> {
  if (!submissionToken()) {
    console.error(
      process.env.DISCOVERY_REQUIRE_INTAKE_TOKEN === "1"
        ? "API_INTAKE_TOKEN is required when DISCOVERY_REQUIRE_INTAKE_TOKEN=1; refusing to fall back to API_ADMIN_TOKEN."
        : "Neither API_INTAKE_TOKEN nor API_ADMIN_TOKEN is set. Configure API_INTAKE_TOKEN " +
            "(staging-only, preferred) before running the discovery pipeline."
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  let raw: unknown[];
  try {
    const fileContents = readFileSync(args.inputPath, "utf-8");
    raw = parseCandidatesJson(fileContents);
  } catch (err) {
    console.error(`Could not read/parse ${args.inputPath}: ${formatErrorSummary(err)}`);
    process.exit(1);
    return;
  }

  // Fail fast on a stale index, before any candidate is processed. Unlike the
  // four read-only discovery lanes (check-sources.ts, existing-facilities.ts,
  // extract-fields.ts, verify-fields.ts) — where a file fallback is degraded
  // but not corrupting, and gets a loud console.warn instead — this script
  // resolves candidate targets against `existingFacilities` and then POSTs to
  // the very API that just failed to answer. A stale index can turn a
  // recently-approved facility's update into a false "target not found"
  // (counted as `skippedInvalid`, discarding real work silently — see the
  // note above exitCodeForSummary) or re-stage an already-live facility as a
  // duplicate. Both are worse than aborting, and the POST to
  // /api/submissions was going to fail anyway if the API is unreachable, so
  // there is nothing to gain by proceeding. This is deliberately an early
  // abort in main() rather than a new exitCodeForSummary input: a stale index
  // is a precondition failure ("we could not establish what is already
  // live"), not a per-candidate outcome, and exitCodeForSummary's contract is
  // scoped to summarizing candidates that were actually processed — none
  // have been yet at this point, so there is no summary to report and
  // nothing has been staged.
  const existingFacilitiesResult = await loadFacilities();
  if (existingFacilitiesResult.source === "file") {
    console.error(
      `Could not read the live facility index from Neon (${existingFacilitiesResult.dbError}); ` +
        "refusing to stage candidates against the committed data/facilities.json snapshot, which may " +
        "be stale. Staging nothing this run rather than risking a false duplicate or a lost update."
    );
    process.exit(1);
    return;
  }
  const existingFacilities = existingFacilitiesResult.facilities;

  // Default-ON: the real gate always runs unless explicitly disabled. This
  // makes Ollama an operational dependency of a real (non-dry-run) discovery
  // run — accepted per Open Question 3 (Ed). The polarity lives in
  // `verificationEnabled` so a unit test can pin it.
  const verifyImpl = verificationEnabled() ? buildRealVerifyImpl() : undefined;

  // `runSubmitAndLog`, not `runSubmit`: the run log must survive a
  // verification-gate abort, which used to skip `writeLog` entirely.
  const summary = await runSubmitAndLog(
    raw,
    {
      runId: args.runId,
      max: args.max,
      dryRun: args.dryRun,
      baseUrl: args.baseUrl,
      state: args.state,
      discoveredAt: new Date().toISOString(),
    },
    { fetchImpl: fetch, existingFacilities, verifyImpl, probeOllama: verifyImpl ? buildRealProbe() : undefined }
  );

  // Print the summary FIRST, then exit on it: the JSON is the diagnosis, and it
  // has to survive the failure case it describes.
  console.log(JSON.stringify(summary, null, 2));
  process.exit(exitCodeForSummary(summary));
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// submit-candidates.ts ...`), not when `runSubmit`/`normalizeCandidates` are
// imported by the test suite — otherwise importing this module for testing
// would also parse `process.argv` and call `process.exit`.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(formatFatalError(err));
    process.exit(1);
  });
}

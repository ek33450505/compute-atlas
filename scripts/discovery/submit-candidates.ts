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
 * Requires API_ADMIN_TOKEN in the environment (e.g. via --env-file=.env.local).
 *
 * Uses relative imports throughout, matching scripts/seed.ts and scripts/submissions.ts.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitySchema, type Facility } from "../../lib/schema";
import { statusUpdateIntentSchema } from "../../lib/status-update";
import { enrichmentUpdateIntentSchema } from "../../lib/enrichment-update";
import { verifySource, type VerifyClaim, type VerificationResult } from "./verify-source";
import { fetchPageText } from "./fetch-page-text";
import { callOllama } from "./ollama-client";
import { loadFacilities } from "./load-facilities";

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
      return { type: "facility", doc: wrapped.facility, provenance: wrapped.provenance ?? {} };
    }
    return { type: "facility", doc: entry, provenance: {} };
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
 * enrichment_update POST paths. `escalationNote` (from a verification-gate
 * "escalate" verdict — see `verifyCandidateSources`) is appended to any
 * existing `provenance.note` rather than replacing it, so a note the
 * discovery pipeline already wrote is never silently dropped.
 */
function buildProvenance(
  provenance: CandidateProvenance,
  runId: string,
  discoveredAt: string,
  escalationNote?: string
) {
  const noteParts = [provenance.note, escalationNote].filter(
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
    return `${result.sourceUrl} (could not be read: ${result.transportFailure.reason}${status})`;
  }
  return `${result.sourceUrl} (${result.reason})`;
}

/**
 * Runs the verification gate over every URL in `sources` for `claim`. Never
 * called when `opts.dryRun` or `deps.verifyImpl` is absent — callers check
 * that before invoking this.
 *
 * - Any source verdict of `"unavailable"` throws `VerificationGateUnavailableError`
 *   immediately, stopping BEFORE checking the candidate's remaining sources —
 *   if the model is unreachable for one URL it is unreachable for all of
 *   them, so there is nothing to gain by continuing to ask.
 * - >=1 `"verified"` source -> survives, no escalation note.
 * - 0 `"verified"` but >=1 `"escalate"` -> survives, with an escalation note
 *   summarizing the escalated URL(s)/reason(s) for the human reviewer (an
 *   escalated source is never silently dropped nor silently accepted).
 * - 0 `"verified"` and 0 `"escalate"` (every source rejected) -> does not
 *   survive, with `rejectionDetail` summarizing each rejected source's URL
 *   and reason (`describeRejectedSource`) — including whether it was ever
 *   actually read — so a human/log reader can tell "this URL is
 *   unreadable/dead" from "we read the page and the claim was not there"
 *   instead of a single undifferentiated "unverified".
 * - `sources` is empty (the candidate cited nothing) -> does not survive,
 *   with a `rejectionDetail` that says plainly that no sources were cited —
 *   never the empty string `[].map(...).join("; ")` would otherwise produce,
 *   which reads as a dangling "— " in the "skip unverified" log line and
 *   wrongly implies a source was checked and rejected rather than never cited.
 */
async function verifyCandidateSources(
  sources: string[],
  claim: VerifyClaim,
  verifyImpl: (url: string, claim: VerifyClaim) => Promise<VerificationResult>
): Promise<{ survives: boolean; escalationNote?: string; rejectionDetail?: string }> {
  const results: VerificationResult[] = [];
  for (const url of sources) {
    const result = await verifyImpl(url, claim);
    if (result.verdict === "unavailable") {
      throw new VerificationGateUnavailableError(url, result.reason);
    }
    results.push(result);
  }

  if (results.some((r) => r.verdict === "verified")) {
    return { survives: true };
  }

  const escalated = results.filter((r) => r.verdict === "escalate");
  if (escalated.length > 0) {
    return {
      survives: true,
      escalationNote: `Escalated for human review — source(s) could not be mechanically verified: ${escalated
        .map((r) => `${r.sourceUrl} (${r.reason})`)
        .join("; ")}`,
    };
  }

  return {
    survives: false,
    rejectionDetail:
      results.length === 0
        ? "no sources were cited, so there was nothing to verify"
        : results.map(describeRejectedSource).join("; "),
  };
}

// --- core --------------------------------------------------------------------

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
    errors: 0,
    submittedIds: [],
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

      let escalationNote: string | undefined;
      if (!opts.dryRun && deps.verifyImpl) {
        const entityName = existingById.get(targetFacilityId)?.name ?? targetFacilityId;
        const gate = await verifyCandidateSources(
          candidate.provenance.sources ?? [],
          { entityName },
          deps.verifyImpl
        );
        if (!gate.survives) {
          console.log(`skip unverified: ${targetFacilityId} — ${gate.rejectionDetail}`);
          summary.skippedUnverified++;
          continue;
        }
        escalationNote = gate.escalationNote;
      }

      if (summary.submitted >= opts.max) {
        console.log(`skip over cap: ${targetFacilityId} — --max=${opts.max} already reached`);
        summary.skippedOverCap++;
        continue;
      }

      const envelope = {
        kind: "enrichment_update" as const,
        targetFacilityId,
        payload: parsedIntent.data,
        provenance: buildProvenance(candidate.provenance, opts.runId, opts.discoveredAt, escalationNote),
      };

      if (opts.dryRun) {
        console.log(`dry-run: would submit enrichment_update for ${targetFacilityId}`);
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
        continue;
      }

      try {
        const res = await deps.fetchImpl(`${opts.baseUrl}/api/submissions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.API_ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(envelope),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.log(`error: submit failed for ${targetFacilityId} — ${res.status} ${body}`);
          summary.errors++;
          continue;
        }
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
      } catch (err) {
        console.log(`error: submit threw for ${targetFacilityId} — ${(err as Error).message}`);
        summary.errors++;
      }
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

      let escalationNote: string | undefined;
      if (!opts.dryRun && deps.verifyImpl) {
        const entityName = existingById.get(targetFacilityId)?.name ?? targetFacilityId;
        const gate = await verifyCandidateSources(
          candidate.provenance.sources ?? [],
          { entityName },
          deps.verifyImpl
        );
        if (!gate.survives) {
          console.log(`skip unverified: ${targetFacilityId} — ${gate.rejectionDetail}`);
          summary.skippedUnverified++;
          continue;
        }
        escalationNote = gate.escalationNote;
      }

      if (summary.submitted >= opts.max) {
        console.log(`skip over cap: ${targetFacilityId} — --max=${opts.max} already reached`);
        summary.skippedOverCap++;
        continue;
      }

      const envelope = {
        kind: "status_update" as const,
        targetFacilityId,
        payload: parsedIntent.data,
        provenance: buildProvenance(candidate.provenance, opts.runId, opts.discoveredAt, escalationNote),
      };

      if (opts.dryRun) {
        console.log(`dry-run: would submit status_update for ${targetFacilityId}`);
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
        continue;
      }

      try {
        const res = await deps.fetchImpl(`${opts.baseUrl}/api/submissions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.API_ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(envelope),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.log(`error: submit failed for ${targetFacilityId} — ${res.status} ${body}`);
          summary.errors++;
          continue;
        }
        summary.submitted++;
        summary.submittedIds.push(targetFacilityId);
      } catch (err) {
        console.log(`error: submit threw for ${targetFacilityId} — ${(err as Error).message}`);
        summary.errors++;
      }
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

    let escalationNote: string | undefined;
    if (!opts.dryRun && deps.verifyImpl) {
      const gate = await verifyCandidateSources(sources, { entityName: doc.name }, deps.verifyImpl);
      if (!gate.survives) {
        console.log(`skip unverified: ${doc.id} — ${gate.rejectionDetail}`);
        summary.skippedUnverified++;
        continue;
      }
      escalationNote = gate.escalationNote;
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

    if (summary.submitted >= opts.max) {
      console.log(`skip over cap: ${doc.id} — --max=${opts.max} already reached`);
      summary.skippedOverCap++;
      continue;
    }

    const envelope = {
      kind,
      targetFacilityId: isIdDuplicate ? doc.id : undefined,
      payload: doc,
      provenance: buildProvenance(candidate.provenance, opts.runId, opts.discoveredAt, escalationNote),
    };

    if (opts.dryRun) {
      console.log(`dry-run: would submit ${kind} for ${doc.id}`);
      summary.submitted++;
      summary.submittedIds.push(doc.id);
      continue;
    }

    try {
      const res = await deps.fetchImpl(`${opts.baseUrl}/api/submissions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.API_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.log(`error: submit failed for ${doc.id} — ${res.status} ${body}`);
        summary.errors++;
        continue;
      }
      summary.submitted++;
      summary.submittedIds.push(doc.id);
    } catch (err) {
      console.log(`error: submit threw for ${doc.id} — ${(err as Error).message}`);
      summary.errors++;
    }
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
 * Constructs the real verification gate: verify-source.ts composed with
 * fetch-page-text.ts and ollama-client.ts, both bound to the real global
 * `fetch`. Called ONLY from inside `main()`, never at module scope —
 * tests/discovery/run.bats's retry-gate check (`candidates_file_has_array()`)
 * really does execute this module's top-level scope, via a real `tsx -e`
 * with no Ollama available in CI (see run.bats:43-52 and its Task 7
 * "import safety" regression tests). Importing `verifySource`/
 * `fetchPageText`/`callOllama` at the top of this file is safe (function
 * references only), and merely CALLING this function is also safe — it just
 * returns a closure, it does not invoke `verifySource` itself. The actual
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
      fetchPageTextImpl: (pageUrl) => fetchPageText(pageUrl, { fetchImpl: fetch }),
      callOllamaImpl: (opts) => callOllama({ ...opts, fetchImpl: fetch }),
    });
}

async function main(): Promise<void> {
  if (!process.env.API_ADMIN_TOKEN) {
    console.error("API_ADMIN_TOKEN is not set. Configure it before running the discovery pipeline.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  let raw: unknown[];
  try {
    const fileContents = readFileSync(args.inputPath, "utf-8");
    raw = parseCandidatesJson(fileContents);
  } catch (err) {
    console.error(`Could not read/parse ${args.inputPath}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const existingFacilities = await loadFacilities(args.baseUrl);

  // Default-ON: the real gate always runs unless explicitly disabled. This
  // makes Ollama an operational dependency of a real (non-dry-run) discovery
  // run — accepted per Open Question 3 (Ed). VERIFY_SOURCES_ENABLED must be
  // the exact string "false" to opt out; any other value (including unset)
  // keeps the gate on.
  const verifyImpl = process.env.VERIFY_SOURCES_ENABLED === "false" ? undefined : buildRealVerifyImpl();

  const summary = await runSubmit(
    raw,
    {
      runId: args.runId,
      max: args.max,
      dryRun: args.dryRun,
      baseUrl: args.baseUrl,
      state: args.state,
      discoveredAt: new Date().toISOString(),
    },
    { fetchImpl: fetch, existingFacilities, verifyImpl }
  );

  writeLog(summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

// Only run the CLI when this file is executed directly (e.g. `tsx
// submit-candidates.ts ...`), not when `runSubmit`/`normalizeCandidates` are
// imported by the test suite — otherwise importing this module for testing
// would also parse `process.argv` and call `process.exit`.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

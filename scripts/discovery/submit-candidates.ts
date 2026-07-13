/**
 * Deterministic core of the discovery pipeline: takes a JSON array of
 * candidate facility docs (or `{ facility, provenance }` wrappers), validates
 * and dedupes them against the live facility set, and stages the survivors
 * as `pending` submissions via POST /api/submissions. Never writes live
 * facilities directly — that stays a human decision via the Phase 4 CLI
 * (`scripts/submissions.ts`).
 *
 * Run via: tsx scripts/discovery/submit-candidates.ts <candidates.json> [flags]
 * Requires API_ADMIN_TOKEN in the environment (e.g. via --env-file=.env.local).
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching scripts/seed.ts and scripts/submissions.ts.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { facilitySchema, type Facility } from "../../lib/schema";

// --- types -----------------------------------------------------------------

export interface CandidateProvenance {
  sources?: string[];
  confidence?: string;
  discoveredBy?: string;
  runId?: string;
  discoveredAt?: string;
  note?: string;
}

export interface NormalizedCandidate {
  doc: unknown;
  provenance: CandidateProvenance;
}

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
}

export interface RunSubmitSummary {
  runId: string;
  state: string | null;
  discovered: number;
  submitted: number;
  skippedDuplicate: number;
  skippedInvalid: number;
  skippedOverCap: number;
  errors: number;
  submittedIds: string[];
}

// --- normalization -----------------------------------------------------------

/** Accepts either a bare Facility doc or a `{ facility, provenance }` wrapper. */
export function normalizeCandidates(raw: unknown[]): NormalizedCandidate[] {
  return raw.map((entry) => {
    if (
      entry &&
      typeof entry === "object" &&
      "facility" in (entry as Record<string, unknown>)
    ) {
      const wrapped = entry as { facility: unknown; provenance?: CandidateProvenance };
      return { doc: wrapped.facility, provenance: wrapped.provenance ?? {} };
    }
    return { doc: entry, provenance: {} };
  });
}

// --- dedup helpers -----------------------------------------------------------

function normKey(name: string, state: string, city: string): string {
  return `${name.trim().toLowerCase()}|${state.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

function buildExistingIndex(existing: Facility[]): {
  ids: Set<string>;
  nameStateCity: Set<string>;
} {
  const ids = new Set<string>();
  const nameStateCity = new Set<string>();
  for (const f of existing) {
    ids.add(f.id);
    nameStateCity.add(normKey(f.name, f.location.state, f.location.city ?? ""));
  }
  return { ids, nameStateCity };
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
    errors: 0,
    submittedIds: [],
  };

  const normalized = normalizeCandidates(candidates);
  const { ids: existingIds, nameStateCity: existingNameStateCity } = buildExistingIndex(
    deps.existingFacilities
  );

  for (const candidate of normalized) {
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
      provenance: {
        sources,
        confidence: candidate.provenance.confidence,
        discoveredBy: candidate.provenance.discoveredBy ?? "discovery-pipeline",
        runId: candidate.provenance.runId ?? opts.runId,
        discoveredAt: candidate.provenance.discoveredAt ?? opts.discoveredAt,
        note: candidate.provenance.note,
      },
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

/** Fetches the live facility set for dedup — read API first, JSON file fallback. */
async function loadExistingFacilities(baseUrl: string): Promise<Facility[]> {
  try {
    const res = await fetch(`${baseUrl}/api/facilities`);
    if (res.ok) {
      const body = (await res.json()) as { facilities: Facility[] };
      return body.facilities;
    }
  } catch {
    // fall through to file fallback
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as Facility[];
}

function writeLog(summary: RunSubmitSummary): void {
  const dir = process.env.DISCOVERY_LOG_DIR ?? path.join(process.cwd(), "discovery-logs");
  mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `run-${summary.runId}.json`);
  writeFileSync(logPath, JSON.stringify(summary, null, 2));
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
    raw = JSON.parse(fileContents);
  } catch (err) {
    console.error(`Could not read/parse ${args.inputPath}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const existingFacilities = await loadExistingFacilities(args.baseUrl);

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
    { fetchImpl: fetch, existingFacilities }
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

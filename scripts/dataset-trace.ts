/**
 * Leak tracer for the dataset downloads. Given a leaked facilities.json or facilities.csv and the
 * edition it was cut from, ranks every grant by how closely the file's row ORDER matches the order
 * `lib/dataset-watermark.ts` would have served that grant (the watermark is the order itself).
 *
 * Run via: npm run dataset:trace -- <file> --edition <YYYY-MM-DD|uuid>
 * Needs DATABASE_URL, DATASET_WATERMARK_SECRET and the Blob env (`.env.local`).
 *
 * READ-ONLY. The only database access is `loadTraceInputs`, which uses `db.select` and nothing
 * else (guarded by a test). It reads grant id + organization, never an email, and writes nothing
 * to the database, the Blob store or disk. A score is evidence, not proof: a ranked list names
 * who to look at first, and a human decides what it means.
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { readFileSync } from "node:fs";

import { desc, eq } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { formatFatalError } from "../lib/db-error";
import { getEditionFileText } from "../lib/dataset-blob";
import { datasetAccessGrantsTable, datasetEditionsTable } from "../lib/db/schema";
import { watermarkPermutation } from "../lib/dataset-watermark";
import { isEntrypoint } from "./is-entrypoint";

/** Same floor as the download route (`lib/dataset-download.ts`): a shorter secret is not served with, so it cannot trace. */
const MIN_WATERMARK_SECRET_LENGTH = 32;
const TOP_N = 10;

/** Weight of adjacency in `score`; position gets the rest. See `scoreGrants`. */
const ADJACENCY_WEIGHT = 0.75;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceError";
  }
}

export interface TraceGrant {
  id: string;
  organization: string | null;
}

export interface TraceKey {
  secret: string;
  editionId: string;
}

export interface GrantScore {
  grantId: string;
  organization: string | null;
  score: number;
  positionMatch: number;
  adjacentPairs: number;
}

/** The leaked ids that are in the edition's base order, in leaked order; the rest are counted, not scored. */
export function splitKnownIds(leakedIds: string[], baseIds: string[]): { known: string[]; unknown: number } {
  const base = new Set(baseIds);
  const known = leakedIds.filter((id) => base.has(id));
  return { known, unknown: leakedIds.length - known.length };
}

/**
 * Ranks grants by how well the leaked order matches each grant's watermark order for this edition.
 * `baseIds` is the edition's facilities in base order (the order before watermarking); a grant's
 * expected order is `watermarkPermutation(n, ...)` mapped through it. Ids not in `baseIds` are ignored.
 *
 *  - positionMatch: fraction of leaked ids sitting at their expected index. Only meaningful for a
 *    full copy: any dropped row shifts everything after it.
 *  - adjacentPairs: fraction of consecutive leaked pairs (a, b) where b directly follows a in the
 *    expected order. A contiguous slice of the file scores 1.0; a random p-fraction subset keeps
 *    ~p of the pairs adjacent against ~1/n for a wrong grant, so it still separates.
 *  - score = 0.75 * adjacentPairs + 0.25 * positionMatch. Adjacency dominates because it survives
 *    a partial copy; position only breaks ties between full copies.
 *
 * Known limits (a file that has lost its order carries no watermark): re-sorting the file leaves every
 * grant near zero (~0.02 measured). A random subset still ranks the true grant first at 20-50% kept
 * (200 seeds, 200 rows, 20 grants); at 10% kept it fell to first in 152/200 and worst 13th.
 */
export function scoreGrants(
  leakedIds: string[],
  baseIds: string[],
  grants: TraceGrant[],
  key: TraceKey
): GrantScore[] {
  const { known } = splitKnownIds(leakedIds, baseIds);
  const rows = grants.map((grant): GrantScore => {
    const perm = watermarkPermutation(baseIds.length, { secret: key.secret, grantId: grant.id, editionId: key.editionId });
    const expected = perm.map((src) => baseIds[src]);
    const indexOf = new Map(expected.map((id, i) => [id, i]));
    let atPosition = 0;
    let adjacent = 0;
    for (let i = 0; i < known.length; i++) {
      if (expected[i] === known[i]) atPosition++;
      if (i > 0 && indexOf.get(known[i]) === (indexOf.get(known[i - 1]) as number) + 1) adjacent++;
    }
    const positionMatch = known.length > 0 ? atPosition / known.length : 0;
    const adjacentPairs = known.length > 1 ? adjacent / (known.length - 1) : 0;
    return {
      grantId: grant.id,
      organization: grant.organization,
      score: ADJACENCY_WEIGHT * adjacentPairs + (1 - ADJACENCY_WEIGHT) * positionMatch,
      positionMatch,
      adjacentPairs,
    };
  });
  return rows.sort((a, b) => b.score - a.score);
}

/**
 * First cell of every CSV data record (the header must be `id`), RFC 4180 aware: a quoted cell may
 * hold commas, doubled quotes and line breaks. Tolerates LF as well as CRLF record ends, since a
 * leaked copy may have been re-saved by a spreadsheet.
 */
function csvIds(text: string): string[] {
  const ids: string[] = [];
  let cell = "";
  let quoted = false;
  let firstCellDone = false;
  let recordIndex = 0;
  const endRecord = () => {
    if (recordIndex === 0) {
      if (cell !== "id") throw new TraceError("CSV header does not start with an id column");
    } else if (cell !== "") {
      ids.push(cell);
    }
    recordIndex++;
    cell = "";
    firstCellDone = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        if (!firstCellDone) cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else if (!firstCellDone) {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      firstCellDone = true;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      endRecord();
    } else if (!firstCellDone) {
      cell += ch;
    }
  }
  if (quoted) throw new TraceError("CSV has an unterminated quote");
  if (cell !== "" || firstCellDone) endRecord();
  return ids;
}

/** Ids in file order from a facilities.json array (objects with a string `id`) or a facilities.csv. */
export function parseLeakedText(text: string): string[] {
  const body = text.replace(/^﻿/, "");
  if (body.trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new TraceError("file looks like JSON but does not parse");
    }
    if (!Array.isArray(parsed)) throw new TraceError("JSON file is not an array");
    return parsed.map((row) => {
      const id = (row as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new TraceError("JSON array holds an element without a string id");
      return id;
    });
  }
  return csvIds(body);
}

export function parseLeakedFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new TraceError(`cannot read ${path}`);
  }
  return parseLeakedText(text);
}

type SelectOnlyDb = Pick<ReturnType<typeof getDb>, "select">;

export interface TraceInputs {
  edition: { id: string; editionDate: string };
  baseIds: string[];
  grants: TraceGrant[];
}

/**
 * Everything the trace needs from the outside world. The ONLY database access in this file, typed
 * to `select` so an insert/update/delete cannot be written here without a type error. The edition's
 * base order is read from its stored facilities.json (exactly what that edition served, before
 * watermarking), not recomputed from the live table.
 */
export async function loadTraceInputs(
  db: SelectOnlyDb,
  editionRef: string,
  readEditionText: (pathname: string) => Promise<string | null> = getEditionFileText
): Promise<TraceInputs> {
  const where = UUID_RE.test(editionRef)
    ? eq(datasetEditionsTable.id, editionRef.toLowerCase())
    : DATE_RE.test(editionRef)
      ? eq(datasetEditionsTable.editionDate, editionRef)
      : null;
  if (!where) throw new TraceError("--edition must be a YYYY-MM-DD date or an edition uuid");

  const [edition] = await db
    .select({
      id: datasetEditionsTable.id,
      editionDate: datasetEditionsTable.editionDate,
      status: datasetEditionsTable.status,
      files: datasetEditionsTable.files,
    })
    .from(datasetEditionsTable)
    .where(where)
    .limit(1);
  if (!edition) throw new TraceError(`no edition matches ${editionRef}`);
  if (edition.status !== "published") throw new TraceError(`edition ${edition.editionDate} is not published`);

  const record = edition.files.find((f) => f.name === "facilities.json");
  if (!record) throw new TraceError(`edition ${edition.editionDate} has no facilities.json on record`);
  const text = await readEditionText(record.pathname);
  if (text === null) throw new TraceError(`edition ${edition.editionDate} facilities.json is missing from storage`);
  const baseIds = parseLeakedText(text);

  const grants = await db
    .select({ id: datasetAccessGrantsTable.id, organization: datasetAccessGrantsTable.organization })
    .from(datasetAccessGrantsTable)
    .orderBy(desc(datasetAccessGrantsTable.createdAt));

  return { edition: { id: edition.id, editionDate: edition.editionDate }, baseIds, grants };
}

export function parseArgs(argv: string[]): { file: string; edition: string } {
  let file: string | undefined;
  let edition: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--edition") edition = argv[++i];
    else if (arg.startsWith("--edition=")) edition = arg.slice("--edition=".length);
    else if (arg.startsWith("--")) throw new TraceError(`unknown option ${arg}`);
    else if (file === undefined) file = arg;
    else throw new TraceError("only one file may be given");
  }
  if (!file || !edition) throw new TraceError("usage: dataset:trace <file> --edition <YYYY-MM-DD|uuid>");
  return { file, edition };
}

export function formatTable(rows: GrantScore[]): string {
  const pct = (n: number) => n.toFixed(3);
  const lines = [["grantId", "organization", "score", "positionMatch", "adjacentPairs"].join("\t")];
  for (const r of rows) {
    lines.push([r.grantId, r.organization ?? "(none)", pct(r.score), pct(r.positionMatch), pct(r.adjacentPairs)].join("\t"));
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { file, edition } = parseArgs(process.argv.slice(2));
  const secret = (process.env.DATASET_WATERMARK_SECRET ?? "").trim();
  if (secret.length < MIN_WATERMARK_SECRET_LENGTH) {
    throw new TraceError(`DATASET_WATERMARK_SECRET is missing or shorter than ${MIN_WATERMARK_SECRET_LENGTH} characters`);
  }
  if (!process.env.DATABASE_URL) throw new TraceError("DATABASE_URL is not set");

  const leakedIds = parseLeakedFile(file);
  const inputs = await loadTraceInputs(getDb(), edition);
  const { known, unknown } = splitKnownIds(leakedIds, inputs.baseIds);
  const ranked = scoreGrants(leakedIds, inputs.baseIds, inputs.grants, { secret, editionId: inputs.edition.id });

  console.log(`edition ${inputs.edition.editionDate} (${inputs.edition.id}): ${inputs.baseIds.length} base ids, ${inputs.grants.length} grants`);
  console.log(`leaked file: ${leakedIds.length} ids, ${known.length} matched, ${unknown} not in this edition (ignored)`);
  console.log(`top ${Math.min(TOP_N, ranked.length)} of ${ranked.length}:`);
  console.log(formatTable(ranked.slice(0, TOP_N)));
}

// Only run the CLI when executed directly, not when the test suite imports the scorer.
const isMain = isEntrypoint(import.meta.url);
if (isMain) {
  main().catch((err) => {
    if (err instanceof TraceError) {
      // lint-no-raw-error-logs: allow -- TraceError is built only from fixed text and the operator's own argv/edition date, never from a caught DB error
      console.error(err.message);
    } else {
      console.error(formatFatalError(err));
    }
    process.exit(1);
  });
}

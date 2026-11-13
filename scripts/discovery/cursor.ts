/**
 * Resumable cursor shared by extract-fields.ts and verify-fields.ts (Wave 5
 * item 5.2). Both lanes are bounded by `--limit`; without a cursor every
 * scheduled run takes the same head-of-table N items.
 *
 * BOUNDARY: the cursor is a coverage aid, not a delivery guarantee. The lane
 * tools only READ the cursor file (`--cursor-file`) and REPORT the proposed
 * next value (`nextCursor` in their run summary); the scheduler (run.sh)
 * persists it, via the `--write` CLI below, and only after that lane's
 * downstream step succeeded. A facility the lane could not read waits one full
 * lap (~7 weeks); that is accepted, because nothing wrong is staged and
 * nothing stalls.
 *
 * Facility-granular: `--limit` counts gap/value items, so a facility cut in
 * half by the limit counts as processed and its remaining items wait for the
 * next lap. A value the maintainer rejected can likewise come back once per
 * lap. Order is plain code-unit string order on `facility.id` (never
 * locale-dependent), so it is stable across machines and runs.
 *
 * `--next-cursor-out <path>` (both tools) hands the proposal to run.sh as a
 * file: present only when the run proposes a move, absent otherwise (see
 * `clearNextCursorOut`), so run.sh never parses stdout or promotes a stale value.
 *
 * CLI (for run.sh):  npx tsx scripts/discovery/cursor.ts --write <path> <id>
 * Exits 1 on a malformed id or a failed write; the old file is left intact.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

import { formatErrorSummary } from "../../lib/db-error";
import { isEntrypoint } from "../is-entrypoint";

/** Facility ids are slugs; anything else in a cursor file is corruption. */
export const CURSOR_ID_PATTERN = /^[\w.:-]{1,200}$/;

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable copy of `items` ordered by `getId`. */
export function sortById<T>(items: readonly T[], getId: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareIds(getId(a), getId(b)));
}

/**
 * Rotates id-sorted `items` so those with id > `cursor` come first, then the
 * rest (the wrap). `cursor === undefined` returns the list unchanged, which is
 * what keeps behaviour identical when no cursor file is used.
 */
export function rotateAfterCursor<T>(items: readonly T[], cursor: string | undefined, getId: (item: T) => string): T[] {
  if (cursor === undefined) return [...items];
  const tail = items.filter((item) => compareIds(getId(item), cursor) > 0);
  const head = items.filter((item) => compareIds(getId(item), cursor) <= 0);
  return [...tail, ...head];
}

/**
 * Reads the cursor. Missing or empty file = start of table (undefined). An
 * unreadable or garbage file logs a WARN and also yields undefined: a broken
 * cursor must never crash the lane.
 */
export function readCursor(filePath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.error(`WARN: cursor file ${filePath} unreadable (${formatErrorSummary(err)}); starting from the beginning.`);
    return undefined;
  }
  const value = raw.trim();
  if (value === "") return undefined;
  if (!CURSOR_ID_PATTERN.test(value)) {
    console.error(`WARN: cursor file ${filePath} does not hold a facility id; starting from the beginning.`);
    return undefined;
  }
  return value;
}

/** Atomic (temp file, fsync, rename) so a crash never leaves a torn cursor. */
export function writeCursorAtomic(filePath: string, facilityId: string): void {
  if (!CURSOR_ID_PATTERN.test(facilityId)) {
    throw new Error("refusing to write a cursor that is not a facility id");
  }
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, `${facilityId}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
}

/** One facility as the cursor sees it: its id and its model-call tally. */
export interface ProcessedFacility {
  id: string;
  attempted: number;
  answered: number;
}

/** A trailing run of this many facilities that each made model calls and got no usable answer holds the cursor. */
export const TRAILING_MODEL_UNUSABLE_STREAK = 3;

const modelUnusable = (f: ProcessedFacility): boolean => f.attempted > 0 && f.answered === 0;

/**
 * The id to propose as the next cursor, or null when the cursor must not move.
 * Null when nothing was processed, the run aborted, or the model was unusable
 * for the whole run (calls attempted, none returned a usable answer).
 * If the run ENDS with a streak of at least TRAILING_MODEL_UNUSABLE_STREAK
 * model-unusable facilities, the proposal is the last facility before that
 * streak (null if none), so a model that dies mid-run does not carry the cursor
 * over facilities it never read. Isolated failures earlier in the run do not
 * hold the cursor: a facility that keeps failing waits one lap rather than
 * stalling the sweep. (Not handled, deliberately: directory fsync after the
 * rename, and a 200-char id cap that real ids never reach.)
 */
export function proposeNextCursor(run: { processed: ProcessedFacility[]; aborted: boolean }): string | null {
  const { processed } = run;
  if (processed.length === 0 || run.aborted) return null;
  const attempted = processed.reduce((n, f) => n + f.attempted, 0);
  const answered = processed.reduce((n, f) => n + f.answered, 0);
  if (attempted > 0 && answered === 0) return null;

  let streak = 0;
  while (streak < processed.length && modelUnusable(processed[processed.length - 1 - streak])) streak++;
  // `streak < processed.length` here: an all-unusable run returned null above.
  if (streak >= TRAILING_MODEL_UNUSABLE_STREAK) return processed[processed.length - 1 - streak].id;
  return processed[processed.length - 1].id;
}

/** Final gate applied by each tool's main(): no cursor file or a run with no output file proposes nothing. */
function settleNextCursor(
  proposed: string | null,
  ctx: { cursorFile: string | undefined; producedOutput: boolean }
): string | null {
  return ctx.cursorFile !== undefined && ctx.producedOutput ? proposed : null;
}

/**
 * First thing both main()s do, before parseArgs and any I/O: remove the
 * `--next-cursor-out` file named in the raw argv, so a failure in parseArgs or
 * in loading facilities (a Neon outage) cannot leave the previous run's value
 * for run.sh to promote. A minimal scan, not a parser; handles
 * `--next-cursor-out <p>` and `--next-cursor-out=<p>`.
 */
export function clearNextCursorOutFromArgv(argv: string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    // Same value rule as parsePathFlag: a missing, empty or `--`-prefixed value is not a path.
    if (flag === "--next-cursor-out") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) clearNextCursorOut(value);
    } else if (flag.startsWith("--next-cursor-out=")) {
      const value = flag.slice("--next-cursor-out=".length);
      if (value && !value.startsWith("--")) clearNextCursorOut(value);
    }
  }
}

/** The CLI args both tools' main() hands to the cursor lifecycle below. */
export interface CursorRunArgs {
  facilityId?: string;
  cursorFile?: string;
  nextCursorOut?: string;
  outPath?: string;
}

/** A cursor only makes sense for a table sweep: `--facility` runs ignore it. */
function effectiveCursorFile(args: CursorRunArgs): string | undefined {
  return args.facilityId ? undefined : args.cursorFile;
}

/**
 * Start of run, the first of main()'s two cursor calls. Clears any
 * `--next-cursor-out` file (a crash must leave it absent), then returns the
 * cursor to resume from (undefined = start of table).
 */
export function beginCursorRun(args: CursorRunArgs): { cursor: string | undefined } {
  if (args.nextCursorOut) clearNextCursorOut(args.nextCursorOut);
  const cursorFile = effectiveCursorFile(args);
  return { cursor: cursorFile ? readCursor(cursorFile) : undefined };
}

/**
 * End of run, the second of main()'s two cursor calls. Settles the summary's
 * `nextCursor` (null without a cursor file or without an output file) and
 * mirrors it into `--next-cursor-out`. Mutates `summary.nextCursor` so the
 * printed/written summary reports what the file says.
 */
export function finalizeCursorRun(args: CursorRunArgs, summary: { nextCursor: string | null }): void {
  summary.nextCursor = settleNextCursor(summary.nextCursor, {
    cursorFile: effectiveCursorFile(args),
    producedOutput: Boolean(args.outPath),
  });
  if (args.nextCursorOut) emitNextCursor(args.nextCursorOut, summary.nextCursor);
}

function parsePathFlag(argv: string[], i: number, name: string): { value: string; consumed: number } | undefined {
  const flag = argv[i];
  if (flag === name) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && next !== "") return { value: next, consumed: 1 };
    throw new Error(`${name} requires a path`);
  }
  if (flag.startsWith(`${name}=`)) {
    const value = flag.slice(name.length + 1);
    if (value === "") throw new Error(`${name} requires a path`);
    return { value, consumed: 0 };
  }
  return undefined;
}

/** Parses `--cursor-file <path>` / `--cursor-file=<path>` shared by both CLIs. */
export function parseCursorFileFlag(argv: string[], i: number): { value: string; consumed: number } | undefined {
  return parsePathFlag(argv, i, "--cursor-file");
}

/** Parses `--next-cursor-out <path>` / `--next-cursor-out=<path>` shared by both CLIs. */
export function parseNextCursorOutFlag(argv: string[], i: number): { value: string; consumed: number } | undefined {
  return parsePathFlag(argv, i, "--next-cursor-out");
}

/**
 * `--next-cursor-out` contract: the file exists ONLY when this run proposes a
 * cursor move, and then holds exactly the id plus a newline. Absent means "do
 * not move", so run.sh can never promote a stale value. The tools clear the
 * path before the run (a crash leaves it absent) and call `emitNextCursor`
 * after it.
 */
function clearNextCursorOut(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch (err) {
    console.error(`WARN: could not clear ${filePath} (${formatErrorSummary(err)}).`);
  }
}

function emitNextCursor(filePath: string, nextCursor: string | null): void {
  if (nextCursor === null) {
    clearNextCursorOut(filePath);
    return;
  }
  try {
    writeCursorAtomic(filePath, nextCursor);
  } catch (err) {
    console.error(`WARN: could not write ${filePath} (${formatErrorSummary(err)}); cursor will not move.`);
    clearNextCursorOut(filePath);
  }
}

export function cursorCli(argv: string[]): number {
  const [mode, file, id] = argv;
  if (mode !== "--write" || !file || id === undefined || argv.length !== 3) {
    console.error("usage: cursor.ts --write <path> <facility-id>");
    return 1;
  }
  try {
    writeCursorAtomic(file, id);
    return 0;
  } catch (err) {
    console.error(`cursor write failed: ${formatErrorSummary(err)}`);
    return 1;
  }
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = cursorCli(process.argv.slice(2));
}

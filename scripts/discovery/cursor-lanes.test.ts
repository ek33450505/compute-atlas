import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TRAILING_MODEL_UNUSABLE_STREAK,
  beginCursorRun,
  clearNextCursorOutFromArgv,
  cursorCli,
  finalizeCursorRun,
  proposeNextCursor,
  readCursor,
  rotateAfterCursor,
  writeCursorAtomic,
} from "./cursor";
import {
  CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD,
  parseArgs as parseExtractArgs,
  runExtract,
  type RunExtractDeps,
} from "./extract-fields";
import { parseArgs as parseVerifyArgs, runVerify, type VerifyFieldsDeps } from "./verify-fields";
import type { Facility } from "../../lib/schema";

function makeFacility(
  id: string,
  extra: { lastUpdated?: string; capacityMw?: Facility["capacityMw"] } = {}
): Facility {
  return {
    id,
    name: `Facility ${id}`,
    operator: "Test Operator",
    status: "operational",
    facilityType: "data_center",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, city: "Testville", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [{ url: `https://example.com/${id}`, label: "Press release", retrievedAt: "2026-01-01", kind: "press" }],
    lastUpdated: "2026-01-01",
    ...extra,
  };
}

const ids = ["a", "b", "c", "d", "e"];
// Deliberately unsorted: the lanes must impose id order themselves.
const table = () => ["c", "e", "a", "d", "b"].map((id) => makeFacility(id));

const wayback = (async () =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ archived_snapshots: {} }),
  }) as unknown as Response) as typeof fetch;

/** Every source fetches fine but is too thin to read: reached, never aborts. */
const thinPage = async (url: string) => ({ ok: true as const, text: "short", finalUrl: url, httpStatus: 200 });
const deadPage = async () => ({ ok: false as const, reason: "network_error" as const });

function extractDeps(fetchPage: RunExtractDeps["fetchPageTextImpl"]): RunExtractDeps {
  return {
    fetchPageTextImpl: fetchPage,
    fetchPdfTextImpl: async () => ({ ok: false, reason: "pdf_extractor_unavailable" }),
    callOllamaImpl: async () => {
      throw new Error("model must not be called");
    },
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    sleep: async () => {},
    fetchImpl: wayback,
  };
}

function verifyDeps(fetchPage: VerifyFieldsDeps["fetchPageTextImpl"]): VerifyFieldsDeps {
  return {
    fetchPageTextImpl: fetchPage,
    fetchPdfTextImpl: async () => {
      throw new Error("pdf must not be fetched");
    },
    callOllamaImpl: async () => {
      throw new Error("model must not be called");
    },
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    sleep: async () => {},
    fetchImpl: wayback,
  };
}

let dir: string | undefined;
function tmp(): string {
  dir = mkdtempSync(path.join(tmpdir(), "cursor-lanes-test-"));
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("cursor helpers", () => {
  it("rotates so ids after the cursor come first, then wraps", () => {
    expect(rotateAfterCursor(ids, "b", (x) => x)).toEqual(["c", "d", "e", "a", "b"]);
    expect(rotateAfterCursor(ids, "e", (x) => x)).toEqual(ids);
    expect(rotateAfterCursor(ids, undefined, (x) => x)).toEqual(ids);
  });

  it("treats a missing or empty cursor file as the start of the table, silently", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = tmp();
    expect(readCursor(path.join(d, "none"))).toBeUndefined();
    writeFileSync(path.join(d, "empty"), "  \n");
    expect(readCursor(path.join(d, "empty"))).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and starts from the beginning on a garbage or unreadable cursor file", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = tmp();
    writeFileSync(path.join(d, "garbage"), "{\"not\": \"an id\"}\nline two");
    expect(readCursor(path.join(d, "garbage"))).toBeUndefined();
    mkdirSync(path.join(d, "isdir"));
    expect(readCursor(path.join(d, "isdir"))).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain("WARN");
  });

  it("writes atomically (no temp file left behind) and round-trips", () => {
    const d = tmp();
    const file = path.join(d, "sub", "cursor");
    writeCursorAtomic(file, "fac-1");
    expect(readCursor(file)).toBe("fac-1");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("parses --cursor-file in both CLIs and leaves it unset otherwise", () => {
    expect(parseExtractArgs(["--fields=water.coolingType", "--cursor-file", "/x/c"]).cursorFile).toBe("/x/c");
    expect(parseExtractArgs(["--fields=water.coolingType", "--cursor-file=/x/c"]).cursorFile).toBe("/x/c");
    expect(parseExtractArgs(["--fields=water.coolingType"]).cursorFile).toBeUndefined();
    expect(parseVerifyArgs(["--cursor-file=/x/c"]).cursorFile).toBe("/x/c");
    expect(parseVerifyArgs([]).cursorFile).toBeUndefined();
    expect(() => parseExtractArgs(["--fields=water.coolingType", "--cursor-file"])).toThrow(/requires a path/);
  });

  const ok = (id: string) => ({ id, attempted: 1, answered: 1 });
  const bad = (id: string) => ({ id, attempted: 1, answered: 0 });
  const none = (id: string) => ({ id, attempted: 0, answered: 0 });

  it("proposes nothing for an abort, a wholly unusable model, or an empty run", () => {
    expect(proposeNextCursor({ processed: [ok("a"), ok("d")], aborted: false })).toBe("d");
    expect(proposeNextCursor({ processed: [ok("a"), ok("d")], aborted: true })).toBeNull();
    expect(proposeNextCursor({ processed: [bad("a"), bad("d")], aborted: false })).toBeNull();
    expect(proposeNextCursor({ processed: [none("a"), none("d")], aborted: false })).toBe("d");
    expect(proposeNextCursor({ processed: [], aborted: false })).toBeNull();
  });

  it(`holds the cursor before a trailing streak of ${TRAILING_MODEL_UNUSABLE_STREAK} model-unusable facilities`, () => {
    const streak = Array.from({ length: TRAILING_MODEL_UNUSABLE_STREAK }, (_, i) => bad(`x${i}`));
    expect(proposeNextCursor({ processed: [ok("a"), ok("b"), ...streak], aborted: false })).toBe("b");
    // A facility that needed no model call inside the streak breaks it.
    expect(proposeNextCursor({ processed: [ok("a"), bad("x0"), none("n"), bad("x1"), bad("x2")], aborted: false })).toBe("x2");
  });

  it("does not hold the cursor for isolated or short trailing failures", () => {
    const short = Array.from({ length: TRAILING_MODEL_UNUSABLE_STREAK - 1 }, (_, i) => bad(`x${i}`));
    expect(proposeNextCursor({ processed: [ok("a"), ...short], aborted: false })).toBe(`x${short.length - 1}`);
    expect(proposeNextCursor({ processed: [ok("a"), bad("b"), ok("c"), bad("d"), ok("e")], aborted: false })).toBe("e");
  });

  it("still requires --fields for extract-fields when --cursor-file is given", () => {
    expect(() => parseExtractArgs(["--cursor-file=/x/c"])).toThrow(/--fields is required/);
  });
});

/** What run.sh does after the lane's downstream step succeeded. */
function persist(file: string, summary: { nextCursor: string | null }): void {
  if (summary.nextCursor !== null) writeCursorAtomic(file, summary.nextCursor);
}

const cursorOf = (file: string) => readFileSync(file, "utf8").trim();

async function extractRun(file: string, limit: number, deps: RunExtractDeps) {
  const summary = await runExtract(
    table(),
    { fields: ["water.coolingType"], limit, runId: "t", cursor: readCursor(file) },
    deps
  );
  persist(file, summary);
  return summary;
}

const wellFormedPage = (url: string) => ({
  ok: true as const,
  // Readable and mentions cooling so the prefilter passes and the model is asked.
  text: `Facility uses closed-loop water cooling. ${"Filler sentence about the site. ".repeat(20)}`,
  finalUrl: url,
  httpStatus: 200,
});

/** Model answers (null value, still a usable answer) only for prompts `answerFor` accepts. */
function modelDeps(answerFor: (prompt: string) => boolean): RunExtractDeps {
  return {
    ...extractDeps(async (url) => wellFormedPage(url)),
    callOllamaImpl: async (opts) =>
      answerFor(opts.userPrompt)
        ? { ok: true, data: { value: null, verbatimQuote: null, reasonIfNull: "not stated" } }
        : ({ ok: false, reason: "network_error" } as never),
  };
}

describe("extract-fields nextCursor", () => {
  it("advances across runs and wraps, always doing up to `limit` items", async () => {
    const file = path.join(tmp(), "cursor");
    const deps = extractDeps(thinPage);

    const r1 = await extractRun(file, 2, deps);
    expect(r1.gapsConsidered).toBe(2);
    expect(r1.nextCursor).toBe("b");
    expect(cursorOf(file)).toBe("b");

    expect((await extractRun(file, 2, deps)).nextCursor).toBe("d");

    // Tail has only "e": the run wraps to "a" so it still does `limit` items.
    const r3 = await extractRun(file, 2, deps);
    expect(r3.gapsConsidered).toBe(2);
    expect(cursorOf(file)).toBe("a");
  });

  it("is the last processed facility even when some facilities failed to fetch or answer mid-run", async () => {
    const fetchDeadForBC = async (url: string) =>
      url.endsWith("/b") || url.endsWith("/c") ? { ok: false as const, reason: "network_error" as const } : wellFormedPage(url);
    const summary = await runExtract(
      table(),
      { fields: ["water.coolingType"], runId: "t" },
      { ...modelDeps((p) => !p.includes("Facility d")), fetchPageTextImpl: fetchDeadForBC }
    );
    expect(summary.fetchFailures).toBe(2);
    expect(summary.modelUnavailable).toBe(1);
    expect(summary.nextCursor).toBe("e");
  });

  it("a persistent model failure on facility k does not stop it moving past k", async () => {
    const summary = await runExtract(
      table(),
      { fields: ["water.coolingType"], runId: "t" },
      modelDeps((p) => !p.includes("Facility c"))
    );
    expect(summary.nextCursor).toBe("e");
  });

  it("is null when every model call failed (outage), even though facilities were processed", async () => {
    const summary = await runExtract(
      table(),
      { fields: ["water.coolingType"], limit: 3, runId: "t" },
      modelDeps(() => false)
    );
    expect(summary.modelUnavailable).toBe(3);
    expect(summary.nextCursor).toBeNull();
  });

  it("holds at the last good facility when the model dies mid-run (trailing streak)", async () => {
    // a and b answer; c, d, e all get no usable answer.
    const summary = await runExtract(
      table(),
      { fields: ["water.coolingType"], runId: "t" },
      modelDeps((p) => p.includes("Facility a") || p.includes("Facility b"))
    );
    expect(summary.modelUnavailable).toBe(3);
    expect(summary.nextCursor).toBe("b");
  });

  it("a run that needed no model call (all pages thin) still proposes its last facility", async () => {
    const summary = await runExtract(table(), { fields: ["water.coolingType"], limit: 2, runId: "t" }, extractDeps(thinPage));
    expect(summary.nextCursor).toBe("b");
  });

  it("is null on abort, and the tool never touches the cursor file", async () => {
    const file = path.join(tmp(), "cursor");
    writeCursorAtomic(file, "a");
    const before = readFileSync(file, "utf8");
    const many = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD + 2 }, (_, i) =>
      makeFacility(`z${String(i).padStart(3, "0")}`)
    );
    const summary = await runExtract(
      many,
      { fields: ["water.coolingType"], runId: "t", cursor: readCursor(file) },
      extractDeps(deadPage)
    );
    expect(summary.aborted).toBe(true);
    expect(summary.nextCursor).toBeNull();
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("starts from the beginning and warns on a garbage cursor file", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = path.join(tmp(), "cursor");
    writeFileSync(file, "###\nnot an id");
    const summary = await extractRun(file, 2, extractDeps(thinPage));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WARN"));
    expect(summary.nextCursor).toBe("b");
  });

  it("without a cursor, takes the id-sorted head every time (order is deterministic)", async () => {
    const run = () =>
      runExtract(table(), { fields: ["water.coolingType"], limit: 2, runId: "t" }, extractDeps(thinPage));
    expect((await run()).nextCursor).toBe("b");
    expect((await run()).nextCursor).toBe("b");
  });

  it("a cursor id that no longer exists continues from the next id", async () => {
    const summary = await runExtract(
      table(),
      { fields: ["water.coolingType"], limit: 2, runId: "t", cursor: "bb" },
      extractDeps(thinPage)
    );
    expect(summary.nextCursor).toBe("d"); // c, d
  });
});

describe("verify-fields nextCursor", () => {
  const withValue = (id: string) => makeFacility(id, { capacityMw: { operational: 100 } });
  const verifyTable = () => ["c", "e", "a", "d", "b"].map(withValue);
  const page = (url: string) => ({
    ok: true as const,
    text: `The facility has an operational capacity of 100 MW. ${"Filler sentence about the site. ".repeat(20)}`,
    finalUrl: url,
    httpStatus: 200,
  });
  const modelUp = (good: (prompt: string) => boolean): VerifyFieldsDeps => ({
    ...verifyDeps(async (url) => page(url)),
    callOllamaImpl: async (opts) =>
      good(opts.userPrompt)
        ? { ok: true, data: { value: 100, verbatimQuote: "operational capacity of 100 MW", reasonIfNull: null } }
        : ({ ok: false, reason: "network_error" } as never),
  });

  async function verifyRun(file: string, limit: number) {
    const summary = await runVerify(
      verifyTable(),
      { fields: ["capacityMw.operational"], limit, runId: "t", cursor: readCursor(file) },
      verifyDeps(thinPage)
    );
    persist(file, summary);
    return summary;
  }

  it("advances across runs and wraps", async () => {
    const file = path.join(tmp(), "cursor");
    await verifyRun(file, 2);
    expect(cursorOf(file)).toBe("b");
    await verifyRun(file, 2);
    expect(cursorOf(file)).toBe("d");
    const r3 = await verifyRun(file, 2);
    expect(r3.valuesConsidered).toBe(2);
    expect(cursorOf(file)).toBe("a");
  });

  it("is null on abort and leaves the cursor file untouched", async () => {
    const file = path.join(tmp(), "cursor");
    writeCursorAtomic(file, "a");
    const many = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD + 2 }, (_, i) =>
      withValue(`z${String(i).padStart(3, "0")}`)
    );
    const summary = await runVerify(
      many,
      { fields: ["capacityMw.operational"], runId: "t", cursor: readCursor(file) },
      verifyDeps(deadPage)
    );
    expect(summary.aborted).toBe(true);
    expect(summary.nextCursor).toBeNull();
    expect(cursorOf(file)).toBe("a");
  });

  it("is null when every model call failed, and the last processed facility when only some did", async () => {
    const facilities = ["a", "b", "c"].map(withValue);
    const opts = { fields: ["capacityMw.operational" as const], runId: "t" };
    expect((await runVerify(facilities, opts, modelUp(() => false))).nextCursor).toBeNull();
    expect((await runVerify(facilities, opts, modelUp((p) => p.includes("Facility a")))).nextCursor).toBe("c");
  });
});

describe("cursor CLI (run.sh entry)", () => {
  it("writes the id atomically and round-trips through readCursor", () => {
    const file = path.join(tmp(), "state", "cursor");
    expect(cursorCli(["--write", file, "fac-9"])).toBe(0);
    expect(readCursor(file)).toBe("fac-9");
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("refuses a malformed id or bad usage with exit 1 and leaves the old file intact", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const file = path.join(tmp(), "cursor");
    writeCursorAtomic(file, "keep");
    expect(cursorCli(["--write", file, "bad id; rm -rf"])).toBe(1);
    expect(cursorCli(["--write", file, ""])).toBe(1);
    expect(cursorCli(["--write", file, "../x/y z"])).toBe(1);
    expect(cursorCli(["--write", file])).toBe(1);
    expect(cursorCli(["--read", file, "x"])).toBe(1);
    expect(cursorCli(["--write", file, "a", "extra"])).toBe(1);
    expect(cursorOf(file)).toBe("keep");
  });
});

/** Drives the real lifecycle main() calls: beginCursorRun, then finalizeCursorRun. */
function lifecycle(
  args: { cursorFile?: string; nextCursorOut?: string; outPath?: string; facilityId?: string },
  summary: { nextCursor: string | null }
) {
  const begun = beginCursorRun(args);
  finalizeCursorRun(args, summary);
  return begun;
}

describe("cursor lifecycle (the code main() calls)", () => {
  it("settles nextCursor: null without a cursor file, without an output file, or for --facility runs", () => {
    const base = { cursorFile: "/x/c", outPath: "/x/o" };
    const run = (args: Parameters<typeof lifecycle>[0]) => {
      const summary = { nextCursor: "d" as string | null };
      lifecycle(args, summary);
      return summary.nextCursor;
    };
    expect(run(base)).toBe("d");
    expect(run({ ...base, outPath: undefined })).toBeNull();
    expect(run({ outPath: "/x/o" })).toBeNull();
    expect(run({ ...base, facilityId: "a" })).toBeNull();
  });

  it("reads the cursor to resume from, and ignores it for --facility", () => {
    const file = path.join(tmp(), "cursor");
    writeCursorAtomic(file, "c");
    expect(beginCursorRun({ cursorFile: file }).cursor).toBe("c");
    expect(beginCursorRun({ cursorFile: file, facilityId: "a" }).cursor).toBeUndefined();
    expect(beginCursorRun({}).cursor).toBeUndefined();
  });

  it("neither phase ever writes the cursor file itself", () => {
    const d = tmp();
    const cursorFile = path.join(d, "cursor");
    writeCursorAtomic(cursorFile, "a");
    lifecycle({ cursorFile, outPath: "/x/o", nextCursorOut: path.join(d, "next") }, { nextCursor: "d" });
    expect(cursorOf(cursorFile)).toBe("a");
  });

  it("clears --next-cursor-out from raw argv, so a parseArgs or loader failure cannot leave a stale file", () => {
    const d = tmp();
    const a = path.join(d, "a");
    const b = path.join(d, "b");
    writeFileSync(a, "old\n");
    writeFileSync(b, "old\n");
    // No --fields: extract-fields' parseArgs throws on this argv, after the clear.
    const argv = ["--next-cursor-out", a, `--next-cursor-out=${b}`];
    clearNextCursorOutFromArgv(argv);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(() => parseExtractArgs(argv)).toThrow(/--fields is required/);
    clearNextCursorOutFromArgv(["--next-cursor-out"]); // dangling flag: no throw
    clearNextCursorOutFromArgv(["--next-cursor-out="]);
  });

  it("never treats another flag as the --next-cursor-out path", () => {
    const d = tmp();
    const victim = path.join(d, "--limit");
    writeFileSync(victim, "keep\n");
    const cwd = process.cwd();
    process.chdir(d);
    try {
      clearNextCursorOutFromArgv(["--next-cursor-out", "--limit"]);
      clearNextCursorOutFromArgv(["--next-cursor-out=--limit"]);
      clearNextCursorOutFromArgv(["--next-cursor-out", "--limit", "5"]);
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(victim)).toBe(true);
  });

  // Tripwire, not a behavioural test: no test runs main() (it needs the
  // facilities loader). It pins the call structure so removing a cursor call,
  // dropping `cursor` from the options, or reordering them fails loudly.
  it.each([
    ["extract-fields.ts", "runExtract"],
    ["verify-fields.ts", "runVerify"],
  ])("%s main() keeps its cursor wiring", (file, runFn) => {
    const src = ts.createSourceFile(file, readFileSync(path.join(__dirname, file), "utf8"), ts.ScriptTarget.Latest, true);
    let main: ts.FunctionDeclaration | undefined;
    src.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "main") main = node;
    });
    expect(main, `${file} has a main()`).toBeDefined();

    const calls = new Map<string, ts.CallExpression>();
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && !calls.has(n.expression.text)) {
        calls.set(n.expression.text, n);
      }
      n.forEachChild(visit);
    };
    visit(main!);

    // First statement: the raw-argv clear, before parseArgs and any I/O.
    const first = main!.body!.statements[0];
    expect(first.getText(src)).toContain("clearNextCursorOutFromArgv(");

    const begin = calls.get("beginCursorRun");
    const run = calls.get(runFn);
    const finalize = calls.get("finalizeCursorRun");
    expect(begin, `${file} main() must call beginCursorRun`).toBeDefined();
    expect(run, `${file} main() must call ${runFn}`).toBeDefined();
    expect(finalize, `${file} main() must call finalizeCursorRun`).toBeDefined();
    expect(begin!.pos < run!.pos, "beginCursorRun precedes the run").toBe(true);
    expect(finalize!.pos > run!.pos, "finalizeCursorRun follows the run").toBe(true);

    const options = run!.arguments[1];
    expect(options && ts.isObjectLiteralExpression(options), "run options is an object literal").toBe(true);
    const cursorProp = (options as ts.ObjectLiteralExpression).properties.find((p) => p.name?.getText(src) === "cursor");
    expect(cursorProp, `${file} main() must pass cursor to ${runFn}`).toBeDefined();
    // The value must be the `cursor` bound from `const { cursor } = beginCursorRun(...)`.
    const valueIsCursorIdentifier =
      ts.isShorthandPropertyAssignment(cursorProp!) ||
      (ts.isPropertyAssignment(cursorProp!) &&
        ts.isIdentifier(cursorProp.initializer) &&
        cursorProp.initializer.text === "cursor");
    expect(valueIsCursorIdentifier, `${file}: the cursor option must be the identifier \`cursor\``).toBe(true);
    let boundFromBegin = false;
    const findBinding = (n: ts.Node): void => {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer === begin &&
        ts.isObjectBindingPattern(n.name) &&
        n.name.elements.some((e) => e.name.getText(src) === "cursor" && !e.propertyName)
      ) {
        boundFromBegin = true;
      }
      n.forEachChild(findBinding);
    };
    findBinding(main!);
    expect(boundFromBegin, `${file}: \`cursor\` must be destructured from beginCursorRun(...)`).toBe(true);
  });
});

describe("--next-cursor-out", () => {
  it("parses in both CLIs and is unset otherwise", () => {
    expect(parseExtractArgs(["--fields=water.coolingType", "--next-cursor-out", "/x/n"]).nextCursorOut).toBe("/x/n");
    expect(parseExtractArgs(["--fields=water.coolingType", "--next-cursor-out=/x/n"]).nextCursorOut).toBe("/x/n");
    expect(parseExtractArgs(["--fields=water.coolingType"]).nextCursorOut).toBeUndefined();
    expect(parseVerifyArgs(["--next-cursor-out=/x/n"]).nextCursorOut).toBe("/x/n");
    expect(parseVerifyArgs([]).nextCursorOut).toBeUndefined();
    expect(() => parseVerifyArgs(["--next-cursor-out"])).toThrow(/requires a path/);
  });

  it("holds exactly the id plus a newline on a normal run", async () => {
    const out = path.join(tmp(), "next");
    const summary = await runExtract(table(), { fields: ["water.coolingType"], limit: 2, runId: "t" }, extractDeps(thinPage));
    lifecycle({ cursorFile: "/x/c", outPath: "/x/o", nextCursorOut: out }, summary);
    expect(readFileSync(out, "utf8")).toBe("b\n");
    expect(existsSync(`${out}.tmp`)).toBe(false);
  });

  it("is absent on abort, on an all-model-failed run and on a dry run", async () => {
    const d = tmp();
    const many = Array.from({ length: CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD + 2 }, (_, i) =>
      makeFacility(`z${String(i).padStart(3, "0")}`)
    );
    const aborted = await runExtract(many, { fields: ["water.coolingType"], runId: "t" }, extractDeps(deadPage));
    const outage = await runExtract(table(), { fields: ["water.coolingType"], runId: "t" }, modelDeps(() => false));
    const normal = await runExtract(table(), { fields: ["water.coolingType"], limit: 2, runId: "t" }, extractDeps(thinPage));

    for (const [name, summary, producedOutput] of [
      ["abort", aborted, true],
      ["outage", outage, true],
      ["dry", normal, false],
    ] as const) {
      const out = path.join(d, name);
      writeFileSync(out, "yesterday\n");
      lifecycle({ cursorFile: "/x/c", outPath: producedOutput ? "/x/o" : undefined, nextCursorOut: out }, summary);
      expect(existsSync(out), name).toBe(false);
    }
  });

  it("removes a stale file from a previous run when this run proposes nothing", () => {
    const out = path.join(tmp(), "next");
    writeFileSync(out, "yesterday\n");
    lifecycle({ cursorFile: "/x/c", outPath: "/x/o", nextCursorOut: out }, { nextCursor: null });
    expect(existsSync(out)).toBe(false);
  });

  it("replaces a stale file with this run's value", () => {
    const out = path.join(tmp(), "next");
    writeFileSync(out, "yesterday\n");
    lifecycle({ cursorFile: "/x/c", outPath: "/x/o", nextCursorOut: out }, { nextCursor: "today" });
    expect(readFileSync(out, "utf8")).toBe("today\n");
  });

  it("never writes an id that fails validation, and clears any stale file", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = path.join(tmp(), "next");
    writeFileSync(out, "yesterday\n");
    lifecycle({ cursorFile: "/x/c", outPath: "/x/o", nextCursorOut: out }, { nextCursor: "bad id" });
    expect(existsSync(out)).toBe(false);
  });
});

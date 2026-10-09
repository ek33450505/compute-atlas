// @vitest-environment node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEDGER_RELATIVE_PATH, parseArgs, run } from "./update-nhd-debt";

// The workflows (neon-sync.yml, nhd-backfill.yml) parse this script's stdout
// with `^[0-9]+$` and rely on it writing the ledger only when the count moves,
// so those two contracts are pinned here against a temp tree, never data/.

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");

// Two CONUS facilities lacking nearestWater (a, d) = debt 2. The rest are
// deliberately NOT debt: b has nearestWater, c is non-CONUS, "orphan" has no
// facility.
const FACILITIES = [
  { id: "a", location: { state: "TX" } },
  { id: "b", location: { state: "OH" } },
  { id: "c", location: { state: "HI" } },
  { id: "d", location: { state: "VA" } },
];
const SITING = {
  a: {},
  b: { nearestWater: { name: "Ohio River" } },
  c: {},
  d: {},
  orphan: {},
};
const DEBT = 2;

const TODAY = "2031-01-02";
// An mtime nothing else will produce, so an untouched file is distinguishable
// from one rewritten with identical bytes.
const OLD_MTIME = new Date("2020-01-01T00:00:00Z");

function ledgerText(ceiling: number, asOf: string, note: string): string {
  return `{\n  "ceiling": ${ceiling},\n  "asOf": "${asOf}",\n  "note": "${note}"\n}\n`;
}

function makeTree(): string {
  // realpath: macOS tmpdir is a symlink, and the CLI's isMain guard compares
  // against the resolved script path.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "update-nhd-debt-")));
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(root, "data/facilities.json"), JSON.stringify(FACILITIES));
  writeFileSync(path.join(root, "data/siting-context.json"), JSON.stringify(SITING));
  return root;
}

function writeLedger(root: string, text: string): string {
  const file = path.join(root, LEDGER_RELATIVE_PATH);
  writeFileSync(file, text);
  utimesSync(file, OLD_MTIME, OLD_MTIME);
  return file;
}

let root: string;

beforeEach(() => {
  root = makeTree();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("defaults to a write run with no note", () => {
    expect(parseArgs([])).toEqual({ countOnly: false });
  });

  it("reads --count", () => {
    expect(parseArgs(["--count"])).toEqual({ countOnly: true });
  });

  it("reads --note in both the spaced and = forms", () => {
    expect(parseArgs(["--note", "why"])).toEqual({ countOnly: false, note: "why" });
    expect(parseArgs(["--note=why"])).toEqual({ countOnly: false, note: "why" });
  });

  it("keeps a note that contains '=' intact", () => {
    expect(parseArgs(["--note=a=b"]).note).toBe("a=b");
  });

  it("rejects --note with no value", () => {
    expect(() => parseArgs(["--note"])).toThrow("--note requires a value");
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown argument: --bogus");
  });

  it("rejects --count combined with --note in either form and either order", () => {
    expect(() => parseArgs(["--count", "--note", "x"])).toThrow("--count writes nothing");
    expect(() => parseArgs(["--note", "x", "--count"])).toThrow("--count writes nothing");
    expect(() => parseArgs(["--count", "--note=x"])).toThrow("--count writes nothing");
  });
});

describe("run --count", () => {
  it("prints the integer and nothing else on stdout", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--count"], root, TODAY);
    expect(log.mock.calls).toEqual([[String(DEBT)]]);
  });

  it("writes nothing, even when the recorded ceiling differs", () => {
    const file = writeLedger(root, ledgerText(7, "2026-01-01", "old"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--count"], root, TODAY);
    expect(readFileSync(file, "utf8")).toBe(ledgerText(7, "2026-01-01", "old"));
    expect(statSync(file).mtimeMs).toBe(OLD_MTIME.getTime());
  });

  it("does not create a missing ledger", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--count"], root, TODAY);
    expect(() => statSync(path.join(root, LEDGER_RELATIVE_PATH))).toThrow(/ENOENT/);
  });
});

describe("run --note / default write", () => {
  it("rewrites the ledger when the count moved: 2-space JSON, trailing newline, injected UTC date", () => {
    const file = writeLedger(root, ledgerText(7, "2026-01-01", "old"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--note", "paid down"], root, TODAY);
    expect(readFileSync(file, "utf8")).toBe(ledgerText(DEBT, TODAY, "paid down"));
  });

  it("uses the default note when none is given", () => {
    const file = writeLedger(root, ledgerText(7, "2026-01-01", "old"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    run([], root, TODAY);
    expect(readFileSync(file, "utf8")).toBe(ledgerText(DEBT, TODAY, "Updated by scripts/update-nhd-debt.ts"));
  });

  it("writes nothing when the count is unchanged, regardless of --note", () => {
    const file = writeLedger(root, ledgerText(DEBT, "2026-01-01", "old"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--note", "would churn asOf"], root, TODAY);
    expect(readFileSync(file, "utf8")).toBe(ledgerText(DEBT, "2026-01-01", "old"));
    expect(statSync(file).mtimeMs).toBe(OLD_MTIME.getTime());
  });

  it("creates the ledger when it does not exist yet", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    run(["--note", "first"], root, TODAY);
    expect(readFileSync(path.join(root, LEDGER_RELATIVE_PATH), "utf8")).toBe(ledgerText(DEBT, TODAY, "first"));
  });

  it.each([
    ["not JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a string ceiling", '{"ceiling":"2","asOf":"2026-01-01","note":"x"}'],
    ["a negative ceiling", '{"ceiling":-1,"asOf":"2026-01-01","note":"x"}'],
    ["a fractional ceiling", '{"ceiling":1.5,"asOf":"2026-01-01","note":"x"}'],
    ["no ceiling", '{"asOf":"2026-01-01","note":"x"}'],
  ])("reports a malformed ledger (%s) and leaves the file untouched", (_label, text) => {
    const file = writeLedger(root, text);
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => run(["--note", "x"], root, TODAY)).toThrow(/malformed|not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(statSync(file).mtimeMs).toBe(OLD_MTIME.getTime());
  });
});

describe("run input validation", () => {
  it("throws when a data file is missing", () => {
    rmSync(path.join(root, "data/facilities.json"));
    expect(() => run(["--count"], root, TODAY)).toThrow("cannot read data/facilities.json");
  });

  it("throws when a data file is not JSON", () => {
    writeFileSync(path.join(root, "data/siting-context.json"), "{nope");
    expect(() => run(["--count"], root, TODAY)).toThrow("data/siting-context.json");
  });

  it("throws when facilities.json is not an array", () => {
    writeFileSync(path.join(root, "data/facilities.json"), "{}");
    expect(() => run(["--count"], root, TODAY)).toThrow("data/facilities.json is not a JSON array");
  });

  it("throws when siting-context.json is an array rather than an id-keyed object", () => {
    writeFileSync(path.join(root, "data/siting-context.json"), "[]");
    expect(() => run(["--count"], root, TODAY)).toThrow("not a JSON object keyed by facility id");
  });
});

// The real thing the workflows invoke: `npx tsx scripts/update-nhd-debt.ts`.
// run() is pointed at a temp dir in-process above; here the CLI entry itself
// (the isMain guard, the real stdout, the exit code) is exercised from a copy
// of the script, its entrypoint helper and its one lib import placed next to the fixture data.
describe("CLI process", () => {
  function execCli(args: string[]) {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "lib"));
    copyFileSync(path.join(SCRIPTS_DIR, "update-nhd-debt.ts"), path.join(root, "scripts/update-nhd-debt.ts"));
    copyFileSync(path.join(SCRIPTS_DIR, "is-entrypoint.ts"), path.join(root, "scripts/is-entrypoint.ts"));
    copyFileSync(path.join(REPO_ROOT, "lib/nhd-debt.ts"), path.join(root, "lib/nhd-debt.ts"));
    return spawnSync(
      path.join(REPO_ROOT, "node_modules/.bin/tsx"),
      [path.join(root, "scripts/update-nhd-debt.ts"), ...args],
      { cwd: root, encoding: "utf8" },
    );
  }

  it("--count prints exactly '<n>\\n' on stdout, matching the workflows' ^[0-9]+$ parse", () => {
    const result = execCli(["--count"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${DEBT}\n`);
    expect(result.stderr).toBe("");
  });

  it("--count combined with --note exits 1 with the reason on stderr and nothing on stdout", () => {
    const result = execCli(["--count", "--note", "x"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--count writes nothing");
  });

  it("an unknown flag exits 1 with the reason on stderr and nothing on stdout", () => {
    const result = execCli(["--bogus"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("unknown argument: --bogus\n");
  });

  it("a malformed ledger exits 1 and is left untouched", () => {
    const file = writeLedger(root, "{not json");
    const result = execCli(["--note", "x"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid JSON");
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("a write run stamps today's UTC date from the real clock", () => {
    const file = writeLedger(root, ledgerText(7, "2026-01-01", "old"));
    // Bracketed by the date before and after the spawn so a run straddling UTC
    // midnight cannot flake.
    const before = new Date().toISOString().slice(0, 10);
    const result = execCli(["--note", "end to end"]);
    const after = new Date().toISOString().slice(0, 10);
    expect(result.status).toBe(0);
    const written = JSON.parse(readFileSync(file, "utf8")) as { ceiling: number; asOf: string; note: string };
    expect(written.ceiling).toBe(DEBT);
    expect(written.note).toBe("end to end");
    expect([before, after]).toContain(written.asOf);
  });
});

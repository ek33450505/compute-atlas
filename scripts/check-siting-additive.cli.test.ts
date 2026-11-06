import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Process-level contract of the entrypoint, run as a real node subprocess. The
// verdicts (0/1) are asserted in-process in check-siting-additive.test.ts with
// injected readers; here only the paths that must exit 2 BEFORE any Neon read
// are reachable without a database. Codes are literal on purpose.

const SCRIPT_SRC = resolve(__dirname, "check-siting-additive.mjs");

describe("check-siting-additive CLI exit codes — real subprocess", () => {
  let dir: string;

  function setup(files: Record<string, string>): void {
    // The script derives REPO_ROOT from its own location.
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "data"));
    copyFileSync(SCRIPT_SRC, join(dir, "scripts", "check-siting-additive.mjs"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "data", name), text);
  }

  function run() {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    return spawnSync(process.execPath, [join(dir, "scripts", "check-siting-additive.mjs")], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siting-additive-cli-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 when siting-context.next.json is missing", () => {
    setup({ "facilities.json": JSON.stringify([{ id: "a" }]) });
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GUARD ERROR");
    expect(result.stdout + result.stderr).not.toContain("DATA LOSS");
  });

  it("exits 2 when facilities.json is an empty array", () => {
    setup({ "siting-context.next.json": "{}", "facilities.json": "[]" });
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("DATA LOSS");
  });

  it("exits 2 naming DATABASE_URL when there is no database to compare against", () => {
    setup({ "siting-context.next.json": "{}", "facilities.json": JSON.stringify([{ id: "a" }]) });
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("DATABASE_URL");
  });
});

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CLI exit-code contract, run as a real node subprocess against a real git repo.
// check-siting-additive.test.ts vi.mock()s node:child_process for the whole
// file, so the process-level contract (0 additive / 1 data loss / 2 could not
// evaluate) has to be asserted here. Codes are literal on purpose: importing the
// script's own constants would make the assertion unable to fail.

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;

const SCRIPT_SRC = resolve(__dirname, "check-siting-additive.mjs");

const BASELINE_SITING = JSON.stringify({ a: { nearestWater: { name: "River A" } } });
const FACILITIES = JSON.stringify([{ id: "a" }]);

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
}

describe("check-siting-additive CLI exit codes — real git, real subprocess", () => {
  let repoDir: string;

  // Commits the baseline, then each case overwrites working-tree files.
  function setup(baselineSiting: string): void {
    // The script derives REPO_ROOT from its own location, so the fixture repo
    // carries its own copy at <repo>/scripts/.
    mkdirSync(join(repoDir, "scripts"));
    mkdirSync(join(repoDir, "data"));
    copyFileSync(SCRIPT_SRC, join(repoDir, "scripts", "check-siting-additive.mjs"));
    writeFileSync(join(repoDir, "data", "siting-context.json"), baselineSiting);
    writeFileSync(join(repoDir, "data", "facilities.json"), FACILITIES);
    git(repoDir, "init", "-q");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "Test");
    git(repoDir, "add", "data");
    git(repoDir, "commit", "-q", "-m", "baseline");
  }

  function run() {
    return spawnSync(process.execPath, [join(repoDir, "scripts", "check-siting-additive.mjs")], {
      cwd: repoDir,
      env: { ...GIT_ENV, SITING_BASELINE_NO_FETCH: "1", SITING_BASELINE_REF: "HEAD" },
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "siting-additive-cli-test-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("exits 0 when the working tree is additive", () => {
    setup(BASELINE_SITING);
    writeFileSync(
      join(repoDir, "data", "siting-context.json"),
      JSON.stringify({ a: { nearestWater: { name: "River A" } }, b: {} }),
    );
    const result = run();
    expect(result.status).toBe(0);
  });

  it("exits 1 with DATA LOSS DETECTED when a field is dropped for a live facility", () => {
    setup(BASELINE_SITING);
    writeFileSync(join(repoDir, "data", "siting-context.json"), JSON.stringify({ a: {} }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATA LOSS DETECTED");
  });

  it("exits 2 (GUARD ERROR, not a verdict) when the committed baseline blob is unparseable", () => {
    setup("{not json");
    writeFileSync(join(repoDir, "data", "siting-context.json"), BASELINE_SITING);
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GUARD ERROR");
    expect(result.stdout + result.stderr).not.toContain("DATA LOSS");
  });

  it("exits 0 and reports 'path absent' when HEAD has no siting-context.json (first run preserved)", () => {
    mkdirSync(join(repoDir, "scripts"));
    mkdirSync(join(repoDir, "data"));
    copyFileSync(SCRIPT_SRC, join(repoDir, "scripts", "check-siting-additive.mjs"));
    writeFileSync(join(repoDir, "data", "facilities.json"), FACILITIES);
    git(repoDir, "init", "-q");
    git(repoDir, "config", "user.email", "test@example.com");
    git(repoDir, "config", "user.name", "Test");
    git(repoDir, "add", "data");
    git(repoDir, "commit", "-q", "-m", "baseline without siting");
    writeFileSync(join(repoDir, "data", "siting-context.json"), BASELINE_SITING);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("path absent");
  });

  it("exits 2, not a green skip, when the baseline blob's git object is corrupt (git show -> 128)", () => {
    setup(BASELINE_SITING);
    const sha = execFileSync("git", ["rev-parse", "HEAD:data/siting-context.json"], {
      cwd: repoDir,
      env: GIT_ENV,
      encoding: "utf8",
    }).trim();
    const objPath = join(repoDir, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    expect(existsSync(objPath)).toBe(true);
    rmSync(objPath);
    // Prove the premise: git show now fails with exactly 128.
    const show = spawnSync("git", ["show", "HEAD:data/siting-context.json"], {
      cwd: repoDir,
      env: GIT_ENV,
      encoding: "utf8",
    });
    expect(show.status).toBe(128);

    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GUARD ERROR");
    expect(result.stdout + result.stderr).not.toContain("skipping");
  });

  it("exits 2 when run outside any git repo (neither ref resolves)", () => {
    mkdirSync(join(repoDir, "scripts"));
    mkdirSync(join(repoDir, "data"));
    copyFileSync(SCRIPT_SRC, join(repoDir, "scripts", "check-siting-additive.mjs"));
    writeFileSync(join(repoDir, "data", "siting-context.json"), BASELINE_SITING);
    writeFileSync(join(repoDir, "data", "facilities.json"), FACILITIES);
    const result = spawnSync(process.execPath, [join(repoDir, "scripts", "check-siting-additive.mjs")], {
      cwd: repoDir,
      env: {
        ...GIT_ENV,
        SITING_BASELINE_NO_FETCH: "1",
        SITING_BASELINE_REF: "HEAD",
        GIT_CEILING_DIRECTORIES: dirname(repoDir),
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("GUARD ERROR");
  });

  it("exits 2 when working-tree facilities.json is an empty array", () => {
    setup(BASELINE_SITING);
    writeFileSync(join(repoDir, "data", "facilities.json"), "[]");
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("DATA LOSS");
  });

  it("exits 2 when working-tree siting-context.json is unparseable", () => {
    setup(BASELINE_SITING);
    writeFileSync(join(repoDir, "data", "siting-context.json"), "{not json");
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain("DATA LOSS");
  });
});

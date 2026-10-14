import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBaselineFromGit } from "./check-siting-additive.mjs";

// Real-git integration test for readBaselineFromGit's maxBuffer fix.
// scripts/check-siting-additive.test.ts mocks node:child_process entirely, so
// it cannot exercise execFileSync's actual stdout buffering — this file runs
// real `git show` against a fixture sized past Node's 1 MiB default
// maxBuffer, the exact way data/siting-context.json broke CI on 2026-10-14 at
// 1,053,246 bytes (see GIT_SHOW_MAX_BUFFER in check-siting-additive.mjs).

// Hermetic git: a contributor's global commit.gpgsign / core.hooksPath (or an
// inherited GIT_DIR from a hook) must not break or redirect fixture setup.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;

const ENTRY_COUNT = 20_000;

function buildFixture(): Record<string, { nearestWater: Record<string, unknown> }> {
  const fixture: Record<string, { nearestWater: Record<string, unknown> }> = {};
  for (let i = 0; i < ENTRY_COUNT; i++) {
    fixture[`facility-${i}`] = {
      nearestWater: {
        name: `River ${i}`,
        kind: "river",
        distanceMi: i / 7,
        // Padding only — pushes the fixture well past the old 1 MiB default.
        padding: "x".repeat(80),
      },
    };
  }
  return fixture;
}

describe("readBaselineFromGit — real git, no mocks", () => {
  let repoDir: string;
  let fixture: Record<string, { nearestWater: Record<string, unknown> }>;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), "siting-additive-git-test-"));
    execFileSync("git", ["init", "-q"], { cwd: repoDir, env: GIT_ENV });
    // Local-only config — never touches the user's global git config.
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, env: GIT_ENV });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, env: GIT_ENV });

    fixture = buildFixture();
    const fixtureJson = JSON.stringify(fixture);

    // The fixture must stay bigger than Node's default execFileSync
    // maxBuffer (1 MiB) — that margin is the regression this file guards.
    expect(Buffer.byteLength(fixtureJson, "utf8")).toBeGreaterThan(1_048_576);

    mkdirSync(join(repoDir, "data"), { recursive: true });
    writeFileSync(join(repoDir, "data", "siting-context.json"), fixtureJson, "utf8");

    execFileSync("git", ["add", "data/siting-context.json"], { cwd: repoDir, env: GIT_ENV });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repoDir, env: GIT_ENV });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("reads a baseline blob larger than the old 1 MiB default maxBuffer", () => {
    const result = readBaselineFromGit(repoDir, "data/siting-context.json", "HEAD") as Record<
      string,
      { nearestWater: Record<string, unknown> }
    > | null;

    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toHaveLength(ENTRY_COUNT);
    expect(result!["facility-0"]).toEqual(fixture["facility-0"]);
    expect(result![`facility-${ENTRY_COUNT - 1}`]).toEqual(fixture[`facility-${ENTRY_COUNT - 1}`]);
  });

  it("returns null for a path absent from HEAD (the legitimate first-run case)", () => {
    expect(readBaselineFromGit(repoDir, "data/does-not-exist.json", "HEAD")).toBeNull();
  });
});

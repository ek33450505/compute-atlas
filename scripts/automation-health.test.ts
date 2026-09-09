// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCannotCheckReport,
  classifyWorkflow,
  emitOutcome,
  type WorkflowConfig,
  type WorkflowRun,
} from "./automation-health";

const DAILY: WorkflowConfig = {
  file: "drift-alert.yml",
  name: "drift-alert",
  cronDescription: "0 22 * * * (daily 22:00 UTC)",
  staleAfterHours: 36,
};

const WEEKLY: WorkflowConfig = {
  file: "release-please.yml",
  name: "release-please",
  cronDescription: "0 9 * * 1 (Mondays 09:00 UTC)",
  staleAfterHours: 8 * 24,
};

const NOW = new Date("2026-09-09T00:00:00.000Z");

function run(hoursAgo: number, opts: Partial<WorkflowRun> = {}): WorkflowRun {
  const created = new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  return {
    status: "completed",
    conclusion: "success",
    created_at: created,
    ...opts,
  };
}

describe("classifyWorkflow", () => {
  it("is ok for a recent successful run", () => {
    const result = classifyWorkflow(DAILY, [run(2)], NOW);
    expect(result.state).toBe("ok");
    expect(result.streak).toBe(0);
  });

  it("counts a 6-run consecutive failure streak correctly (the real drift-alert case)", () => {
    const runs: WorkflowRun[] = [
      run(2, { conclusion: "failure" }),
      run(26, { conclusion: "failure" }),
      run(50, { conclusion: "timed_out" }),
      run(74, { conclusion: "failure" }),
      run(98, { conclusion: "cancelled" }),
      run(122, { conclusion: "failure" }),
      // an older success further back must NOT extend the streak
      run(146, { conclusion: "success" }),
    ];
    const result = classifyWorkflow(DAILY, runs, NOW);
    expect(result.state).toBe("failing");
    expect(result.streak).toBe(6);
  });

  it("stops the streak count at the first non-failure, even if failures resume further back", () => {
    const runs: WorkflowRun[] = [
      run(2, { conclusion: "failure" }),
      run(26, { conclusion: "success" }),
      run(50, { conclusion: "failure" }),
    ];
    const result = classifyWorkflow(DAILY, runs, NOW);
    expect(result.state).toBe("failing");
    expect(result.streak).toBe(1);
  });

  it("is stale when the newest run succeeded but is older than the budget", () => {
    const result = classifyWorkflow(DAILY, [run(40, { conclusion: "success" })], NOW);
    expect(result.state).toBe("stale");
    expect(result.detail).toMatch(/40\.0h/);
  });

  it("is never-run when there are no runs at all", () => {
    const result = classifyWorkflow(DAILY, [], NOW);
    expect(result.state).toBe("never-run");
    expect(result.lastRunAt).toBeNull();
  });

  it("judges on the newest COMPLETED run when the newest run is in_progress", () => {
    const runs: WorkflowRun[] = [
      run(1, { status: "in_progress", conclusion: null }),
      run(25, { status: "completed", conclusion: "failure" }),
    ];
    const result = classifyWorkflow(DAILY, runs, NOW);
    expect(result.state).toBe("failing");
    expect(result.streak).toBe(1);
  });

  it("is ok when the only run is in_progress and within budget (nothing completed yet)", () => {
    const runs: WorkflowRun[] = [run(1, { status: "in_progress", conclusion: null })];
    const result = classifyWorkflow(DAILY, runs, NOW);
    expect(result.state).toBe("ok");
  });

  it("weekly budget: a 5-day-old release-please run is ok", () => {
    const result = classifyWorkflow(WEEKLY, [run(5 * 24, { conclusion: "success" })], NOW);
    expect(result.state).toBe("ok");
  });

  it("weekly budget: a 9-day-old release-please run is stale", () => {
    const result = classifyWorkflow(WEEKLY, [run(9 * 24, { conclusion: "success" })], NOW);
    expect(result.state).toBe("stale");
  });
});

// The workflow decides whether to open an issue from
// `steps.health.outputs.healthy == 'false'` and reads the body from the report
// file. Those two artifacts ARE the contract with automation-health.yml, and
// they were previously written at two separate call sites — so the "cannot
// check" path wrote neither, went red, and filed nothing. These tests assert
// both artifacts appear together on every path.
describe("emitOutcome", () => {
  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "automation-health-"));
    const out = join(dir, "health.md");
    const githubOutput = join(dir, "github_output");
    // GitHub creates $GITHUB_OUTPUT before the step runs; emitOutcome appends.
    writeFileSync(githubOutput, "", "utf8");
    return { out, githubOutput, env: { GITHUB_OUTPUT: githubOutput } };
  }

  it("writes the report AND healthy=false together when unhealthy", () => {
    const { out, githubOutput, env } = scratch();
    emitOutcome({ healthy: false, markdown: "# body", out, env });

    expect(readFileSync(out, "utf8")).toBe("# body");
    expect(readFileSync(githubOutput, "utf8")).toBe("healthy=false\n");
  });

  it("writes healthy=true when everything is ok", () => {
    const { out, githubOutput, env } = scratch();
    emitOutcome({ healthy: true, markdown: "# body", out, env });

    expect(readFileSync(githubOutput, "utf8")).toBe("healthy=true\n");
  });

  it("appends rather than truncating, so it cannot clobber another step's outputs", () => {
    const { out, githubOutput, env } = scratch();
    writeFileSync(githubOutput, "other=1\n", "utf8");
    emitOutcome({ healthy: false, markdown: "# body", out, env });

    expect(readFileSync(githubOutput, "utf8")).toBe("other=1\nhealthy=false\n");
  });

  it("still sets the step output when no --out path was given", () => {
    const { githubOutput, env } = scratch();
    emitOutcome({ healthy: false, markdown: "# body", out: null, env });

    expect(readFileSync(githubOutput, "utf8")).toBe("healthy=false\n");
  });
});

describe("buildCannotCheckReport", () => {
  it("states plainly that nothing was verified, rather than reading as an all-clear", () => {
    const body = buildCannotCheckReport("GITHUB_TOKEN is not set.");

    expect(body).toContain("could not run at all");
    expect(body).toContain("not a clean bill of health");
    expect(body).toContain("GITHUB_TOKEN is not set.");
    // Never claim health on a path that checked nothing.
    expect(body).not.toContain("All monitored scheduled workflows are healthy");
  });

  it("carries the same self-staleness caveat as the normal report", () => {
    expect(buildCannotCheckReport("boom")).toContain("cannot detect its own staleness");
  });
});

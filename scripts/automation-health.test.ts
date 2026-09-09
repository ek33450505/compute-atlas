// @vitest-environment node
import { describe, expect, it } from "vitest";

import { classifyWorkflow, type WorkflowConfig, type WorkflowRun } from "./automation-health";

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

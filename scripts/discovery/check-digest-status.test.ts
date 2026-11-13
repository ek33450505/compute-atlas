// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  DIGEST_ERROR_WINDOW_MS,
  DIGEST_RECIPIENT_ALARM,
  DigestCheckError,
  DigestCrashError,
  classifySendErrors,
  finalFailures,
  isMissingTable,
  recipientAlarm,
  runChecks,
  type CheckDeps,
  type SendRow,
} from "./check-digest-status";

const NOW = new Date("2026-11-12T12:00:00Z");
const RUN = { id: "run-1", startedAt: new Date("2026-11-10T12:00:00Z") };

let seq = 0;
function row(over: Partial<SendRow> & { at?: number }): SendRow {
  const { at, ...rest } = over;
  return {
    id: `id-${String(seq).padStart(4, "0")}`,
    subscriptionId: "sub-1",
    emailHash: "hash-1",
    outcome: "sent",
    errorCode: null,
    createdAt: new Date(Date.UTC(2026, 10, 10, 12, 0, at ?? seq++)),
    ...rest,
  };
}

describe("finalFailures", () => {
  it("does not count a rate-limited send that the retry delivered", () => {
    const rows = [
      row({ outcome: "error", errorCode: "rate_limit_exceeded", at: 1 }),
      row({ outcome: "sent", at: 2 }),
    ];
    expect(finalFailures(rows)).toEqual([]);
  });

  it("counts retry-then-error, regardless of row order", () => {
    const rows = [
      row({ outcome: "error", errorCode: "validation_error", at: 2 }),
      row({ outcome: "error", errorCode: "rate_limit_exceeded", at: 1 }),
    ];
    expect(finalFailures(rows).map((r) => r.errorCode)).toEqual(["validation_error"]);
  });

  it("counts a send still in attempted", () => {
    expect(finalFailures([row({ outcome: "attempted" })])).toHaveLength(1);
  });

  it("ignores skipped outcomes", () => {
    expect(finalFailures([row({ outcome: "skipped_suppressed" })])).toEqual([]);
  });

  it("keys by emailHash when subscriptionId is null", () => {
    const rows = [
      row({ subscriptionId: null, emailHash: "a", outcome: "error", at: 1 }),
      row({ subscriptionId: null, emailHash: "a", outcome: "sent", at: 2 }),
      row({ subscriptionId: null, emailHash: "b", outcome: "error", at: 1 }),
    ];
    expect(finalFailures(rows).map((r) => r.emailHash)).toEqual(["b"]);
  });
});

describe("finalFailures: system-caused skips", () => {
  it("counts skipped_no_key and skipped_check_failed", () => {
    expect(finalFailures([row({ subscriptionId: "a", outcome: "skipped_no_key" })])).toHaveLength(1);
    expect(finalFailures([row({ subscriptionId: "b", outcome: "skipped_check_failed" })])).toHaveLength(1);
  });

  it.each(["skipped_suppressed", "skipped_unconfirmed", "skipped_capped", "skipped_duplicate"])(
    "does not count the deliberate skip %s",
    (outcome) => {
      expect(finalFailures([row({ outcome })])).toEqual([]);
    }
  );

  it("breaks a createdAt tie by the greater id, in either input order", () => {
    const t = new Date("2026-11-10T12:00:00Z");
    const bad = row({ id: "b", outcome: "error", errorCode: "x", createdAt: t });
    const good = row({ id: "a", outcome: "sent", createdAt: t });
    expect(finalFailures([good, bad])).toHaveLength(1);
    expect(finalFailures([bad, good])).toHaveLength(1);
    const good2 = row({ id: "c", outcome: "sent", createdAt: t });
    expect(finalFailures([bad, good2])).toEqual([]);
    expect(finalFailures([good2, bad])).toEqual([]);
  });

  it("treats a null-subscription row and a non-null row as separate recipients", () => {
    const rows = [
      row({ subscriptionId: null, emailHash: "h", outcome: "error", errorCode: "x", at: 1 }),
      row({ subscriptionId: "s", emailHash: "h", outcome: "sent", at: 2 }),
    ];
    expect(finalFailures(rows)).toHaveLength(1);
  });
});

describe("classifySendErrors", () => {
  const failing = [
    row({ subscriptionId: "s1", emailHash: "secret-hash-1", outcome: "error", errorCode: "rate_limit_exceeded" }),
    row({ subscriptionId: "s2", emailHash: "secret-hash-2", outcome: "error", errorCode: "rate_limit_exceeded" }),
    row({ subscriptionId: "s3", emailHash: "secret-hash-3", outcome: "attempted" }),
  ];

  it("is ok with no failures", () => {
    expect(classifySendErrors(RUN, [row({})], NOW)).toEqual({ level: "ok", message: "" });
  });

  it("fails a recent run with counts by errorCode and no recipient identifiers", () => {
    const v = classifySendErrors(RUN, failing, NOW);
    expect(v.level).toBe("fail");
    expect(v.message).toContain("rate_limit_exceeded=2");
    expect(v.message).toContain("attempted_no_final_outcome=1");
    expect(v.message).toContain("run [run-1]");
    expect(v.message).not.toMatch(/secret-hash|s1|s2/);
  });

  it("omits the attempted clause for an error-only run", () => {
    const v = classifySendErrors(
      RUN,
      [row({ outcome: "error", errorCode: "rate_limit_exceeded" })],
      NOW
    );
    expect(v.message).toContain("were not mailed (by code: rate_limit_exceeded=1)");
    expect(v.message).not.toContain("may still have left");
  });

  it("adds the attempted clause only when an attempted row is present", () => {
    const v = classifySendErrors(RUN, [row({ outcome: "attempted" })], NOW);
    expect(v.message).toContain("attempted_no_final_outcome=1");
    expect(v.message).toContain("may still have left");
  });

  it("labels error/send_timeout separately, still fails, and adds the may-have-left clause", () => {
    const v = classifySendErrors(RUN, [row({ outcome: "error", errorCode: "send_timeout" })], NOW);
    expect(v.level).toBe("fail");
    expect(v.message).toContain("send_timeout_may_have_left=1");
    expect(v.message).toContain("may still have left");
  });

  it("labels skipped_no_key on its own", () => {
    const v = classifySendErrors(RUN, [row({ outcome: "skipped_no_key" })], NOW);
    expect(v.level).toBe("fail");
    expect(v.message).toContain("skipped_no_key=1");
  });

  it("fails at exactly 7 days and warns one millisecond later", () => {
    const at = (ms: number) => ({ id: "r", startedAt: new Date(NOW.getTime() - ms) });
    expect(classifySendErrors(at(DIGEST_ERROR_WINDOW_MS), failing, NOW).level).toBe("fail");
    expect(classifySendErrors(at(DIGEST_ERROR_WINDOW_MS + 1), failing, NOW).level).toBe("warning");
  });

  it("only warns once the run is older than the window", () => {
    const old = { id: "run-0", startedAt: new Date(NOW.getTime() - DIGEST_ERROR_WINDOW_MS - 1000) };
    expect(classifySendErrors(old, failing, NOW).level).toBe("warning");
  });
});

describe("recipientAlarm", () => {
  it("passes at the alarm value", () => {
    expect(recipientAlarm(DIGEST_RECIPIENT_ALARM)).toBeNull();
    expect(DIGEST_RECIPIENT_ALARM).toBe(150);
  });

  it("fails one above it, with the remedy", () => {
    const msg = recipientAlarm(151);
    expect(msg).toContain("151");
    expect(msg).toContain("maxDuration");
    expect(msg).toContain("batch");
  });
});

describe("isMissingTable", () => {
  const err = (code: string, rel: string) => Object.assign(new Error(`relation "${rel}" does not exist`), { code });

  it("matches 42P01 on the expected relation, directly or via cause", () => {
    expect(isMissingTable(err("42P01", "email_sends"), "email_sends")).toBe(true);
    expect(isMissingTable(Object.assign(new Error("Failed query"), { cause: err("42P01", "email_sends") }), "email_sends")).toBe(true);
  });

  it("rejects another relation, another SQLSTATE, and non-errors", () => {
    expect(isMissingTable(err("42P01", "subscriptions"), "email_sends")).toBe(false);
    expect(isMissingTable(err("57014", "email_sends"), "email_sends")).toBe(false);
    expect(isMissingTable(null, "email_sends")).toBe(false);
  });
});

describe("runChecks", () => {
  const healthy: CheckDeps = {
    fetchIncompleteRuns: async () => [],
    fetchNewestRunSends: async () => ({ run: RUN, rows: [row({})] }),
    countDigestSubscriptions: async () => 10,
    now: () => NOW,
  };

  it("passes when everything is healthy", async () => {
    expect((await runChecks(healthy)).failures).toEqual([]);
  });

  it("is a no-op when the tables are missing (null results)", async () => {
    const r = await runChecks({
      ...healthy,
      fetchIncompleteRuns: async () => null,
      fetchNewestRunSends: async () => null,
    });
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("still runs the other checks when one throws, and reports every failure", async () => {
    let sendsRan = false;
    const r = await runChecks({
      ...healthy,
      fetchIncompleteRuns: async () => {
        throw new DigestCheckError("Failed to query state_digest_runs: 08006");
      },
      fetchNewestRunSends: async () => {
        sendsRan = true;
        return { run: RUN, rows: [row({ outcome: "error", errorCode: "x" })] };
      },
      countDigestSubscriptions: async () => 151,
    });
    expect(sendsRan).toBe(true);
    expect(r.failures).toHaveLength(3);
  });

  it("records an unexpected throw in the sends check as a failure while the alarm still runs", async () => {
    const r = await runChecks({
      ...healthy,
      fetchNewestRunSends: async () => {
        throw new Error("boom");
      },
      countDigestSubscriptions: async () => 151,
    });
    expect(r.failures).toHaveLength(2);
  });
});

describe("DigestCrashError", () => {
  it("points at the resume path and never recommends deleting the row", () => {
    const run = {
      id: "r1",
      startedAt: new Date("2026-11-01T00:00:00Z"),
      since: new Date("2026-10-01T00:00:00Z"),
      until: new Date("2026-11-01T00:00:00Z"),
    } as ConstructorParameters<typeof DigestCrashError>[0][number];
    const { message } = new DigestCrashError([run]);
    expect(message).toContain("?since=<YYYY-MM-DD>&until=<YYYY-MM-DD>");
    expect(message).toContain("admin bearer");
    expect(message).toContain("10 minutes");
    expect(message).toContain("ambiguous");
    expect(message).toContain("Do NOT delete");
    expect(message).not.toContain("manual deletion");
    expect(message).not.toContain("left no way");
  });
});

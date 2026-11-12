// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CronCheckError,
  DIGEST_MAX_AGE_MS,
  EDITION_BUILD_STALE_MS,
  EDITION_MAX_AGE_MS,
  PAYPAL_UNPROCESSED_MS,
  checkDigestFreshness,
  checkEdition,
  checkMail,
  checkPaypal,
  mailFailures,
  runChecks,
  type CronDeps,
  type MailRow,
} from "./check-cron-freshness";

const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("checkDigestFreshness", () => {
  it("notes (not fails) on an empty table", () => {
    const r = checkDigestFreshness(null, NOW);
    expect(r.failure).toBeUndefined();
    expect(r.note).toContain("no state_digest_runs rows");
  });
  it("passes at exactly the limit and fails 1 ms past it", () => {
    expect(checkDigestFreshness(ago(DIGEST_MAX_AGE_MS), NOW).failure).toBeUndefined();
    expect(checkDigestFreshness(ago(DIGEST_MAX_AGE_MS + 1), NOW).failure).toContain("looks dead");
  });
  it("limit is 32 days", () => expect(DIGEST_MAX_AGE_MS).toBe(32 * DAY));
});

describe("checkEdition", () => {
  it("fails on no editions or a missing table: the flag says the lane is live", () => {
    const r = checkEdition(null, NOW);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("no dataset edition");
  });
  it("passes a fresh published edition", () => {
    const r = checkEdition({ builtAt: ago(2 * DAY), status: "published" }, NOW);
    expect(r.failures).toEqual([]);
    expect(r.note).toContain("published");
  });
  it("limits are 8 days and 2 hours", () => {
    expect(EDITION_MAX_AGE_MS).toBe(8 * DAY);
    expect(EDITION_BUILD_STALE_MS).toBe(2 * HOUR);
  });
  it("age threshold: 8 days passes, one ms more fails", () => {
    expect(checkEdition({ builtAt: ago(EDITION_MAX_AGE_MS), status: "published" }, NOW).failures).toEqual([]);
    expect(checkEdition({ builtAt: ago(EDITION_MAX_AGE_MS + 1), status: "published" }, NOW).failures).toHaveLength(1);
  });
  it("fails a failed newest edition even when fresh", () => {
    const r = checkEdition({ builtAt: ago(HOUR), status: "failed" }, NOW);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("failed");
  });
  it("building threshold: 2 hours passes, one ms more fails", () => {
    expect(checkEdition({ builtAt: ago(EDITION_BUILD_STALE_MS), status: "building" }, NOW).failures).toEqual([]);
    const r = checkEdition({ builtAt: ago(EDITION_BUILD_STALE_MS + 1), status: "building" }, NOW);
    expect(r.failures[0]).toContain("building for over 2 hours");
  });
  it("reports both age and failed status", () => {
    expect(checkEdition({ builtAt: ago(20 * DAY), status: "failed" }, NOW).failures).toHaveLength(2);
  });
});

describe("checkPaypal", () => {
  it("passes on zero, notes on a missing table, fails with the count only", () => {
    expect(checkPaypal(0).failure).toBeUndefined();
    expect(checkPaypal(null).note).toContain("absent");
    const f = checkPaypal(3).failure ?? "";
    expect(checkPaypal(1).failure).toContain("1 PayPal webhook event(s)");
    expect(f).toContain("3 PayPal webhook event(s)");
    expect(f).not.toMatch(/WH-|I-[A-Z0-9]{6}|payload|event_type/i);
  });
  it("threshold is 24 hours", () => expect(PAYPAL_UNPROCESSED_MS).toBe(24 * HOUR));
});

let seq = 0;
function mail(over: Partial<MailRow> & { at?: number }): MailRow {
  const { at, ...rest } = over;
  return {
    id: `id-${String(seq++).padStart(4, "0")}`,
    kind: "state_digest",
    runId: "run-1",
    subscriptionId: "sub-1",
    emailHash: "hash-1",
    outcome: "sent",
    errorCode: null,
    createdAt: new Date(Date.UTC(2026, 10, 10, 12, 0, at ?? 0)),
    ...rest,
  };
}

describe("mailFailures / checkMail", () => {
  it("ignores a rate limit that the retry delivered", () => {
    const rows = [mail({ outcome: "error", errorCode: "rate_limit_exceeded", at: 1 }), mail({ outcome: "sent", at: 2 })];
    expect(mailFailures(rows)).toEqual([]);
    expect(checkMail(rows).failure).toBeUndefined();
  });
  it("counts the four system failures, not deliberate skips", () => {
    const rows = ["error", "attempted", "skipped_no_key", "skipped_check_failed", "skipped_suppressed", "skipped_capped"].map(
      (outcome, i) => mail({ outcome, errorCode: outcome === "error" ? "validation_error" : null, subscriptionId: `s${i}`, runId: null })
    );
    expect(mailFailures(rows).map((f) => f.code).sort()).toEqual([
      "attempted_no_final_outcome",
      "skipped_check_failed",
      "skipped_no_key",
      "validation_error",
    ]);
  });
  it("covers kinds other than the digest and groups by kind and code", () => {
    const rows = [
      mail({ kind: "subscription_confirm", runId: null, outcome: "error", errorCode: "x", subscriptionId: "a" }),
      mail({ kind: "subscription_confirm", runId: null, outcome: "error", errorCode: "x", subscriptionId: "b" }),
    ];
    expect(mailFailures(rows)).toEqual([{ kind: "subscription_confirm", code: "x", n: 2 }]);
    expect(checkMail(rows).failure).toContain("subscription_confirm/x=2");
  });
  it("does not let a delivered send of another kind or run mask a failure", () => {
    const rows = [
      mail({ kind: "state_digest", outcome: "error", errorCode: "boom", at: 1 }),
      mail({ kind: "area_digest", outcome: "sent", at: 2 }),
      mail({ runId: "run-2", outcome: "sent", at: 3 }),
    ];
    expect(mailFailures(rows)).toEqual([{ kind: "state_digest", code: "boom", n: 1 }]);
  });
  it("collapses a run-less retry chain within one day, not across days", () => {
    const base = { runId: null, kind: "subscription_confirm" } as const;
    const sameDay = [mail({ ...base, outcome: "error", errorCode: "e", at: 1 }), mail({ ...base, outcome: "sent", at: 2 })];
    expect(mailFailures(sameDay)).toEqual([]);
    const nextDay = { ...mail({ ...base, outcome: "sent" }), createdAt: new Date("2026-11-11T12:00:00Z") };
    expect(mailFailures([mail({ ...base, outcome: "error", errorCode: "e" }), nextDay])).toHaveLength(1);
  });
  it("never reports recipient identifiers", () => {
    const rows = [mail({ outcome: "error", errorCode: "e", subscriptionId: "SECRET-SUB", emailHash: "SECRET-HASH" })];
    expect(checkMail(rows).failure).not.toMatch(/SECRET/);
  });
  it("notes a missing table", () => expect(checkMail(null).note).toContain("absent"));
});

function deps(over: Partial<CronDeps> = {}): CronDeps {
  return {
    fetchNewestDigestStart: async () => ago(10 * DAY),
    fetchNewestEdition: async () => ({ builtAt: ago(DAY), status: "published" }),
    countStalePaypalEvents: async () => 0,
    fetchRecentSends: async () => [],
    datasetSharingEnabled: true,
    now: () => NOW,
    ...over,
  };
}

describe("runChecks", () => {
  it("is clean when everything is fresh", async () => {
    const r = await runChecks(deps());
    expect(r.failures).toEqual([]);
    expect(r.notes).toHaveLength(4);
  });
  it("skips the edition check entirely when sharing is off, even with a dead edition", async () => {
    let called = false;
    const r = await runChecks(
      deps({
        datasetSharingEnabled: false,
        fetchNewestEdition: async () => {
          called = true;
          return { builtAt: ago(99 * DAY), status: "failed" };
        },
      })
    );
    expect(called).toBe(false);
    expect(r.failures).toEqual([]);
    expect(r.notes.join("\n")).toContain("skipped");
  });
  it("fails when sharing is on and there is no edition", async () => {
    const r = await runChecks(deps({ fetchNewestEdition: async () => null }));
    expect(r.failures).toHaveLength(1);
  });
  it("checks the edition when sharing is on", async () => {
    const r = await runChecks(deps({ fetchNewestEdition: async () => ({ builtAt: ago(99 * DAY), status: "published" }) }));
    expect(r.failures).toHaveLength(1);
  });
  it("runs every check and reports all failures, including thrown ones", async () => {
    const r = await runChecks(
      deps({
        fetchNewestDigestStart: async () => ago(40 * DAY),
        fetchNewestEdition: async () => {
          throw new CronCheckError("Failed to query dataset_editions: 42501");
        },
        countStalePaypalEvents: async () => 2,
        fetchRecentSends: async () => {
          throw new Error("boom");
        },
      })
    );
    expect(r.failures).toHaveLength(4);
    expect(r.failures.some((f) => f.includes("42501"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("cron freshness check errored"))).toBe(true);
  });
  it("passes the 24 h cutoff and 7 d window to the queries", async () => {
    let cutoff: Date | undefined;
    let since: Date | undefined;
    await runChecks(
      deps({
        countStalePaypalEvents: async (c) => ((cutoff = c), 0),
        fetchRecentSends: async (s) => ((since = s), []),
      })
    );
    expect(cutoff).toEqual(ago(24 * HOUR));
    expect(since).toEqual(ago(7 * DAY));
  });
});

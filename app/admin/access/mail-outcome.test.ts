import { describe, it, expect } from "vitest";

import type { GateDisposition } from "@/lib/email-gate";
import { describeMailOutcome, type MailKind } from "./mail-outcome";

const UNDELIVERED = [
  "send_failed",
  "skipped_suppressed",
  "skipped_check_failed",
  "skipped_unconfirmed",
  "skipped_capped",
  "skipped_no_key",
  "gate_error",
] as const satisfies readonly Exclude<GateDisposition, "sent">[];

const KINDS: MailKind[] = ["approved", "rejected", "link_reissued"];

describe("describeMailOutcome", () => {
  it.each(KINDS)("treats `sent` as delivered for %s", (kind) => {
    const outcome = describeMailOutcome("sent", kind);
    expect(outcome.delivered).toBe(true);
    expect(outcome.text).toMatch(/was sent/);
    expect(outcome.text).not.toMatch(/NOT/);
  });

  for (const disposition of UNDELIVERED) {
    it(`${disposition}: not delivered, names the raw code`, () => {
      for (const kind of KINDS) {
        const outcome = describeMailOutcome(disposition, kind);
        expect(outcome.delivered).toBe(false);
        expect(outcome.text).toContain(disposition);
        expect(outcome.text).toMatch(/was NOT sent/);
      }
    });
  }

  it.each(["approved", "link_reissued"] as const)(
    "%s not sent: says the requester has no link and how to recover",
    (kind) => {
      const { text } = describeMailOutcome("skipped_suppressed", kind);
      expect(text).toContain(
        "The requester does NOT have their link. Reissue it from the grants list once the cause is fixed."
      );
    }
  );

  it("rejected not sent: says the requester was not told, without link advice", () => {
    const { text } = describeMailOutcome("send_failed", "rejected");
    expect(text).toContain("The requester was not told.");
    expect(text).not.toMatch(/link/);
  });

  it("gives every undelivered disposition a distinct plain-words cause", () => {
    const texts = UNDELIVERED.map((d) => describeMailOutcome(d, "approved").text);
    expect(new Set(texts).size).toBe(UNDELIVERED.length);
  });
});

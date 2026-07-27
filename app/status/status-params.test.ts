import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[status]/page";
import { STATUS_ORDER } from "@/lib/status";

/**
 * Verifies that generateStaticParams produces exactly one { status } entry
 * per lifecycle status in STATUS_ORDER — pure data, no renders. Mirrors
 * app/states/state-params.test.ts / app/operators/operator-params.test.ts.
 */
describe("generateStaticParams (status)", () => {
  it("returns one param per status in STATUS_ORDER", async () => {
    const params = await generateStaticParams();
    expect(params).toHaveLength(STATUS_ORDER.length);
  });

  it("each param's status is a value from STATUS_ORDER", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(STATUS_ORDER).toContain(p.status);
    }
  });

  it("covers every status exactly once", async () => {
    const params = await generateStaticParams();
    const statuses = params.map((p) => p.status).sort();
    expect(statuses).toEqual([...STATUS_ORDER].sort());
  });
});

import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[state]/page";
import { getStates } from "@/lib/data";
import { stateCodeFromSlug } from "@/lib/us-states";

/**
 * Verifies that generateStaticParams produces exactly one { state } slug
 * entry per tracked state, each reversible back to a valid state code —
 * pure data, no renders.
 */
describe("generateStaticParams (states)", () => {
  it("returns one param per tracked state", async () => {
    const params = await generateStaticParams();
    const states = await getStates();
    expect(params).toHaveLength(states.length);
  });

  it("each param has a non-empty string state slug", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(p).toHaveProperty("state");
      expect(typeof p.state).toBe("string");
      expect(p.state.length).toBeGreaterThan(0);
    }
  });

  it("each slug reverses via stateCodeFromSlug to a code in getStates()", async () => {
    const params = await generateStaticParams();
    const states = await getStates();
    for (const p of params) {
      const code = stateCodeFromSlug(p.state);
      expect(code).toBeDefined();
      expect(states).toContain(code);
    }
  });

  it("no slug is the literal string 'undefined'", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(p.state).not.toBe("undefined");
    }
  });
});

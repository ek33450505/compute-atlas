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
  it("returns one param per tracked state", () => {
    const params = generateStaticParams();
    const states = getStates();
    expect(params).toHaveLength(states.length);
  });

  it("each param has a non-empty string state slug", () => {
    const params = generateStaticParams();
    for (const p of params) {
      expect(p).toHaveProperty("state");
      expect(typeof p.state).toBe("string");
      expect(p.state.length).toBeGreaterThan(0);
    }
  });

  it("each slug reverses via stateCodeFromSlug to a code in getStates()", () => {
    const params = generateStaticParams();
    const states = getStates();
    for (const p of params) {
      const code = stateCodeFromSlug(p.state);
      expect(code).toBeDefined();
      expect(states).toContain(code);
    }
  });

  it("no slug is the literal string 'undefined'", () => {
    const params = generateStaticParams();
    for (const p of params) {
      expect(p.state).not.toBe("undefined");
    }
  });
});

import { describe, it, expect } from "vitest";
import { generateStaticParams } from "./[operator]/page";
import { getOperators } from "@/lib/data";
import { getOperatorBySlug } from "@/lib/data";

/**
 * Verifies that generateStaticParams produces exactly one { operator } slug
 * entry per tracked operator, each reversible back to a valid operator name —
 * pure data, no renders.
 */
describe("generateStaticParams (operators)", () => {
  it("returns one param per tracked operator", async () => {
    const params = await generateStaticParams();
    const operators = await getOperators();
    expect(params).toHaveLength(operators.length);
  });

  it("each param has a non-empty string operator slug", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(p).toHaveProperty("operator");
      expect(typeof p.operator).toBe("string");
      expect(p.operator.length).toBeGreaterThan(0);
    }
  });

  it("each slug reverses via getOperatorBySlug to a name in getOperators()", async () => {
    const params = await generateStaticParams();
    const operators = await getOperators();
    for (const p of params) {
      const name = await getOperatorBySlug(p.operator);
      expect(name).toBeDefined();
      expect(operators).toContain(name);
    }
  });

  it("no slug is the literal string 'undefined'", async () => {
    const params = await generateStaticParams();
    for (const p of params) {
      expect(p.operator).not.toBe("undefined");
    }
  });
});

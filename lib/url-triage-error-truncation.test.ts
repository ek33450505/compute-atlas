import { describe, it, expect, vi } from "vitest";

// Module-level mock lives in its own file so it cannot disturb url-triage.test.ts.
vi.mock("@/scripts/discovery/fetch-page-text", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/discovery/fetch-page-text")>();
  return {
    ...actual,
    fetchPageText: vi.fn(async () => {
      // String(err) is "Error: " (7 chars) + message, so index 299 is the high
      // surrogate and 300 its pair: slice(0, 300) cuts the pair in half.
      throw new Error("x".repeat(292) + "\u{1F600}" + "tail");
    }),
  };
});

import { triageUrl } from "./url-triage";

describe("triageUrl catch-branch error truncation", () => {
  it("bounds the error and never leaves a lone trailing high surrogate", async () => {
    const result = await triageUrl("https://example.com/page");
    expect(result.ok).toBe(false);
    const error = result.error ?? "";
    expect(error.length).toBeGreaterThan(0);
    expect(error.length).toBeLessThanOrEqual(300);
    const last = error.charCodeAt(error.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

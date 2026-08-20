import { describe, it, expect } from "vitest";

import { normalizeUrlForDedupe } from "@/lib/lead-dedupe";

describe("normalizeUrlForDedupe", () => {
  const cases: Array<{ label: string; a: string; b: string; equal: boolean }> = [
    {
      label: "trailing slash is ignored",
      a: "https://example.com/permit/123",
      b: "https://example.com/permit/123/",
      equal: true,
    },
    {
      label: "leading www. is ignored",
      a: "https://www.example.com/permit/123",
      b: "https://example.com/permit/123",
      equal: true,
    },
    {
      label: "host case is ignored",
      a: "https://Example.COM/permit/123",
      b: "https://example.com/permit/123",
      equal: true,
    },
    {
      label: "fragment is ignored",
      a: "https://example.com/permit/123#section-2",
      b: "https://example.com/permit/123",
      equal: true,
    },
    {
      label: "query string is significant (kept), not ignored",
      a: "https://example.com/permit?docId=1",
      b: "https://example.com/permit?docId=2",
      equal: false,
    },
    {
      label: "different paths are not equal",
      a: "https://example.com/permit/123",
      b: "https://example.com/permit/456",
      equal: false,
    },
  ];

  it.each(cases)("$label", ({ a, b, equal }) => {
    const normA = normalizeUrlForDedupe(a);
    const normB = normalizeUrlForDedupe(b);
    expect(normA).not.toBeNull();
    expect(normB).not.toBeNull();
    if (equal) {
      expect(normA).toBe(normB);
    } else {
      expect(normA).not.toBe(normB);
    }
  });

  it("returns null for an unparseable URL instead of throwing", () => {
    expect(normalizeUrlForDedupe("not a url")).toBeNull();
  });
});

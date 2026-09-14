import { describe, it, expect } from "vitest";

import {
  RESTRICTED_SOURCE_DOMAINS,
  isRestrictedSourceUrl,
  restrictedSourceReason,
} from "./restricted-sources";

describe("isRestrictedSourceUrl", () => {
  it("matches the exact restricted host", () => {
    expect(isRestrictedSourceUrl("https://interconnection.fyi/queue/123")).toBe(true);
  });

  it("matches a www. subdomain", () => {
    expect(isRestrictedSourceUrl("https://www.interconnection.fyi/queue/123")).toBe(true);
  });

  it("matches a deeper subdomain", () => {
    expect(isRestrictedSourceUrl("https://data.api.interconnection.fyi/v1/queue")).toBe(true);
  });

  it("does NOT match a lookalike host with the domain as a prefix", () => {
    expect(isRestrictedSourceUrl("https://notinterconnection.fyi/queue/123")).toBe(false);
  });

  it("does NOT match a lookalike host with the domain as a suffix-of-a-longer-label", () => {
    expect(isRestrictedSourceUrl("https://interconnection.fyi.evil.com/queue/123")).toBe(false);
  });

  it("returns false for an unparseable URL rather than throwing", () => {
    expect(isRestrictedSourceUrl("not a url")).toBe(false);
  });

  it("returns false for a normal, unrelated URL", () => {
    expect(isRestrictedSourceUrl("https://www.pjm.com/planning/service-requests")).toBe(false);
  });

  it("matches regardless of host casing", () => {
    expect(isRestrictedSourceUrl("https://Interconnection.FYI/queue/123")).toBe(true);
  });

  it("blocks a trailing-dot FQDN, which resolves to the same host", () => {
    // `interconnection.fyi.` is a valid absolute-FQDN spelling of the same
    // host. `new URL().hostname` keeps the dot, so without normalization
    // neither the equality nor the dot-suffix check matches and the guard
    // silently lets it through. Regression test for that bypass.
    expect(isRestrictedSourceUrl("https://interconnection.fyi./queue/123")).toBe(true);
  });

  it("blocks a trailing-dot subdomain", () => {
    expect(isRestrictedSourceUrl("https://www.interconnection.fyi./queue/123")).toBe(true);
  });

  it("still rejects a lookalike that merely ends in a dot", () => {
    expect(isRestrictedSourceUrl("https://notinterconnection.fyi./x")).toBe(false);
    expect(isRestrictedSourceUrl("https://interconnection.fyi.evil.com./x")).toBe(false);
  });
});

describe("restrictedSourceReason", () => {
  it("returns a non-empty reason for a matching domain", () => {
    const reason = restrictedSourceReason("https://interconnection.fyi/queue/123");
    expect(reason).not.toBeNull();
    expect(reason!.length).toBeGreaterThan(0);
  });

  it("returns null for a non-matching domain", () => {
    expect(restrictedSourceReason("https://www.pjm.com/planning/service-requests")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(restrictedSourceReason("not a url")).toBeNull();
  });
});

describe("RESTRICTED_SOURCE_DOMAINS", () => {
  it("contains exactly interconnection.fyi for now", () => {
    expect(RESTRICTED_SOURCE_DOMAINS.map((entry) => entry.domain)).toEqual([
      "interconnection.fyi",
    ]);
  });

  it("carries a reason and a read date for every entry", () => {
    for (const entry of RESTRICTED_SOURCE_DOMAINS) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.termsReadDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

});

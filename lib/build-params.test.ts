import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { previewSubset } from "./build-params";

/**
 * previewSubset trims a generateStaticParams result on Vercel PREVIEW builds
 * only. The gate is deliberately the positive `=== "preview"` test, so the
 * cases that matter most here are the non-preview ones: unset (local build and
 * GitHub-Actions CI), "production", and an unrecognised value all have to get
 * the full list back.
 *
 * Each case saves and restores process.env.VERCEL_ENV so it cannot leak into a
 * sibling test — the helper reads the variable at call time, so no module reset
 * is needed.
 */
describe("previewSubset", () => {
  const original = process.env.VERCEL_ENV;

  beforeEach(() => {
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original;
  });

  const ten = Array.from({ length: 10 }, (_, i) => ({ slug: `f-${i}` }));
  const fifty = Array.from({ length: 50 }, (_, i) => ({ slug: `f-${i}` }));

  it("trims to keep on a preview build", () => {
    process.env.VERCEL_ENV = "preview";
    expect(previewSubset(fifty, 10)).toHaveLength(10);
  });

  it("preserves the given order when trimming", () => {
    process.env.VERCEL_ENV = "preview";
    expect(previewSubset(fifty, 3)).toEqual([{ slug: "f-0" }, { slug: "f-1" }, { slug: "f-2" }]);
  });

  it("returns every entry on a preview build when the list is no longer than keep", () => {
    process.env.VERCEL_ENV = "preview";
    expect(previewSubset(ten, 10)).toEqual(ten);
    expect(previewSubset(ten, 25)).toEqual(ten);
  });

  it("returns the full list on a production build", () => {
    process.env.VERCEL_ENV = "production";
    expect(previewSubset(fifty, 10)).toEqual(fifty);
  });

  it("returns the full list when VERCEL_ENV is unset (local build, GitHub-Actions CI)", () => {
    expect(process.env.VERCEL_ENV).toBeUndefined();
    expect(previewSubset(fifty, 10)).toEqual(fifty);
  });

  it("returns the full list for an unrecognised VERCEL_ENV value", () => {
    process.env.VERCEL_ENV = "development";
    expect(previewSubset(fifty, 10)).toEqual(fifty);
  });

  it("does not match a VERCEL_ENV value that merely contains 'preview'", () => {
    process.env.VERCEL_ENV = "not-preview";
    expect(previewSubset(fifty, 10)).toEqual(fifty);
  });

  it("returns the same array reference when it does not trim", () => {
    expect(previewSubset(fifty, 10)).toBe(fifty);
  });
});

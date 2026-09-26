import { describe, it, expect } from "vitest";
import type { MetadataRoute } from "next";
import { maxEntryLastModified } from "./route";

function entry(url: string, lastModified?: string | Date): MetadataRoute.Sitemap[number] {
  return lastModified === undefined ? { url } : { url, lastModified };
}

// Thin unit test for the pure helper only — GET() itself delegates to
// SITEMAP_FAMILIES' DB-backed builders (lib/sitemap-routes.ts), which is
// beyond this helper's scope and already exercised indirectly by
// lib/sitemap-families.test.ts and the route builders' own tests.
describe("maxEntryLastModified", () => {
  it("returns the max of the parseable entries when the FIRST entry is unparseable", () => {
    const entries: MetadataRoute.Sitemap = [
      entry("https://example.com/a", "not-a-date"),
      entry("https://example.com/b", "2026-01-01T00:00:00Z"),
      entry("https://example.com/c", "2026-06-01T00:00:00Z"),
    ];

    const max = maxEntryLastModified(entries);
    expect(max).toBeInstanceOf(Date);
    expect(max?.toISOString()).toBe(new Date("2026-06-01T00:00:00Z").toISOString());
  });

  it("returns undefined when every entry's lastModified is unparseable", () => {
    const entries: MetadataRoute.Sitemap = [
      entry("https://example.com/a", "not-a-date"),
      entry("https://example.com/b", "also-not-a-date"),
    ];

    expect(maxEntryLastModified(entries)).toBeUndefined();
  });

  it("returns undefined for zero entries", () => {
    expect(maxEntryLastModified([])).toBeUndefined();
  });

  // Positive control for the NaN guard: without it, an unparseable first
  // entry is accepted as `max` unconditionally and poisons every later
  // comparison (`x > NaN` is always false), so this would incorrectly return
  // entry "a"'s Invalid Date instead of entry "b"'s real one.
  it("does not let a leading unparseable entry poison a later valid one", () => {
    const entries: MetadataRoute.Sitemap = [
      entry("https://example.com/a", "not-a-date"),
      entry("https://example.com/b", "2026-01-01T00:00:00Z"),
    ];

    const max = maxEntryLastModified(entries);
    expect(max?.toISOString()).toBe(new Date("2026-01-01T00:00:00Z").toISOString());
  });

  it("ignores entries with no lastModified at all", () => {
    const entries: MetadataRoute.Sitemap = [
      entry("https://example.com/a"),
      entry("https://example.com/b", "2026-01-01T00:00:00Z"),
    ];

    expect(maxEntryLastModified(entries)?.toISOString()).toBe(
      new Date("2026-01-01T00:00:00Z").toISOString()
    );
  });
});

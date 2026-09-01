import { describe, it, expect, vi } from "vitest";
import meta from "@/data/facilities.meta.json";
import { getDatasetEdition } from "@/lib/dataset-edition";

describe("getDatasetEdition", () => {
  it("returns the four contract fields sourced from facilities.meta.json", () => {
    const edition = getDatasetEdition();
    expect(edition).toEqual({
      version: meta.sourceRelease,
      asOf: meta.asOf,
      recordCount: meta.recordCount,
      schemaVersion: meta.schemaVersion,
    });
  });

  it("version is a non-empty string", () => {
    const { version } = getDatasetEdition();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("recordCount is a positive number", () => {
    const { recordCount } = getDatasetEdition();
    expect(recordCount).toBeGreaterThan(0);
  });

  it("falls back to a typed, non-throwing shape when meta.json is malformed", async () => {
    vi.resetModules();
    vi.doMock("@/data/facilities.meta.json", () => ({
      default: { asOf: "2026-01-01T00:00:00.000Z" }, // missing sourceRelease/recordCount/schemaVersion
    }));
    const { getDatasetEdition: getDatasetEditionMocked } = await import(
      "@/lib/dataset-edition"
    );
    expect(getDatasetEditionMocked()).toEqual({
      version: "unknown",
      asOf: "unknown",
      recordCount: 0,
      schemaVersion: 0,
    });
    vi.doUnmock("@/data/facilities.meta.json");
    vi.resetModules();
  });
});

import { describe, it, expect, vi } from "vitest";
import meta from "@/data/facilities.meta.json";
import { getDatasetEdition, getLiveDatasetEdition } from "@/lib/dataset-edition";

describe("getDatasetEdition", () => {
  it("returns the three contract fields sourced from facilities.meta.json", () => {
    const edition = getDatasetEdition();
    expect(edition).toEqual({
      asOf: meta.asOf,
      recordCount: meta.recordCount,
      schemaVersion: meta.schemaVersion,
    });
  });

  it("recordCount is a positive number", () => {
    const { recordCount } = getDatasetEdition();
    expect(recordCount).toBeGreaterThan(0);
  });

  it("falls back to a typed, non-throwing shape when meta.json is malformed", async () => {
    vi.resetModules();
    vi.doMock("@/data/facilities.meta.json", () => ({
      default: { asOf: "2026-01-01T00:00:00.000Z" }, // missing recordCount/schemaVersion
    }));
    const { getDatasetEdition: getDatasetEditionMocked } = await import(
      "@/lib/dataset-edition"
    );
    expect(getDatasetEditionMocked()).toEqual({
      asOf: "unknown",
      recordCount: 0,
      schemaVersion: 0,
    });
    vi.doUnmock("@/data/facilities.meta.json");
    vi.resetModules();
  });
});

describe("getLiveDatasetEdition", () => {
  it("returns asOf/schemaVersion but omits recordCount", () => {
    const live = getLiveDatasetEdition();
    expect(live).toEqual({
      asOf: meta.asOf,
      schemaVersion: meta.schemaVersion,
    });
    expect(live).not.toHaveProperty("recordCount");
    expect(live).not.toHaveProperty("version");
  });

  it("agrees with getDatasetEdition on every field it keeps", () => {
    const full = getDatasetEdition();
    const live = getLiveDatasetEdition();
    expect(live).toEqual({
      asOf: full.asOf,
      schemaVersion: full.schemaVersion,
    });
  });
});

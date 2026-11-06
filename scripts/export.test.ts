import { describe, it, expect } from "vitest";

import { buildExportMeta } from "./export";

describe("buildExportMeta", () => {
  it("builds the facilities.meta.json shape from a record count", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");

    const meta = buildExportMeta(723, now);

    expect(meta).toEqual({
      asOf: "2026-07-28T12:00:00.000Z",
      recordCount: 723,
      schemaVersion: 1,
    });
  });

  it("defaults asOf to the current time when now is omitted", () => {
    const before = Date.now();

    const meta = buildExportMeta(0);

    const after = Date.now();
    const asOfMs = new Date(meta.asOf).getTime();
    expect(asOfMs).toBeGreaterThanOrEqual(before);
    expect(asOfMs).toBeLessThanOrEqual(after);
  });

  it("carries recordCount through unchanged and writes no sourceRelease key", () => {
    const meta = buildExportMeta(0, new Date("2026-01-01T00:00:00.000Z"));

    expect(meta.recordCount).toBe(0);
    expect(meta).not.toHaveProperty("sourceRelease");
    expect(meta.schemaVersion).toBe(1);
  });
});

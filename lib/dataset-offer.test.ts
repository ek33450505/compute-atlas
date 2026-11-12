import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAllFacilities: vi.fn(), latestPublishedEdition: vi.fn() }));
vi.mock("@/lib/data", () => ({ getAllFacilities: mocks.getAllFacilities }));
vi.mock("@/lib/dataset-editions", () => ({ latestPublishedEdition: mocks.latestPublishedEdition }));

import {
  countDataset,
  formatEditionDate,
  formatMegabytes,
  loadOfferCounts,
  loadOfferEdition,
  loadOfferSamples,
  pickSamples,
  SAMPLE_FACILITY_IDS,
  toOfferEdition,
  withTimeout,
} from "./dataset-offer";

const f = (facilityType: string, state: string, operator: string, sources: number) =>
  ({ facilityType, operator, location: { state }, sources: Array.from({ length: sources }, () => ({})) }) as never;

afterEach(() => {
  vi.restoreAllMocks();
  mocks.getAllFacilities.mockReset();
  mocks.latestPublishedEdition.mockReset();
});

describe("countDataset", () => {
  it("counts types, distinct states and operators, and sums sources", () => {
    const counts = countDataset([
      f("data_center", "TX", "A", 2),
      f("data_center", "TX", "B", 1),
      f("crypto_mining", "OH", "A", 3),
      f("power_generation", "VA", "C", 0),
    ]);
    expect(counts).toEqual({
      facilities: 4,
      dataCenters: 2,
      cryptoSites: 1,
      powerPlants: 1,
      states: 3,
      operators: 3,
      sourceLinks: 6,
    });
  });

  it("handles an empty list", () => {
    expect(countDataset([]).facilities).toBe(0);
  });
});

describe("formatting", () => {
  it("formats edition dates and passes junk through", () => {
    expect(formatEditionDate("2026-11-10")).toBe("10 November 2026");
    expect(formatEditionDate("2026-01-05")).toBe("5 January 2026");
    expect(formatEditionDate("soon")).toBe("soon");
  });
  it("formats megabytes to one decimal", () => {
    expect(formatMegabytes(9_084_324)).toBe("9.1 MB");
    expect(formatMegabytes(1_754_755)).toBe("1.8 MB");
  });
});

describe("toOfferEdition", () => {
  it("reads the summary and maps file sizes", () => {
    const e = toOfferEdition({
      editionDate: "2026-11-10",
      recordCount: 5,
      files: [{ name: "facilities.csv", bytes: 10 }],
      changelogSummary: { added: 1, updated: 2, removed: 0, headlines: [] },
    });
    expect(e).toMatchObject({ added: 1, updated: 2, removed: 0, fileBytes: { "facilities.csv": 10 } });
  });
  it("flags the initial edition by its headline, not by zero counts", () => {
    const base = { editionDate: "2026-11-10", recordCount: 5, files: [] };
    const first = toOfferEdition({
      ...base,
      changelogSummary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 5 records"] },
    });
    const quiet = toOfferEdition({
      ...base,
      changelogSummary: { added: 0, updated: 0, removed: 0, headlines: [] },
    });
    expect(first.initial).toBe(true);
    expect(quiet.initial).toBe(false);
  });
  it("does not treat a facility headline that begins 'Initial edition:' as the initial edition", () => {
    const e = toOfferEdition({
      editionDate: "2026-11-17",
      recordCount: 5,
      files: [],
      changelogSummary: { added: 0, updated: 1, removed: 0, headlines: ["Initial edition: Campus Alpha moved to operational"] },
    });
    expect(e.initial).toBe(false);
  });
  it("tolerates a missing summary", () => {
    const e = toOfferEdition({ editionDate: "2026-11-10", recordCount: null, files: [], changelogSummary: null });
    expect(e).toMatchObject({ added: null, updated: null, removed: null });
  });
});

describe("hung reads", () => {
  it("returns null and logs a code when the edition read never settles", async () => {
    vi.useFakeTimers();
    try {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.latestPublishedEdition.mockReturnValue(new Promise(() => {}));
      const pending = loadOfferEdition();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("leaves no timer running when the reader throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        withTimeout(() => {
          throw new Error("sync boom");
        }),
      ).rejects.toThrow("sync boom");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("clears the timer when the read settles", async () => {
    vi.useFakeTimers();
    try {
      mocks.latestPublishedEdition.mockResolvedValue(null);
      await loadOfferEdition();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fail-soft loaders", () => {
  it("returns null and logs only a code when the edition read throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.latestPublishedEdition.mockRejectedValue(new Error("Failed query: secret params"));
    await expect(loadOfferEdition()).resolves.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toContain("secret");
  });
  it("returns null when the facility read throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockRejectedValue(new Error("boom"));
    await expect(loadOfferCounts()).resolves.toBeNull();
  });
  it("returns null when there is no edition", async () => {
    mocks.latestPublishedEdition.mockResolvedValue(null);
    await expect(loadOfferEdition()).resolves.toBeNull();
  });
});

describe("sample records", () => {
  const rec = (id: string) =>
    ({
      id,
      name: id,
      facilityType: "data_center",
      operator: "Op",
      status: "operational",
      confidence: "confirmed",
      location: { state: "TX", lat: 1, lon: 2 },
      sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01" }],
      lastUpdated: "2026-01-01",
    }) as never;
  it("hard-codes one id per facility type", () => {
    expect(SAMPLE_FACILITY_IDS).toEqual([
      "meta-hyperion-richland-parish-la",
      "riot-platforms-corsicana-tx",
      "homer-city-energy-campus-generation-pa",
    ]);
  });
  it("picks by id in constant order and skips missing ids", () => {
    const all = [rec("x"), rec("homer-city-energy-campus-generation-pa"), rec("meta-hyperion-richland-parish-la")];
    expect(pickSamples(all).map((r) => (r as { id: string }).id)).toEqual([
      "meta-hyperion-richland-parish-la",
      "homer-city-energy-campus-generation-pa",
    ]);
  });
  it("skips a record that fails schema validation and returns the others parsed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { ...(rec("riot-platforms-corsicana-tx") as object), status: "bogus" } as never;
    const out = pickSamples([rec("meta-hyperion-richland-parish-la"), bad, rec("homer-city-energy-campus-generation-pa")]);
    expect(out.map((r) => r.id)).toEqual(["meta-hyperion-richland-parish-la", "homer-city-energy-campus-generation-pa"]);
    expect(out[0]).toHaveProperty("statusHistory", []);
  });
  it("strips keys the schema does not know", () => {
    const extra = { ...(rec("meta-hyperion-richland-parish-la") as object), internalOnlyKey: "x" } as never;
    expect(pickSamples([extra])[0]).not.toHaveProperty("internalOnlyKey");
  });
  it("loadOfferSamples fails soft to null with a code-only log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockRejectedValue(new Error("Failed query: secret"));
    await expect(loadOfferSamples()).resolves.toBeNull();
    expect(String(log.mock.calls[0]![0])).not.toContain("secret");
  });
  it("exposes headlines, dropping non-strings", () => {
    const e = toOfferEdition({
      editionDate: "2026-11-17",
      recordCount: 1,
      files: [],
      changelogSummary: { headlines: ["Added: A", 3] },
    });
    expect(e.headlines).toEqual(["Added: A"]);
  });
});

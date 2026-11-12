import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { DatasetCounts, datasetCountPhrase, editionChangesLine } from "./dataset-counts";
import type { DatasetCounts as Counts, OfferEdition } from "@/lib/dataset-offer";

const COUNTS: Counts = {
  facilities: 3174,
  dataCenters: 3000,
  cryptoSites: 100,
  powerPlants: 74,
  jurisdictions: 2,
  stateCodes: ["TX", "VA"],
  stateCounts: { TX: 3000, VA: 174 },
  operators: 5,
  sourceLinks: 9,
  asOf: "2026-11-12T01:04:00.000Z",
};

const EDITION: OfferEdition = {
  date: "2026-11-10",
  recordCount: 3154,
  added: 1,
  updated: 2,
  removed: 0,
  initial: false,
  fileBytes: {},
  headlines: [],
};

function text(props: Parameters<typeof DatasetCounts>[0]): string {
  const { container } = render(<DatasetCounts {...props} />);
  return container.textContent ?? "";
}

describe("datasetCountPhrase", () => {
  it("formats the count and the READ date, in the site's date format", () => {
    expect(datasetCountPhrase(COUNTS)).toBe("3,174 sites, counted on 12 November 2026");
    expect(datasetCountPhrase(COUNTS, "facilities")).toBe("3,174 facilities, counted on 12 November 2026");
  });
});

describe("DatasetCounts", () => {
  it("always prints the as-of date with the live count", () => {
    expect(text({ counts: COUNTS })).toBe("3,174 sites, counted on 12 November 2026.");
  });

  it("separates the edition count from the live count when both exist", () => {
    expect(text({ counts: COUNTS, edition: EDITION })).toBe(
      "Latest edition (10 November 2026): 3,154 records. The live site has 3,174 sites, counted on 12 November 2026.",
    );
  });

  it("omits the edition clause when there is no edition", () => {
    const out = text({ counts: COUNTS, edition: null });
    expect(out).not.toContain("edition");
    expect(out).toContain("counted on 12 November 2026");
  });

  it("omits the edition clause when the edition has no record count", () => {
    expect(text({ counts: COUNTS, edition: { ...EDITION, recordCount: null } })).toBe(
      "3,174 sites, counted on 12 November 2026.",
    );
  });

  it("omits the live clause, not the edition, when the live read failed", () => {
    const out = text({ counts: null, edition: EDITION });
    expect(out).toBe("Latest edition (10 November 2026): 3,154 records.");
    expect(out).not.toContain("live");
  });

  it("renders nothing when neither number is known", () => {
    expect(text({ counts: null, edition: null })).toBe("");
  });

  it("dates the read, not the render: the date comes from counts.asOf", () => {
    // A value cached for days keeps its own date whatever 'now' is.
    expect(text({ counts: { ...COUNTS, asOf: "2026-01-05T23:59:59.000Z" } })).toBe(
      "3,174 sites, counted on 5 January 2026.",
    );
  });
});

describe("editionChangesLine", () => {
  it("lists the changes with one separator and a closing period", () => {
    expect(editionChangesLine(EDITION)).toBe("Since the previous edition: 1 added, 2 updated, 0 removed.");
  });

  it("adds nothing for a first edition that has a record count", () => {
    expect(editionChangesLine({ ...EDITION, initial: true })).toBeNull();
  });

  it("carries the edition date itself when there is no record count", () => {
    expect(editionChangesLine({ ...EDITION, recordCount: null })).toBe(
      "Latest edition (10 November 2026): 1 added, 2 updated, 0 removed.",
    );
    expect(editionChangesLine({ ...EDITION, recordCount: null, initial: true })).toBe(
      "Latest edition (10 November 2026).",
    );
  });

  it("omits a clause whose count is missing, and returns null without an edition", () => {
    expect(editionChangesLine({ ...EDITION, removed: null })).toBe("Since the previous edition: 1 added, 2 updated.");
    expect(editionChangesLine(null)).toBeNull();
  });
});

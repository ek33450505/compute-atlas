import { describe, it, expect } from "vitest";
import { CODEBOOK_CONVENTIONS, STABLE_ID_STATEMENT, CODEBOOK_ENTRIES } from "@/lib/dataset-codebook";
import { buildReadme } from "@/lib/dataset-readme";
import { DATASET_LICENSE_URL, siteConfig } from "@/lib/site";

const BASE = {
  editionDate: "2026-11-09",
  editionId: "ed-2026-11-09-abc123",
  recordCount: 2300,
  initial: false,
};

describe("buildReadme", () => {
  it("contains the exact attribution line and license URL", () => {
    const text = buildReadme(BASE);
    expect(text).toContain(
      `Data from Compute Atlas by Edward Kubiak (${siteConfig.url}), licensed under CC BY 4.0 (${DATASET_LICENSE_URL}).`,
    );
    expect(text).toContain("https://creativecommons.org/licenses/by/4.0/");
  });

  it("contains the edition fingerprint line, date and id", () => {
    const text = buildReadme(BASE);
    expect(text).toContain("Edition: 2026-11-09 (ed-2026-11-09-abc123)");
    expect(text).toContain("2,300 records");
  });

  it("states that files may carry recipient-specific identifiers", () => {
    expect(buildReadme(BASE)).toContain("Files may carry recipient-specific identifiers.");
  });

  it("lists every file in the edition", () => {
    const text = buildReadme(BASE);
    for (const f of [
      "facilities.json",
      "facilities.csv",
      "siting-context.json",
      "changelog.json",
      "README.txt",
    ]) {
      expect(text).toContain(f);
    }
  });

  it("documents the CSV conventions", () => {
    const text = buildReadme(BASE).replace(/\s+/g, " ");
    expect(text).toContain("UTF-8 without a BOM");
    expect(text).toContain("RFC 4180");
    expect(text).toContain("CRLF");
    expect(text).toContain("formula");
    expect(text).toContain("a tab or a carriage return");
  });

  it("has a Field definitions section with the stable-id statement and every field", () => {
    const text = buildReadme(BASE);
    expect(text).toContain("\nField definitions\n-----------------\n");
    expect(text.replace(/\s+/g, " ")).toContain(STABLE_ID_STATEMENT);
    const flat = text.replace(/\s+/g, " ");
    for (const line of CODEBOOK_CONVENTIONS) expect(flat).toContain(line);
    for (const e of CODEBOOK_ENTRIES) expect(flat).toContain(`- ${e.path} (`);
    expect(text.indexOf("CSV notes")).toBeLessThan(text.indexOf("Field definitions"));
  });

  it("carries no checksum or hash", () => {
    expect(buildReadme(BASE)).not.toMatch(/sha-?256|checksum|md5|digest/i);
  });

  it("uses LF endings and wraps prose at 80 columns (attribution line excepted)", () => {
    const text = buildReadme({
      ...BASE,
      summary: {
        added: 1,
        updated: 1,
        removed: 0,
        headlines: [
          "Added: A Very Long Facility Name That Goes On And On Past The Wrap Column Of Eighty",
          "Big Site: proposed → operational",
        ],
      },
    });
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    const long = text.split("\n").filter((l) => l.length > 80);
    expect(long).toEqual([expect.stringContaining("Data from Compute Atlas by Edward Kubiak")]);
  });

  it("renders the change summary when given", () => {
    const text = buildReadme({
      ...BASE,
      summary: { added: 2, updated: 1, removed: 0, headlines: ["Added: Foo", "Added: Bar"] },
    });
    expect(text).toContain("2 added, 1 updated, 0 removed");
    expect(text).toContain("Added: Foo");
  });

  it("renders no change counts for the initial edition, only a single line", () => {
    const text = buildReadme({
      ...BASE,
      initial: true,
      summary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 2300 records"] },
    });
    expect(text).not.toContain("Changes since");
    expect(text).not.toContain("0 added");
    expect(text).toContain("Initial edition: 2,300 records.");
  });

  it("renders the change section for a non-initial edition, even with zero counts", () => {
    const text = buildReadme({
      ...BASE,
      initial: false,
      summary: { added: 0, updated: 0, removed: 0, headlines: [] },
    });
    expect(text).toContain("Changes since the previous edition");
    expect(text).toContain("0 added, 0 updated, 0 removed");
    expect(text).not.toContain("Initial edition");
  });

  it("omits the change section when no summary is given", () => {
    expect(buildReadme(BASE)).not.toContain("Changes since the previous edition");
  });

  it("never emits two blank lines in a row", () => {
    expect(buildReadme(BASE)).not.toMatch(/\n\n\n/);
  });

  it("does not claim records are source-verified", () => {
    expect(buildReadme(BASE)).not.toMatch(/source-verified/i);
    expect(buildReadme(BASE)).toContain("source-cited");
  });

  it.each(["2026-13-01", "2026-02-30", "26-11-09", "2026-11-09T00:00:00Z", "", "2026-1-9"])(
    "rejects a malformed edition date %j",
    (editionDate) => {
      expect(() => buildReadme({ ...BASE, editionDate })).toThrow(/editionDate/);
    },
  );

  it.each(["", "has space", "line\nbreak"])("rejects a malformed edition id %j", (editionId) => {
    expect(() => buildReadme({ ...BASE, editionId })).toThrow(/editionId/);
  });

  it.each([-1, 1.5, Number.NaN])("rejects an invalid record count %j", (recordCount) => {
    expect(() => buildReadme({ ...BASE, recordCount })).toThrow(/recordCount/);
  });

  describe("coverage section", () => {
    const rows = [
      { key: "capacityMw.operational", filled: 1200, applicable: 3000, delta: 5 },
      { key: "landAcres", filled: 40, applicable: 3000, delta: -2 },
      { key: "water.coolingType", filled: 9, applicable: 3000, delta: 0 },
      { key: "joinKeys.countyFips", filled: 2999, applicable: 3000, delta: null },
    ];

    it("is absent, and the output unchanged, without coverage", () => {
      expect(buildReadme(BASE)).not.toContain("Coverage");
      expect(buildReadme({ ...BASE, coverage: [] })).toBe(buildReadme(BASE));
    });

    it("lists counts with +, -, 0 and new changes, before the edition footer", () => {
      const text = buildReadme({ ...BASE, coverage: rows });
      expect(text).toContain("\nCoverage\n--------\n");
      expect(text).toContain("  capacityMw.operational  1,200 of 3,000 (+5)");
      expect(text).toContain("  landAcres               40 of 3,000 (-2)");
      expect(text).toContain("  water.coolingType       9 of 3,000 (0)");
      expect(text).toContain("  joinKeys.countyFips     2,999 of 3,000 (new)");
      expect(text.indexOf("Coverage\n")).toBeLessThan(text.indexOf("Edition: 2026-11-09"));
    });

    it("says no change is shown, and prints no change column, when every delta is null", () => {
      const text = buildReadme({ ...BASE, coverage: rows.map((r) => ({ ...r, delta: null })) });
      expect(text).toContain("No earlier edition carries coverage counts, so no change is shown.");
      expect(text).toContain("  landAcres               40 of 3,000\n");
      expect(text).not.toContain("(new)");
    });
  });
});

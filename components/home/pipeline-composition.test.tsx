import { readFileSync } from "node:fs";

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

/**
 * ⚠️ EVERY figure in this fixture is chosen to appear NOWHERE in the real
 * public/data/pipeline-history.json.
 *
 * A fixture that coincides with the live artifact cannot fail: a caption that
 * typed `814` as a literal would still match a fixture whose
 * `excludedNoHistory` happened to be 814, and the test would pass whether the
 * component read the data or not. So: 303 (not 814), 41.7% (not 13.5%), 4103
 * (not 1956), 2077 (not 1142), 61 (not 197), quarters in 2022-2023 rather than
 * 2020-2026. If any of these ever collides with the real artifact after a data
 * wave, CHANGE THE FIXTURE — do not relax the assertions.
 *
 * `statuses` must still be the real keys of STATUS_META, because the whole
 * point of the component is that labels and colors come from there.
 */
const FIXTURE = {
  asOf: "2023-07-02T00:00:00.000Z",
  statuses: [
    "operational",
    "under_construction",
    "permitted",
    "proposed",
    "cancelled",
  ],
  coverage: {
    totalFacilities: 4103,
    withHistory: 2077,
    excludedNoHistory: 303,
    earliestEvent: "1958-04-09",
    latestEvent: "2023-06-30",
    quartersOmitted: 61,
    knownAtStart: 41,
    datePrecision: { year: 133, month: 407, day: 909 },
    unparseableDates: 0,
    ambiguousPeak: {
      quarter: "2023Q2",
      count: 89,
      entry: 55,
      status: 34,
      known: 213,
      share: 41.7,
    },
  },
  quarters: [
    {
      quarter: "2022Q4",
      end: "2022-12-31",
      known: 41,
      ambiguous: 5,
      ambiguousEntry: 3,
      ambiguousStatus: 2,
      counts: {
        operational: 21,
        under_construction: 7,
        permitted: 4,
        proposed: 6,
        cancelled: 3,
      },
    },
    {
      quarter: "2023Q1",
      end: "2023-03-31",
      known: 98,
      ambiguous: 12,
      ambiguousEntry: 8,
      ambiguousStatus: 4,
      counts: {
        operational: 44,
        under_construction: 18,
        permitted: 9,
        proposed: 19,
        cancelled: 8,
      },
    },
    {
      quarter: "2023Q2",
      end: "2023-06-30",
      known: 213,
      ambiguous: 89,
      ambiguousEntry: 55,
      ambiguousStatus: 34,
      counts: {
        operational: 90,
        under_construction: 37,
        permitted: 21,
        proposed: 48,
        cancelled: 17,
      },
      partial: true,
    },
  ],
};

vi.mock("@/public/data/pipeline-history.json", () => ({ default: FIXTURE }));

const { PipelineComposition } = await import("./pipeline-composition");

/** The whole section's text, flattened — captions span nested elements, and
 *  `getByText` sees DIRECT text nodes only. */
function sectionText(): string {
  return screen.getByRole("region").textContent ?? "";
}

describe("PipelineComposition", () => {
  it("renders a labelled section under its own heading", () => {
    render(<PipelineComposition />);
    expect(
      screen.getByRole("heading", { level: 2, name: "What the pipeline was made of" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "What the pipeline was made of" })
    ).toBeInTheDocument();
  });

  /**
   * The assertion two review rounds blocked on. Every figure below is a
   * FIXTURE value, so a literal typed into the component fails here.
   *
   * Mutation-tested: replacing `{fmt(coverage.excludedNoHistory)}` with the
   * real artifact's `814` fails this test on both halves — the expected 303
   * goes missing and the forbidden 814 appears.
   */
  it("reads every coverage figure off the artifact rather than a literal", () => {
    render(<PipelineComposition />);
    const text = sectionText();

    // Phrase-anchored, not bare `toContain("303")`: the sr-only table
    // concatenates adjacent cells, so a loose numeric substring can be
    // satisfied by digits that have nothing to do with the caption.
    expect(text).toMatch(/303 of 4,103 tracked facilities/);
    expect(text).toMatch(/2,077 do\./);
    expect(text).toContain("1958-04-09");

    // The live artifact's own figures must not be able to leak in as literals.
    for (const live of ["814", "1,956", "1,142", "197", "13.5%"]) {
      expect(text).not.toContain(live);
    }
  });

  it("prints the ambiguity peak as one combined share, from the artifact", () => {
    render(<PipelineComposition />);
    // Scoped to the peak SENTENCE, not the whole section. Over the flattened
    // text the sr-only table concatenates adjacent cells ("…3" + "41" reads as
    // "341"), so a bare `not.toContain("34")` fails on a coincidence that has
    // nothing to do with the caption.
    const sentence =
      sectionText().match(/At the worst quarter,[\s\S]*?moves\./)?.[0] ?? "";

    expect(sentence).toContain("2023 Q2");
    expect(sentence).toContain("89 of 213");
    expect(sentence).toContain("41.7%");

    // `ambiguous` is a PARTITION, and its parts only reconcile against the
    // whole at two decimals. The caption prints ONE figure precisely so it
    // cannot print a split that fails to add up — so the parts must be absent
    // and there must be exactly one percentage in the sentence.
    expect(sentence).not.toMatch(/\b55\b/);
    expect(sentence).not.toMatch(/\b34\b/);
    expect(sentence.match(/%/g) ?? []).toHaveLength(1);
  });

  it("discloses the start-of-period bias in the direction the data leans", () => {
    render(<PipelineComposition />);
    const text = sectionText();

    // Both imprecise-date counts, and the total they are a share of —
    // anchored to the sentence so concatenated table digits cannot satisfy
    // them. 1,449 is 133 + 407 + 909, summed by the component, not typed.
    expect(text).toMatch(/Of 1,449 dated status events/);
    expect(text).toMatch(/133 name only a year and 407 only a month/);

    expect(text).toMatch(/start/i);
    expect(text).toMatch(/earlier, faster buildout/i);
  });

  it("discloses the facilities in no quarter at all, and the omitted quarters", () => {
    render(<PipelineComposition />);
    const text = sectionText();
    expect(text).toMatch(/no dated status history and appear in no quarter/i);
    expect(text).toMatch(/omits\s+61\s+earlier quarters/i);
    // The claim has to attach to the OMITTED range. "is double digits" was
    // false of its earliest end; `knownAtStart` (41 here, 77 live) is a
    // ceiling none of the omitted quarters reaches. Reverting the wording, or
    // hardcoding the live 77, fails this.
    expect(text).toMatch(/where the denominator never reaches 41\./);
  });

  it("shows the population growing rather than a share", () => {
    render(<PipelineComposition />);
    const text = sectionText();
    // known: 41 → 213, the denominator the chart is obliged to make visible.
    // Phrase-anchored rather than a bare `toContain("41")`, which the table's
    // concatenated digits would satisfy on their own.
    expect(text).toMatch(/41 facilities at 2022 Q4, 213 at 2023 Q2/);
    expect(text).toMatch(/nothing here is drawn as a share/i);
  });

  it("stacks raw counts, in the artifact's status order, with STATUS_META labels", () => {
    render(<PipelineComposition />);
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent)
    ).toEqual([
      "Quarter",
      "Operational",
      "Under construction",
      "Permitted",
      "Proposed",
      "Cancelled",
      "Total",
    ]);

    const rows = within(table)
      .getAllByRole("rowheader")
      .map((header) => {
        const row = header.closest("tr") as HTMLElement;
        return [
          header.textContent ?? "",
          ...within(row)
            .getAllByRole("cell")
            .map((cell) => cell.textContent ?? ""),
        ];
      });

    // Counts, never percentages — and the totals are the per-quarter `known`.
    expect(rows).toEqual([
      ["2022 Q4", "21", "7", "4", "6", "3", "41"],
      ["2023 Q1", "44", "18", "9", "19", "8", "98"],
      ["2023 Q2 (quarter in progress)", "90", "37", "21", "48", "17", "213"],
    ]);
  });

  it("paints the bands with the shared status palette, not invented hues", () => {
    const { container } = render(<PipelineComposition />);
    expect(
      Array.from(container.querySelectorAll("polygon")).map((p) => p.getAttribute("fill"))
    ).toEqual(["#0072B2", "#B45309", "#007A53", "#9D2C6F", "#6B7280"]);
  });

  it("renders the quarter in progress as provisional, not as a closed quarter", () => {
    const { container } = render(<PipelineComposition />);
    expect(
      container.querySelectorAll('line[stroke-dasharray="4 3"]')
    ).toHaveLength(1);
    expect(sectionText()).toMatch(/still in progress/i);
  });

  it("ships no dark-mode utilities", () => {
    const { container } = render(<PipelineComposition />);
    expect(container.innerHTML).not.toMatch(/\bdark:/);
  });

  /**
   * A load-bearing invariant with no other guard: a `"use client"` anywhere in
   * this subtree would ship the 27-quarter artifact to the browser twice —
   * once in the bundle and once in the RSC payload — on the phones the
   * homepage budget exists to protect.
   *
   * Asserted against the SOURCE, not the render: a client boundary changes
   * nothing observable in jsdom, so no amount of querying the output can
   * detect it. A failing version of this check is literally one line — adding
   * `"use client";` to the top of either file makes it red.
   */
  it("declares no client boundary anywhere in the chart subtree", () => {
    for (const file of ["./pipeline-composition.tsx", "../chart/stack-area.tsx"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("links out to the methodology", () => {
    render(<PipelineComposition />);
    expect(screen.getByRole("link", { name: "the methodology" })).toHaveAttribute(
      "href",
      "/methodology"
    );
  });
});

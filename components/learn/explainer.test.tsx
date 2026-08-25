import { vi, describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { Explainer } from "./explainer";
import type { GlossaryExplainer } from "@/lib/glossary";
import type { DataCenterFacility } from "@/lib/schema";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

/** Minimal data-center Facility stub with required fields, mirroring
 * components/facility/civic-impact.test.tsx's makeFacility. */
function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "resolved-facility-tx",
    name: "Resolved Facility",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 1, lon: -1, city: "Testville", state: "TX", precision: "exact" },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/source",
        label: "Test source",
        retrievedAt: "2024-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-06-01",
    community: {
      status: "opposed",
      notes: "Neighbors said the turbines run all night.",
    },
    ...overrides,
  };
}

const RESOLVED_FACILITY = makeFacility();

const EXPLAINER: GlossaryExplainer = {
  lede: "Test lede sentence describing why communities push back.",
  sections: [
    {
      heading: "Section One",
      evidence: "substantiated",
      sourceIds: ["src-a"],
      // One id resolves via the exemplars map, one does not.
      exemplarIds: ["resolved-facility-tx", "missing-facility-id"],
      body: ["Paragraph one of section one.", "Paragraph two of section one."],
    },
    {
      heading: "Section Two",
      evidence: "raised-not-substantiated",
      sourceIds: [],
      // Neither id resolves — the section should render with no exemplar list.
      exemplarIds: ["missing-facility-id", "another-missing-id"],
      body: ["Paragraph for section two."],
    },
    {
      heading: "Section Three",
      evidence: "raised",
      sourceIds: [],
      // No exemplarIds key at all.
      body: ["Paragraph for section three."],
    },
  ],
  sources: [
    {
      id: "src-a",
      label: "Source A Label",
      publisher: "Publisher A",
      url: "https://example.com/source-a",
      verifiedAt: "2026-08-25",
      note: "A helpful note.",
    },
    {
      id: "src-b",
      label: "Source B Label",
      publisher: "Publisher B",
      url: "https://example.com/source-b",
      verifiedAt: "2026-08-25",
    },
  ],
};

const EXEMPLARS = new Map([[RESOLVED_FACILITY.id, RESOLVED_FACILITY]]);

describe("Explainer", () => {
  it("renders the lede and every section heading", () => {
    render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />);

    expect(screen.getByText(EXPLAINER.lede)).toBeInTheDocument();
    for (const section of EXPLAINER.sections) {
      expect(
        screen.getByRole("heading", { level: 2, name: section.heading })
      ).toBeInTheDocument();
    }
  });

  it("labels each section as an accessible region via its own heading (aria-labelledby)", () => {
    render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />);

    for (const section of EXPLAINER.sections) {
      expect(screen.getByRole("region", { name: section.heading })).toBeInTheDocument();
    }
  });

  it("renders an exemplar's verbatim note in a blockquote and links to /facilities/<id>", () => {
    render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />);

    expect(screen.getByRole("link", { name: "Resolved Facility" })).toHaveAttribute(
      "href",
      "/facilities/resolved-facility-tx"
    );

    const quote = screen.getByText("Neighbors said the turbines run all night.");
    expect(quote.tagName.toLowerCase()).toBe("blockquote");
  });

  it("drops an exemplar id that does not resolve, without throwing", () => {
    expect(() =>
      render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />)
    ).not.toThrow();

    // Section One mixes one resolvable id with one unresolvable id — only
    // the resolvable facility renders, and the section's list has exactly
    // one item.
    const sectionOneList = screen.getByRole("list", {
      name: "Facilities in the record: Section One",
    });
    expect(within(sectionOneList).getAllByRole("listitem")).toHaveLength(1);

    // Section Two has exemplarIds that ALL fail to resolve — zero resolved
    // exemplars means no list renders at all for that section (not an empty one).
    expect(
      screen.queryByRole("list", { name: "Facilities in the record: Section Two" })
    ).not.toBeInTheDocument();

    // Section Three never declares exemplarIds — same "no list" outcome.
    expect(
      screen.queryByRole("list", { name: "Facilities in the record: Section Three" })
    ).not.toBeInTheDocument();
  });

  it("renders the raised-not-substantiated evidence label on its section", () => {
    render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />);

    expect(
      screen.getByText("Raised by residents · not substantiated by the cited review")
    ).toBeInTheDocument();
  });

  it("gives every source link an href, rel=noreferrer noopener, and an opens-in-new-tab aria-label", () => {
    render(<Explainer explainer={EXPLAINER} exemplars={EXEMPLARS} />);

    for (const source of EXPLAINER.sources) {
      const link = screen.getByRole("link", {
        name: `${source.label} (opens in new tab)`,
      });
      expect(link).toHaveAttribute("href", source.url);
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
      expect(link).toHaveAttribute("target", "_blank");
    }

    // The note renders only for the source that has one.
    expect(screen.getByText("A helpful note.")).toBeInTheDocument();
    expect(
      screen.getAllByText((text) =>
        text.startsWith("Quote located in the served document on 2026-08-25")
      )
    ).toHaveLength(2);
  });
});

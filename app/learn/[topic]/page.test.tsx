import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { GLOSSARY_TOPICS, getGlossaryTopicBySlug } from "@/lib/glossary";
import type { DataCenterFacility } from "@/lib/schema";
import { AI_CLASSIFICATION_ENTRIES } from "@/lib/ai-classification";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetWaterUsage,
  mockGetCoolingTypeCounts,
  mockGetStats,
  mockGetFacilityTypeCounts,
  mockGetEnergySourceCounts,
  mockGetAiClassificationCounts,
  mockGetGenerationStats,
  mockGetCommunityReceptionCounts,
  mockGetFacilitiesByIds,
} = vi.hoisted(() => ({
  mockGetWaterUsage: vi.fn(),
  mockGetCoolingTypeCounts: vi.fn(),
  mockGetStats: vi.fn(),
  mockGetFacilityTypeCounts: vi.fn(),
  mockGetEnergySourceCounts: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetGenerationStats: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  mockGetFacilitiesByIds: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getWaterUsage: mockGetWaterUsage,
  getCoolingTypeCounts: mockGetCoolingTypeCounts,
  getStats: mockGetStats,
  getFacilityTypeCounts: mockGetFacilityTypeCounts,
  getEnergySourceCounts: mockGetEnergySourceCounts,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getGenerationStats: mockGetGenerationStats,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getFacilitiesByIds: mockGetFacilitiesByIds,
}));

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

import LearnTopicPage, { generateMetadata } from "./page";

const EMPTY_COOLING_COUNTS = {
  evaporative: 0,
  air: 0,
  closed_loop: 0,
  hybrid: 0,
  unknown: 0,
};

const EMPTY_ENERGY_COUNTS = {
  grid: 0,
  on_site_gas: 0,
  nuclear: 0,
  solar: 0,
  wind: 0,
  hydro: 0,
  mixed: 0,
  other: 0,
};

const EMPTY_RECEPTION_COUNTS = {
  supported: 0,
  mixed: 0,
  contested: 0,
  opposed: 0,
  litigation: 0,
  unknown: 0,
};

beforeEach(() => {
  mockGetWaterUsage.mockReset().mockResolvedValue({ reportingCount: 0, totalMgd: 0 });
  mockGetCoolingTypeCounts.mockReset().mockResolvedValue(EMPTY_COOLING_COUNTS);
  mockGetStats.mockReset().mockResolvedValue({
    count: 0,
    states: 0,
    operationalMw: 0,
    plannedMw: 0,
    underConstructionMw: 0,
  });
  mockGetFacilityTypeCounts.mockReset().mockResolvedValue({
    data_center: 0,
    crypto_mining: 0,
    power_generation: 0,
  });
  mockGetEnergySourceCounts.mockReset().mockResolvedValue(EMPTY_ENERGY_COUNTS);
  mockGetAiClassificationCounts.mockReset().mockResolvedValue({
    confirmed: 0,
    likely: 0,
    mixed_use: 0,
  });
  mockGetGenerationStats.mockReset().mockResolvedValue({
    count: 0,
    operationalMw: 0,
    plannedMw: 0,
    offtakerCount: 0,
  });
  mockGetCommunityReceptionCounts.mockReset().mockResolvedValue(EMPTY_RECEPTION_COUNTS);
  mockGetFacilitiesByIds.mockReset().mockResolvedValue([]);
});

describe("LearnTopicPage", () => {
  it("renders the topic's H1 and dek for every registered glossary slug", async () => {
    // Water-use topic — the only slug whose content path this default mock
    // set (all-zero counts) fully covers without further stubbing.
    const topic = getGlossaryTopicBySlug("data-center-water-use")!;

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: topic.slug }),
    });
    render(page);

    expect(
      screen.getByRole("heading", { level: 1, name: topic.title })
    ).toBeInTheDocument();
    expect(screen.getByText(topic.dek)).toBeInTheDocument();
  });

  it("renders dataset-derived stat values from getWaterUsage, not a fabricated figure", async () => {
    mockGetWaterUsage.mockResolvedValue({ reportingCount: 3, totalMgd: 12.5 });
    mockGetCoolingTypeCounts.mockResolvedValue({
      ...EMPTY_COOLING_COUNTS,
      closed_loop: 2,
      air: 1,
    });

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "data-center-water-use" }),
    });
    render(page);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Facilities reporting")).toBeInTheDocument();
    expect(screen.getByText("12.5 MGD")).toBeInTheDocument();
    expect(screen.getByText("Total reported")).toBeInTheDocument();
  });

  it("derives the what-is-an-ai-data-center stat labels from AI_CLASSIFICATION_ENTRIES, not a hand-written copy", async () => {
    mockGetAiClassificationCounts.mockResolvedValue({
      confirmed: 5,
      likely: 3,
      mixed_use: 2,
    });

    // Pinned literally — deliberately NOT derived from the same import the
    // component consumes — so a drift in lib/ai-classification.ts's TIERS
    // labels, or a regression back to a hand-written copy that goes stale,
    // fails this test instead of being silently absorbed.
    expect(AI_CLASSIFICATION_ENTRIES).toHaveLength(3);
    expect(AI_CLASSIFICATION_ENTRIES.map((e) => e.label)).toEqual([
      "Confirmed",
      "Likely",
      "Mixed use",
    ]);

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "what-is-an-ai-data-center" }),
    });
    const { container } = render(page);

    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    // Order matters (confirmed -> likely -> mixed_use, per TIER_ORDER) —
    // check DOM order, not just presence, since the row has no roles/testids.
    const text = container.textContent ?? "";
    const confirmedIdx = text.indexOf("Confirmed");
    const likelyIdx = text.indexOf("Likely");
    const mixedIdx = text.indexOf("Mixed use");
    expect(confirmedIdx).toBeGreaterThan(-1);
    expect(likelyIdx).toBeGreaterThan(confirmedIdx);
    expect(mixedIdx).toBeGreaterThan(likelyIdx);
  });

  it("cross-links to the power generation hub on the behind-the-meter-power topic", async () => {
    mockGetGenerationStats.mockResolvedValue({
      count: 4,
      operationalMw: 500,
      plannedMw: 1000,
      offtakerCount: 2,
    });

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "behind-the-meter-power" }),
    });
    render(page);

    expect(screen.getByRole("link", { name: /power generation hub/ })).toHaveAttribute(
      "href",
      "/power"
    );
  });

  it("renders dataset-derived stat values from getGenerationStats on why-connect-to-the-grid, not a fabricated figure", async () => {
    mockGetGenerationStats.mockResolvedValue({
      count: 4,
      operationalMw: 500,
      plannedMw: 1000,
      offtakerCount: 2,
    });

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "why-connect-to-the-grid" }),
    });
    render(page);

    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("500 MW")).toBeInTheDocument();
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("1.0 GW")).toBeInTheDocument();
    expect(screen.getByText("Planned")).toBeInTheDocument();
  });

  it("falls back to a zero-count explainer sentence on why-connect-to-the-grid when no generation projects are tracked", async () => {
    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "why-connect-to-the-grid" }),
    });
    render(page);

    expect(
      screen.getByText("No dedicated power-generation projects are tracked yet.")
    ).toBeInTheDocument();
  });

  it("cross-links to the power generation hub on the why-connect-to-the-grid topic", async () => {
    mockGetGenerationStats.mockResolvedValue({
      count: 4,
      operationalMw: 500,
      plannedMw: 1000,
      offtakerCount: 2,
    });

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: "why-connect-to-the-grid" }),
    });
    render(page);

    expect(screen.getByRole("link", { name: /power generation hub/ })).toHaveAttribute(
      "href",
      "/power"
    );
  });

  it("calls notFound (throws) for a slug that isn't in the glossary registry", async () => {
    await expect(
      LearnTopicPage({ params: Promise.resolve({ topic: "not-a-real-topic" }) })
    ).rejects.toThrow();

    expect(mockGetWaterUsage).not.toHaveBeenCalled();
  });
});

/** Minimal data-center Facility stub, mirroring components/facility/civic-impact.test.tsx's makeFacility. */
function makeFacility(overrides: Partial<DataCenterFacility> = {}): DataCenterFacility {
  return {
    id: "arizona-land-consulting-hassayampa-ranch-tonopah-az",
    name: "Arizona Land Consulting — Hassayampa Ranch",
    operator: "Arizona Land Consulting",
    status: "proposed",
    facilityType: "data_center",
    aiClassification: "likely",
    confidence: "reported",
    location: { lat: 33.5, lon: -112.9, city: "Tonopah", state: "AZ", precision: "exact" },
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
    ...overrides,
  };
}

describe("LearnTopicPage explainer wiring", () => {
  const EXPLAINER_TOPIC = getGlossaryTopicBySlug("why-do-communities-oppose-data-centers")!;

  it("renders the cited explainer's lede, sections, and a resolved exemplar", async () => {
    const facility = makeFacility();
    mockGetFacilitiesByIds.mockResolvedValue([facility]);

    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: EXPLAINER_TOPIC.slug }),
    });
    render(page);

    expect(screen.getByText(EXPLAINER_TOPIC.explainer!.lede)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Sources" })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: facility.name })).toHaveAttribute(
      "href",
      `/facilities/${facility.id}`
    );
  });

  it("collects every section's exemplarIds into exactly one deduped getFacilitiesByIds call", async () => {
    const page = await LearnTopicPage({
      params: Promise.resolve({ topic: EXPLAINER_TOPIC.slug }),
    });
    render(page);

    expect(mockGetFacilitiesByIds).toHaveBeenCalledTimes(1);
    const requestedIds = mockGetFacilitiesByIds.mock.calls[0][0] as string[];
    const expectedIds = [
      ...new Set(
        EXPLAINER_TOPIC.explainer!.sections.flatMap((s) => s.exemplarIds ?? [])
      ),
    ];
    expect([...requestedIds].sort()).toEqual([...expectedIds].sort());
  });

  // Every topic now carries a cited explainer. This replaces the earlier guard
  // that asserted the other four had none — inverted rather than deleted, so the
  // wiring stays pinned for all five rather than only the first one shipped.
  it.each(GLOSSARY_TOPICS)(
    "$slug renders its cited explainer's lede and sources",
    async ({ slug }) => {
      const topic = getGlossaryTopicBySlug(slug)!;
      expect(topic.explainer).toBeDefined();

      const page = await LearnTopicPage({ params: Promise.resolve({ topic: slug }) });
      render(page);

      expect(screen.getByText(topic.explainer!.lede)).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 2, name: "Sources" })
      ).toBeInTheDocument();

      for (const section of topic.explainer!.sections) {
        expect(
          screen.getByRole("heading", { level: 2, name: section.heading })
        ).toBeInTheDocument();
      }
    }
  );

  // The exemplar fetch is batched: one call when the topic names any exemplarIds,
  // and no call at all when it names none (page.tsx skips the query entirely).
  it.each(GLOSSARY_TOPICS)(
    "$slug fetches exemplars in one batched call, or not at all",
    async ({ slug }) => {
      const topic = getGlossaryTopicBySlug(slug)!;
      const expectedIds = [
        ...new Set(topic.explainer!.sections.flatMap((s) => s.exemplarIds ?? [])),
      ];

      const page = await LearnTopicPage({ params: Promise.resolve({ topic: slug }) });
      render(page);

      if (expectedIds.length === 0) {
        expect(mockGetFacilitiesByIds).not.toHaveBeenCalled();
        return;
      }

      expect(mockGetFacilitiesByIds).toHaveBeenCalledTimes(1);
      const requestedIds = mockGetFacilitiesByIds.mock.calls[0][0] as string[];
      expect([...requestedIds].sort()).toEqual([...expectedIds].sort());
    }
  );
});

describe("generateMetadata (learn topic)", () => {
  it.each(GLOSSARY_TOPICS)(
    "$slug: title/description match the registry and canonical is /learn/$slug",
    async ({ slug, title, dek }) => {
      const metadata = await generateMetadata({
        params: Promise.resolve({ topic: slug }),
      });

      expect(metadata.title).toBe(title);
      expect(metadata.description).toBe(dek);
      expect(metadata.alternates).toEqual({ canonical: `/learn/${slug}` });
    }
  );

  it("returns a not-found title for an unknown topic slug", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ topic: "not-a-real-topic" }),
    });

    expect(metadata).toEqual({ title: "Topic not found" });
  });
});

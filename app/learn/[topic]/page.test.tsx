import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { GLOSSARY_TOPICS, getGlossaryTopicBySlug } from "@/lib/glossary";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetWaterUsage,
  mockGetCoolingTypeCounts,
  mockGetStats,
  mockGetEnergySourceCounts,
  mockGetAiClassificationCounts,
  mockGetGenerationStats,
  mockGetCommunityReceptionCounts,
} = vi.hoisted(() => ({
  mockGetWaterUsage: vi.fn(),
  mockGetCoolingTypeCounts: vi.fn(),
  mockGetStats: vi.fn(),
  mockGetEnergySourceCounts: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetGenerationStats: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getWaterUsage: mockGetWaterUsage,
  getCoolingTypeCounts: mockGetCoolingTypeCounts,
  getStats: mockGetStats,
  getEnergySourceCounts: mockGetEnergySourceCounts,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getGenerationStats: mockGetGenerationStats,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
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

  it("calls notFound (throws) for a slug that isn't in the glossary registry", async () => {
    await expect(
      LearnTopicPage({ params: Promise.resolve({ topic: "not-a-real-topic" }) })
    ).rejects.toThrow();

    expect(mockGetWaterUsage).not.toHaveBeenCalled();
  });
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

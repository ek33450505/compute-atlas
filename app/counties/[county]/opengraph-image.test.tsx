// @vitest-environment node
import { vi, describe, it, expect } from "vitest";

const { mockGetCountyBySlug, mockGetFacilitiesByCounty, mockRenderCard, mockRenderFallback } =
  vi.hoisted(() => ({
    mockGetCountyBySlug: vi.fn(),
    mockGetFacilitiesByCounty: vi.fn(),
    mockRenderCard: vi.fn(),
    mockRenderFallback: vi.fn(),
  }));

vi.mock("@/lib/data", () => ({
  getCountyBySlug: mockGetCountyBySlug,
  getFacilitiesByCounty: mockGetFacilitiesByCounty,
}));

vi.mock("@/lib/og-theme", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/og-theme")>()),
  loadFrauncesFont: () => Buffer.from(""),
  renderOgFallbackCard: mockRenderFallback,
}));

vi.mock("@/lib/og-collection-card", () => ({
  renderOgCollectionCard: mockRenderCard,
}));

import OGImage, { size, contentType } from "./opengraph-image";

const params = (county: string) => ({ params: Promise.resolve({ county }) });

describe("county opengraph-image", () => {
  it("declares a 1200x630 PNG", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("builds a state-qualified card from the loader's facilities", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetCountyBySlug.mockResolvedValue({ slug: "loudoun-va", name: "Loudoun", state: "VA" });
    mockGetFacilitiesByCounty.mockResolvedValue([
      { capacityMw: { operational: 1200, planned: 300 } },
      { capacityMw: { operational: 300 } },
      { capacityMw: { planned: 100 } },
    ]);

    const response = await OGImage(params("loudoun-va"));

    expect(await response.text()).toBe("card");
    expect(mockGetCountyBySlug).toHaveBeenCalledWith("loudoun-va");
    expect(mockGetFacilitiesByCounty).toHaveBeenCalledWith("loudoun-va");
    expect(mockRenderFallback).not.toHaveBeenCalled();
    const args = mockRenderCard.mock.calls[0][0];
    expect(args.overline).toBe("COUNTY PROFILE");
    expect(args.headline).toBe("Loudoun County, Virginia");
    expect(args.size).toEqual({ width: 1200, height: 630 });
    expect(args.stats).toEqual([
      { value: "3", label: "FACILITIES" },
      { value: "1.5 GW", label: "OPERATIONAL" },
      { value: "400 MW", label: "PLANNED" },
    ]);
  });

  it("uses the Louisiana and Alaska county-equivalent names", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetFacilitiesByCounty.mockResolvedValue([]);

    mockGetCountyBySlug.mockResolvedValue({ slug: "orleans-la", name: "Orleans", state: "LA" });
    await OGImage(params("orleans-la"));
    mockGetCountyBySlug.mockResolvedValue({ slug: "kenai-ak", name: "Kenai Peninsula", state: "AK" });
    await OGImage(params("kenai-ak"));

    expect(mockRenderCard.mock.calls[0][0].headline).toBe("Orleans Parish, Louisiana");
    expect(mockRenderCard.mock.calls[1][0].headline).toBe("Kenai Peninsula Borough, Alaska");
  });

  it("falls back to the site card for an unknown county, without throwing", async () => {
    mockRenderFallback.mockReturnValue(new Response("fallback"));
    mockGetCountyBySlug.mockResolvedValue(undefined);

    const response = await OGImage(params("nowhere-zz"));

    expect(await response.text()).toBe("fallback");
    expect(mockGetFacilitiesByCounty).not.toHaveBeenCalled();
    expect(mockRenderCard).not.toHaveBeenCalled();
  });
});

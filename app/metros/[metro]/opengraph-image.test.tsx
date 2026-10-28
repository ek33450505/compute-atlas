// @vitest-environment node
import { vi, describe, it, expect } from "vitest";

const { mockGetFacilitiesByMetro, mockRenderCard, mockRenderFallback } = vi.hoisted(() => ({
  mockGetFacilitiesByMetro: vi.fn(),
  mockRenderCard: vi.fn(),
  mockRenderFallback: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByMetro: mockGetFacilitiesByMetro,
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

const params = (metro: string) => ({ params: Promise.resolve({ metro }) });

describe("metro opengraph-image", () => {
  it("declares a 1200x630 PNG", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("builds the card from the loader's facilities", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetFacilitiesByMetro.mockResolvedValue([
      { capacityMw: { operational: 800, planned: 2000 } },
      { capacityMw: { planned: 500 } },
    ]);

    const response = await OGImage(params("northern-virginia"));

    expect(await response.text()).toBe("card");
    expect(mockGetFacilitiesByMetro).toHaveBeenCalledWith("northern-virginia");
    expect(mockRenderFallback).not.toHaveBeenCalled();
    const args = mockRenderCard.mock.calls[0][0];
    expect(args.overline).toBe("METRO AREA");
    expect(args.headline).toBe("Northern Virginia");
    expect(args.size).toEqual({ width: 1200, height: 630 });
    expect(args.stats).toEqual([
      { value: "2", label: "FACILITIES" },
      { value: "800 MW", label: "OPERATIONAL" },
      { value: "2.5 GW", label: "PLANNED" },
    ]);
  });

  it("falls back to the site card for an unknown metro, without throwing", async () => {
    mockRenderFallback.mockReturnValue(new Response("fallback"));

    const response = await OGImage(params("not-a-metro"));

    expect(await response.text()).toBe("fallback");
    expect(mockGetFacilitiesByMetro).not.toHaveBeenCalled();
    expect(mockRenderCard).not.toHaveBeenCalled();
  });
});

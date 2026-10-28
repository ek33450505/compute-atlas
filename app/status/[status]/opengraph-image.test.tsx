// @vitest-environment node
import { vi, describe, it, expect } from "vitest";

const { mockGetFacilitiesByStatus, mockRenderCard, mockRenderFallback } = vi.hoisted(() => ({
  mockGetFacilitiesByStatus: vi.fn(),
  mockRenderCard: vi.fn(),
  mockRenderFallback: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilitiesByStatus: mockGetFacilitiesByStatus,
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

const params = (status: string) => ({ params: Promise.resolve({ status }) });

const FACILITIES = [
  { capacityMw: { operational: 600, planned: 100 } },
  { capacityMw: { operational: 900, planned: 1500 } },
];

describe("status opengraph-image", () => {
  it("declares a 1200x630 PNG", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("shows operational capacity for the operational status", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    const response = await OGImage(params("operational"));

    expect(await response.text()).toBe("card");
    expect(mockGetFacilitiesByStatus).toHaveBeenCalledWith("operational");
    const args = mockRenderCard.mock.calls[0][0];
    expect(args.overline).toBe("BY STATUS");
    expect(args.headline).toBe("Operational");
    expect(args.size).toEqual({ width: 1200, height: 630 });
    expect(args.stats).toEqual([
      { value: "2", label: "SITES" },
      { value: "1.5 GW", label: "OPERATIONAL CAPACITY" },
    ]);
  });

  it("shows planned capacity for a pre-operational status", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    await OGImage(params("under_construction"));

    const args = mockRenderCard.mock.calls[0][0];
    expect(args.headline).toBe("Under construction");
    expect(args.stats).toEqual([
      { value: "2", label: "SITES" },
      { value: "1.6 GW", label: "PLANNED CAPACITY" },
    ]);
  });

  it("labels a cancelled project's capacity as cancelled", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetFacilitiesByStatus.mockResolvedValue(FACILITIES);

    await OGImage(params("cancelled"));

    const args = mockRenderCard.mock.calls[0][0];
    expect(args.headline).toBe("Cancelled");
    expect(args.stats[1]).toEqual({ value: "1.6 GW", label: "PLANNED CAPACITY (CANCELLED)" });
  });

  it.each(["bogus", "OPERATIONAL", "under-construction", "__proto__", "constructor"])(
    "falls back to the site card for the invalid status %j, without throwing",
    async (raw) => {
      mockRenderFallback.mockReturnValue(new Response("fallback"));

      const response = await OGImage(params(raw));

      expect(await response.text()).toBe("fallback");
      expect(mockGetFacilitiesByStatus).not.toHaveBeenCalled();
      expect(mockRenderCard).not.toHaveBeenCalled();
    }
  );
});

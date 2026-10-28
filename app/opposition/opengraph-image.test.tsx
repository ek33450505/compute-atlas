// @vitest-environment node
import { vi, describe, it, expect } from "vitest";

const { mockGetCommunityReceptionCounts, mockRenderCard, mockRenderFallback } = vi.hoisted(
  () => ({
    mockGetCommunityReceptionCounts: vi.fn(),
    mockRenderCard: vi.fn(),
    mockRenderFallback: vi.fn(),
  })
);

vi.mock("@/lib/data", async (importOriginal) => ({
  // The real getFrictionTotal: pure arithmetic over the mocked counts.
  getFrictionTotal: (await importOriginal<typeof import("@/lib/data")>()).getFrictionTotal,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
}));

// A sentinel in place of the real headline: a consumer that hard-codes the
// string instead of importing OPPOSITION_HEADLINE cannot satisfy the assertion.
vi.mock("@/lib/community", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/community")>()),
  OPPOSITION_HEADLINE: "SENTINEL HEADLINE",
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

describe("opposition opengraph-image", () => {
  it("declares a 1200x630 PNG", () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
  });

  it("builds the card from the reception counts, not hard-coded figures", async () => {
    mockRenderCard.mockReturnValue(new Response("card"));
    mockGetCommunityReceptionCounts.mockResolvedValue({
      supported: 40,
      mixed: 9,
      contested: 5,
      opposed: 7,
      litigation: 3,
      unknown: 12,
    });

    const response = await OGImage();

    expect(await response.text()).toBe("card");
    expect(mockRenderFallback).not.toHaveBeenCalled();
    const args = mockRenderCard.mock.calls[0][0];
    expect(args.overline).toBe("COMMUNITY RESPONSE");
    expect(args.headline).toBe("SENTINEL HEADLINE");
    expect(args.size).toEqual({ width: 1200, height: 630 });
    // Friction = contested + opposed + litigation; supported/mixed/unknown excluded.
    expect(args.stats).toEqual([
      { value: "15", label: "FRICTION SITES" },
      { value: "3", label: "IN LITIGATION" },
    ]);

    mockGetCommunityReceptionCounts.mockResolvedValue({
      contested: 1,
      opposed: 1,
      litigation: 20,
    });
    await OGImage();
    expect(mockRenderCard.mock.calls[1][0].stats).toEqual([
      { value: "22", label: "FRICTION SITES" },
      { value: "20", label: "IN LITIGATION" },
    ]);
  });

  it("falls back to the site card when no friction is on file, without throwing", async () => {
    mockRenderFallback.mockReturnValue(new Response("fallback"));
    mockGetCommunityReceptionCounts.mockResolvedValue({
      supported: 4,
      mixed: 0,
      contested: 0,
      opposed: 0,
      litigation: 0,
      unknown: 0,
    });

    const response = await OGImage();

    expect(await response.text()).toBe("fallback");
    expect(mockRenderCard).not.toHaveBeenCalled();
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";

import { loadFrauncesFont } from "@/lib/og-theme";
import { renderOgCollectionCard } from "./og-collection-card";

const SITE = { name: "Compute Atlas", url: "https://www.compute-atlas.com" };
const SIZE = { width: 1200, height: 630 };
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("renderOgCollectionCard", () => {
  // Rendering for real is the point: satori rejects layouts that break its
  // flexbox rules (a multi-child div without display:flex), and that only
  // surfaces when the body is read.
  async function render(stats: { value: string; label: string }[]) {
    const response = renderOgCollectionCard({
      overline: "COUNTY PROFILE",
      headline: "Prince George's County, Maryland",
      stats,
      fraunces: loadFrauncesFont(),
      site: SITE,
      size: SIZE,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { response, bytes };
  }

  it("returns a 1200x630 PNG for three stat blocks", async () => {
    const { response, bytes } = await render([
      { value: "12", label: "SITES" },
      { value: "1.4 GW", label: "OPERATIONAL" },
      { value: "300 MW", label: "PLANNED PIPELINE" },
    ]);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    // IHDR width/height sit big-endian at bytes 16-23.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });

  it("renders with a single stat block", async () => {
    const { bytes } = await render([{ value: "3", label: "SITES" }]);
    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
  });
});

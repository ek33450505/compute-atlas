import { describe, it, expect } from "vitest";

import { NAV_LINKS } from "./site-header";

// ---------------------------------------------------------------------------
// SiteHeader itself is an async Server Component (calls buildNavSearchIndex,
// which reads the live dataset) — not rendered here. This asserts the desktop
// nav config directly: NAV_LINKS is what SiteHeader passes to both
// PrimaryNav and CommandPalette, so covering its shape covers both surfaces
// without needing to render either.
// ---------------------------------------------------------------------------

describe("SiteHeader — NAV_LINKS", () => {
  it("includes a Contribute entry pointing at /contribute", () => {
    const contribute = NAV_LINKS.find((link) => link.label === "Contribute");
    expect(contribute).toBeDefined();
    expect(contribute?.href).toBe("/contribute");
  });

  it("places Contribute after Activity and before About", () => {
    const labels = NAV_LINKS.map((link) => link.label);
    const activityIndex = labels.indexOf("Activity");
    const contributeIndex = labels.indexOf("Contribute");
    const aboutIndex = labels.indexOf("About");

    expect(activityIndex).toBeGreaterThanOrEqual(0);
    expect(contributeIndex).toBe(activityIndex + 1);
    expect(aboutIndex).toBe(contributeIndex + 1);
  });
});

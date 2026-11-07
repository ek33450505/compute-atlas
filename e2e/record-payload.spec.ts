import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Record-payload guard — a facility page must not serialize the full record
// into the RSC flight payload (leak audit F1a, 2026-11-07).
// ---------------------------------------------------------------------------
//
// The mini-map is the only client component on /facilities/[slug] that takes
// facility data as a prop, so whatever it is handed lands in the HTML. It now
// receives `toMiniMapFacility(facility)` (name, status, location) only. The
// keys below exist only in a serialized record (they are JSON keys, which the
// rendered prose never prints), so their presence means a full record crossed
// the server/client boundary again. `postalCode` is deliberately NOT here:
// lib/seo.ts emits it into the facility JSON-LD for records that have one.
//
// Fetches RAW SSR HTML via `request.get`, never a hydrated DOM: the flight
// payload is stripped from the DOM after hydration, so a DOM check would
// always pass.
const ROUTE = "/facilities/meta-prineville-or";
const RECORD_ONLY_KEYS = ["statusHistory", "retrievedAt", "confidence"];

test.describe("facility page record payload", () => {
  test(`${ROUTE} does not serialize the full record`, async ({ request }) => {
    const response = await request.get(ROUTE);
    expect(response.status()).toBe(200);
    const html = await response.text();

    // Sanity: this is the facility page and it carries the flight payload.
    expect(html).toContain("self.__next_f");
    for (const key of RECORD_ONLY_KEYS) {
      expect(html, `raw HTML contains the record key "${key}"`).not.toContain(`"${key}"`);
      expect(html, `raw HTML contains the escaped record key "${key}"`).not.toContain(`\\"${key}\\"`);
    }
  });
});

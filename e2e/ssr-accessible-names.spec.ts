import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Accessible-names guard — catches buttons with no accessible name in SSR HTML.
// ---------------------------------------------------------------------------
//
// Root cause (fixed in branch fix/facility-masthead-cta): Base UI's `render`
// prop does NOT server-render the children of the element handed to it. A
// button passed as `trigger={<button className="…">Spot an error?</button>}` to
// a Base UI component would render as `<button …></button>` (empty), with the
// label appearing only after client hydration (React logged a hydration
// mismatch). Measured on a facility page: 4 of its 11 buttons reached the
// served HTML with NO accessible name at all; after the fix, 0 did.
//
// This spec uses Playwright with JavaScript disabled to fetch and parse the
// raw server-rendered HTML via the browser's native parser (not regex). This
// ensures the spec tests the actual SSR output without any client-side
// hydration that would mask the bug. The browser's HTML parser is correct
// where a regex cannot be — it properly handles attributes with `>` chars,
// nested markup, and edge cases.
//
// The spec fetches raw SSR HTML for a small set of routes and fails if any
// `<button>` element has empty text content AND no aria-label/aria-labelledby.
// Legitimate empty buttons (e.g., icon buttons with aria-label) are exempted
// because they carry an accessible name via the attribute.

// Disable JavaScript so Playwright fetches and parses raw SSR HTML only,
// never executing React hydration.
test.use({ javaScriptEnabled: false });

// Routes that render the affected components:
// - `/facilities/meta-prineville-or`: renders SuggestCorrection's masthead
//   trigger (the primary site), FieldGapPrompt, and ConfirmFactPrompt
// - `/gaps`: renders FieldGapPrompt
// - `/states/texas`: renders WatchButton
const ROUTES = [
  "/facilities/meta-prineville-or",
  "/gaps",
  "/states/texas",
] as const;

for (const route of ROUTES) {
  test(`${route} has no buttons without accessible names in SSR`, async ({
    page,
  }) => {
    const res = await page.goto(route);
    expect(res?.status()).toBe(200);

    // Use the browser's HTML parser (via evaluateAll) to find all button
    // elements. Filter for those with no accessible name.
    const offenders = await page.locator("button").evaluateAll((btns) =>
      btns
        .filter((b) => {
          const textContent = (b.textContent ?? "").trim();
          const hasAriaLabel = b.getAttribute("aria-label");
          const hasAriaLabelledby = b.getAttribute("aria-labelledby");
          // Button lacks an accessible name if text is empty AND no aria attrs.
          return !textContent && !hasAriaLabel && !hasAriaLabelledby;
        })
        .map((b) => b.outerHTML.slice(0, 160))
    );

    expect(
      offenders,
      `on route ${route}: found ${offenders.length} button(s) without accessible name:\n${offenders.map((tag) => `  ${tag}`).join("\n")}`
    ).toHaveLength(0);
  });
}

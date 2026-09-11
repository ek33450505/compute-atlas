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
// This spec differs from unit tests (jsdom `render()` calls in sibling test
// files) because jsdom never performs server-side rendering — the JSX children
// materialize identically whether or not they're passed through Base UI's
// `render` prop. Unit tests pass even when the bug is present. Only raw
// server HTML exposes it.
//
// The spec fetches raw SSR HTML for a small set of routes and fails if any
// `<button>` element has empty text content AND no aria-label/aria-labelledby.
// Legitimate empty buttons (e.g., icon buttons with aria-label) are exempted
// because they carry an accessible name via the attribute.

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

/**
 * Parse buttons from raw SSR HTML and report those with no accessible name.
 * A button has an accessible name if:
 *   - Its text content (tags stripped) is non-empty, OR
 *   - It carries aria-label or aria-labelledby
 */
function findButtonsWithoutAccessibleName(html: string): Array<{
  route: string;
  tag: string;
}> {
  const results: Array<{ route: string; tag: string }> = [];

  // Extract all <button>...</button> blocks. This regex captures opening tag
  // + content + closing tag. The opening tag may span multiple lines or contain
  // attributes with newlines.
  const buttonRegex =
    /<button[\s\S]*?>([\s\S]*?)<\/button>/gi;

  let match;
  while ((match = buttonRegex.exec(html)) !== null) {
    const openingTagMatch = /<button[^>]*>/i.exec(match[0]);
    if (!openingTagMatch) continue;

    const openingTag = openingTagMatch[0];
    const content = match[1];

    // Check if the button has aria-label or aria-labelledby
    const hasAriaLabel =
      /\baria-label\s*=/i.test(openingTag) ||
      /\baria-labelledby\s*=/i.test(openingTag);

    // Strip HTML tags from content and trim
    const textContent = content.replace(/<[^>]*>/g, "").trim();

    // Fail if both conditions hold: no text + no aria attribute
    if (textContent === "" && !hasAriaLabel) {
      results.push({ route: "", tag: openingTag });
    }
  }

  return results;
}

for (const route of ROUTES) {
  test(`${route} has no buttons without accessible names in SSR`, async ({
    request,
  }) => {
    const response = await request.get(route);
    expect(response.status()).toBe(200);

    const html = await response.text();
    const offenders = findButtonsWithoutAccessibleName(html);

    const offenderList = offenders
      .map((o) => `  ${o.tag}`)
      .join("\n");

    expect(
      offenders,
      `found ${offenders.length} button(s) without accessible name on ${route}:\n${offenderList}`
    ).toHaveLength(0);
  });
}

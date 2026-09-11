import { test, expect, type Page } from "@playwright/test";

// A facility page has two audiences: someone reading it on screen, and
// someone printing it to cite. This spec pins the printed one — the only
// place it can be pinned, because every screen assertion in the suite passes
// identically whether the print rules work or not. `print:hidden` in a class
// list is not evidence that anything was hidden; `emulateMedia` is.
//
// Geometry: Letter at 96dpi is 816x1056 CSS px, so the viewport is pinned to
// that rather than the project's default desktop size. The height ceilings
// below are page-width-sensitive and only mean anything at this width.
test.use({ viewport: { width: 816, height: 1056 } });

const BASE = "https://www.compute-atlas.com";

// Two ends of the dataset: the thinnest record and the richest one. A print
// stylesheet that only works on sparse records isn't a print stylesheet.
const RECORDS = [
  {
    slug: "microsoft-becker-mn",
    name: "Microsoft Becker Data Center",
    // Thinnest record. Print-media container height was 1994px over 2 printed
    // pages before the stat sheet existed, 877px over 1 page with it, then
    // 1025px over 2 once empty sections each printed their own nil line;
    // consolidating those into one line brings it to 941px, still 2 pages.
    // One page needs ~920px — the flip was measured between 906.7px (1 page)
    // and 922.2px (2), well below the 942.6px the @page margins arithmetically
    // leave — so the remaining ~20px is a print-stylesheet question, not a
    // nil-marker one. The ceiling sits well above the achieved height so
    // ordinary data growth doesn't turn this red, while any regression that
    // restores the screen rhythm (measured at 1943px with the compaction
    // disabled) fails it.
    maxHeight: 1200,
  },
  {
    slug: "fermi-matador-amarillo-tx",
    name: "Project Matador",
    // Richest record in the dataset: was 4273px over 5 printed pages, now
    // 2158px over 3. Disabling the compaction measures 4007px.
    maxHeight: 2600,
  },
] as const;

/**
 * The print-only provenance block, located by the text it exists to print
 * rather than by a test hook.
 */
function provenanceFooter(page: Page, name: string) {
  return page.locator("aside").filter({ hasText: `Compute Atlas — ${name}` });
}

/** Elements Playwright reports as visible, counted in the current media. */
async function visibleCount(page: Page, selector: string): Promise<number> {
  const all = page.locator(selector);
  const total = await all.count();
  let visible = 0;
  for (let i = 0; i < total; i++) {
    if (await all.nth(i).isVisible()) visible++;
  }
  return visible;
}

for (const record of RECORDS) {
  test.describe(`${record.slug} printed brief`, () => {
    test("drops navigation and interactive chrome in print", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);
      await page.emulateMedia({ media: "print" });

      // Breadcrumb trail: a screen wayfinding device. The printout carries
      // its canonical URL in the provenance footer instead.
      await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeHidden();

      // Global site header + footer (banner / contentinfo landmarks). The
      // facility page's own <header> lives inside <main> and is not a banner.
      await expect(page.getByRole("banner")).toBeHidden();
      await expect(page.getByRole("contentinfo")).toBeHidden();

      // Nothing clickable survives — every CTA, prompt and map control is an
      // affordance that cannot be used on paper.
      expect(await visibleCount(page, "button")).toBe(0);
    });

    test("prints a provenance footer that makes the page citable", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);
      await page.emulateMedia({ media: "print" });

      const footer = provenanceFooter(page, record.name);
      await expect(footer).toBeVisible();

      // Canonical URL in full — a printout with no address is not a citation.
      await expect(footer).toContainText(`${BASE}/facilities/${record.slug}`);

      // Licence as a URL, not link text: a printed link has no href.
      await expect(footer).toContainText("CC-BY-4.0");
      await expect(footer).toContainText("https://creativecommons.org/licenses/by/4.0/");

      // Curation date of the record itself, distinct from the print date.
      await expect(footer).toContainText(/Record last updated \d{4}-\d{2}-\d{2}/);

      // The print date is filled client-side on purpose (the page is
      // statically rendered with `revalidate = false`, so a server-rendered
      // date would be the build date wearing a print date's label).
      await expect(footer).toContainText(/Printed \d{4}-\d{2}-\d{2}/);
    });

    test("keeps the provenance footer off the screen rendering", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);
      await page.emulateMedia({ media: "screen" });

      const footer = provenanceFooter(page, record.name);
      // Attached but not visible — asserting only `toBeHidden` would also
      // pass if the footer had been deleted outright.
      await expect(footer).toHaveCount(1);
      await expect(footer).toBeHidden();
    });

    test("typesets materially shorter than the screen layout", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);
      await page.emulateMedia({ media: "print" });

      const height = await page
        .locator("[data-print-brief]")
        .evaluate((el) => Math.round(el.getBoundingClientRect().height));

      expect(height).toBeLessThan(record.maxHeight);
    });

    test("keeps every cited source, with its URL expanded", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);

      const sources = page.locator("[data-print-sources] ul[aria-label='Sources'] > li");
      const onScreen = await sources.count();
      expect(onScreen).toBeGreaterThan(0);

      await page.emulateMedia({ media: "print" });

      // Compression is by type size and leading only — no citation is
      // dropped to make the page fit.
      expect(await visibleCount(page, "[data-print-sources] ul[aria-label='Sources'] > li")).toBe(
        onScreen
      );

      // The ::after URL expansion is generated content, so it is invisible to
      // the accessibility tree and to textContent — read it off the computed
      // style of the first citation link instead.
      const expanded = await page
        .locator("[data-print-sources] a[href]")
        .first()
        .evaluate((el) => getComputedStyle(el, "::after").content);
      expect(expanded).toContain("http");
    });
  });
}

// ---------------------------------------------------------------------------
// Empty fields print an explicit nil.
//
// On screen an empty slot holds a working invite ("Know the capacity?"), which
// is `print:hidden` — so the printed stat sheet used to render the label over
// whitespace, and on a document meant to be cited a blank reads as ZERO rather
// than UNKNOWN. This is the only place the fallback can be pinned: the unit
// tests in components/contribute/field-gap-prompt.test.tsx can see the marker
// in the DOM but not in the media it exists for, because jsdom evaluates no
// `@media print`.
//
// microsoft-becker-mn is the thinnest record in the dataset: no capacity, no
// poweredBy, no announcedDate — three empty slots in Key facts alone.
// ---------------------------------------------------------------------------

const NIL_MARKER = "Not recorded";

/**
 * The consolidated section-level nil line, exactly as it must print for
 * microsoft-becker-mn. Derived from the record itself: it has a
 * siting-context entry and 295 landAcres (so neither is named), and nothing
 * at all for the five sections that are.
 *
 * Pinned as the WHOLE string on purpose — a summary that renders but names
 * the wrong sections is the failure mode this line exists to catch, and a
 * substring assertion would pass for a line that named all seven.
 */
const BECKER_SECTION_NIL =
  "Not recorded: power supply, energy and water, air permit, public subsidies, stakeholders.";

/**
 * The summary line, located by the hook its own print stylesheet uses
 * (app/globals.css) rather than by the text under test.
 */
function sectionNilSummary(page: Page) {
  return page.locator("[data-print-gap-summary]");
}

/** The Key facts dt/dd pair whose label reads `label`. */
function keyFactRow(page: Page, label: string) {
  return page
    .locator("section[aria-labelledby='key-facts-heading'] dl > div")
    .filter({ hasText: label });
}

test.describe("microsoft-becker-mn empty fields", () => {
  test("prints an explicit nil in the slot the screen fills with an invite", async ({ page }) => {
    await page.goto("/facilities/microsoft-becker-mn");
    await page.emulateMedia({ media: "print" });

    const capacity = keyFactRow(page, "Capacity");
    await expect(capacity).toHaveCount(1);
    await expect(capacity.getByText(NIL_MARKER)).toBeVisible();

    // The invite it stands in for is an affordance — unusable on paper, and
    // the reason the slot was blank in the first place.
    await expect(capacity.getByRole("button")).toBeHidden();

    // FieldGapPrompt has two return paths and both had to be covered:
    // `capacityOperationalMw` above is in CORRECTABLE_KEYS and renders a
    // correction trigger; `investmentUsd` is not, and renders the lead-form
    // link instead. A fallback added to only one branch prints half the sheet.
    const investment = page
      .locator("section[aria-labelledby^='civic-impact'] dl > div")
      .filter({ hasText: "Investment" });
    await expect(investment).toHaveCount(1);
    await expect(investment.getByText(NIL_MARKER)).toBeVisible();

    // Section-level gaps take the other shape. A whole-group gap replaces its
    // own heading, so a per-section marker printed as an orphan sentence with
    // nothing above it — five of them on this record, enough to push the
    // thinnest page in the dataset onto a second sheet. They are consolidated
    // into one line above the provenance footer instead.
    const summary = sectionNilSummary(page);
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText(BECKER_SECTION_NIL);

    // The per-section markers it replaced must be gone — carrying both would
    // print the same gap twice.
    await expect(page.getByText(`${NIL_MARKER}: energy or water data`)).toHaveCount(0);
  });

  test("names only the sections this record is actually missing", async ({ page }) => {
    await page.goto("/facilities/microsoft-becker-mn");
    await page.emulateMedia({ media: "print" });

    const summary = sectionNilSummary(page);
    await expect(summary).toBeVisible();

    // Both of these sections DO render on this record — a summary that named
    // them would be asserting the page's own content is absent. This is the
    // half an exact-text match alone reads as arbitrary: siting context is
    // populated from data/siting-context.json, economic impact from the
    // record's 295 landAcres.
    await expect(page.locator("h2", { hasText: "Siting context" })).toBeVisible();
    await expect(summary).not.toContainText("siting context");
    await expect(page.locator("h3", { hasText: "Economics" })).toBeVisible();
    await expect(summary).not.toContainText("economic impact");
  });

  test("keeps the nil marker off the screen rendering", async ({ page }) => {
    await page.goto("/facilities/microsoft-becker-mn");
    await page.emulateMedia({ media: "screen" });

    const capacity = keyFactRow(page, "Capacity");
    // Attached but not visible — asserting only `toBeHidden` would also pass
    // if the marker had never been rendered at all. `display: none` is also
    // what keeps it out of the screen accessibility tree.
    await expect(capacity.getByText(NIL_MARKER)).toHaveCount(1);
    await expect(capacity.getByText(NIL_MARKER)).toBeHidden();

    // Same for the consolidated section line: attached, never shown on screen.
    const summary = sectionNilSummary(page);
    await expect(summary).toHaveCount(1);
    await expect(summary).toBeHidden();

    // Screen keeps the working invite instead, everywhere on the page.
    await expect(capacity.getByRole("button", { name: /know the capacity\?/i })).toBeVisible();
    expect(await visibleCount(page, `text=${NIL_MARKER}`)).toBe(0);
  });
});

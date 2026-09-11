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
    // pages before the stat sheet existed; it is 877px over 1 page now. The
    // ceiling sits well above the achieved height so ordinary data growth on
    // the record doesn't turn this red, while any regression that restores
    // the screen rhythm (measured at 1943px with the compaction disabled)
    // fails it.
    maxHeight: 1200,
  },
  {
    slug: "fermi-matador-amarillo-tx",
    name: "Project Matador",
    // Richest record in the dataset: was 4273px over 5 printed pages, now
    // 1992px over 3. Disabling the compaction measures 4007px.
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

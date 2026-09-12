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
    // Thinnest record, and the one the compaction is tuned against: 2 printed
    // pages before, 1 now, with ~48px of slack before it flips back (measured
    // by appending a spacer until the page count changed).
    printedPages: { exactly: 1 },
    // Secondary signal only — see the note on `countPdfPages` for why this
    // number is NOT the printed height. Deliberately left well above the
    // ~896px achieved so ordinary data growth doesn't turn it red, while a
    // regression that restores the screen rhythm (1943px with the compaction
    // disabled) still trips it.
    maxHeight: 1200,
  },
  {
    slug: "fermi-matador-amarillo-tx",
    name: "Project Matador",
    // Richest record in the dataset: was 4273px over 5 printed pages, now
    // 2099px over 3. Disabling the compaction measures 4007px. Bounded rather
    // than exact — this record accretes sources, and a 4th page is a design
    // question, not a broken stylesheet.
    printedPages: { atMost: 3 },
    maxHeight: 2600,
  },
] as const;

/**
 * Pages the record actually prints on, from Chromium's own print pipeline.
 *
 * This replaces a height ceiling, which was a proxy — and a biased one. The
 * container height read under `emulateMedia({ media: "print" })` is laid out
 * at the VIEWPORT width (816px), but Chrome paginates at the @page CONTENT
 * width (816px less the horizontal margins). The narrower column wraps more
 * lines, so the printed document is taller than the measured number: on
 * microsoft-becker-mn the gap was 941.9px measured vs 977.6px printed. A
 * ceiling tuned on the measured figure can therefore pass a document that
 * prints on two pages, which is the only thing anyone cares about here.
 *
 * `page.pdf()` is Chromium-only. This spec runs exclusively under the
 * "chromium" project — playwright.config.ts scopes "Mobile Chrome" to
 * `map-mobile.spec.ts` via `testMatch` — so no per-test browser guard is
 * needed. It also requires headless; a `--headed` run will fail loudly rather
 * than skip, which is the right trade for a check that exists to be trusted.
 */
async function countPdfPages(page: Page): Promise<number> {
  const pdf = await page.pdf({ format: "Letter", printBackground: false });
  // Count /Type /Page objects, excluding /Pages (the tree node) via [^s].
  return (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
}

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

    test("prints on the expected number of pages", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);

      const pages = await countPdfPages(page);

      if ("exactly" in record.printedPages) {
        // Exact, not a ceiling: on the thinnest record in the dataset, "at
        // most 1" and "exactly 1" are the same assertion, but stating it as
        // equality is what makes the intent survive the next edit.
        expect(pages).toBe(record.printedPages.exactly);
      } else {
        // A bound still has to have a floor. `<= 3` alone would pass for a
        // zero-page count, which is what a broken PDF pipeline returns.
        expect(pages).toBeGreaterThan(0);
        expect(pages).toBeLessThanOrEqual(record.printedPages.atMost);
      }
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

    // The invariant, not a count: a bare "Not recorded" says nothing on its
    // own, so every one of them must have a labelling <dt> beside it. An
    // unlabelled marker is exactly the defect — SubsidiesGroup rendered its
    // group-level gap prompt outside any dt/dd pair, and it printed as an
    // orphan sentence under Civic impact saying nothing, on every record in
    // the dataset. Counting markers would have passed; so would reading the
    // JSX. Only the rendered output showed it.
    //
    // A count ceiling was rejected for the usual reason: it is a proxy. It
    // goes red when the data changes and stays green when the labelling
    // breaks, which is backwards.
    test("prints no nil marker without a label beside it", async ({ page }) => {
      await page.goto(`/facilities/${record.slug}`);
      await page.emulateMedia({ media: "print" });

      const markers = await page.evaluate(() => {
        const found: { label: string; html: string }[] = [];
        for (const el of document.querySelectorAll("*")) {
          // Leaf elements whose whole text is the bare marker. Exact match on
          // purpose: the consolidated summary line reads "Not recorded: power
          // supply, ..." and is self-naming, so it is legitimately label-free
          // and must not be swept in here.
          if (el.children.length > 0) continue;
          if ((el.textContent || "").trim() !== "Not recorded") continue;
          if (getComputedStyle(el).display === "none") continue;

          const dd = el.closest("dd");
          const dt = dd?.parentElement?.querySelector("dt");
          found.push({
            label: dt ? (dt.textContent || "").trim() : "",
            html: el.outerHTML.slice(0, 120),
          });
        }
        return found;
      });

      // Non-vacuity. Both records carry several genuine field-level gaps, so
      // an empty result means the query stopped matching, not that the page
      // got cleaner — and an assertion that cannot fail is worth nothing.
      expect(markers.length).toBeGreaterThan(0);

      expect(markers.filter((m) => m.label === "")).toEqual([]);
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

// ---------------------------------------------------------------------------
// The nil marker belongs to the facility brief, and nowhere else.
//
// FieldGapPrompt is not facility-page-only: /gaps renders one per example
// card, six dimensions deep. That page is nothing BUT gaps — its premise is
// that every row is missing something, and it has no dt/dd grid to label a
// marker against — so while the print variant sat on the element as a
// `print:inline` utility class it was unscoped, and /gaps printed 36 bare
// "Not recorded" lines across 7 pages (measured from a real PDF, 2026-09-11).
// The rule now lives in app/globals.css under `[data-print-brief]`, which
// /gaps does not carry, so the marker renders in the DOM here and prints
// nowhere.
//
// This can only be pinned here, twice over: jsdom evaluates no `@media
// print`, and the defect was a stylesheet SCOPE rather than markup, so the
// component's own DOM looks identical either way.
// ---------------------------------------------------------------------------
test.describe("/gaps printed", () => {
  test("prints no nil marker — every row on the page is already a gap", async ({ page }) => {
    await page.goto("/gaps");

    // Non-vacuity, in screen media first: the markers must still be RENDERED
    // here. Without this, "none visible in print" would pass just as happily
    // for a /gaps that had stopped rendering gap prompts at all, or for a
    // selector that had quietly stopped matching anything.
    expect(await page.locator("[data-print-nil]").count()).toBeGreaterThan(0);

    await page.emulateMedia({ media: "print" });

    // Two independent detectors, because they fail differently: the hook
    // catches the marker being un-scoped again, and the text sweep catches a
    // marker reintroduced by some other route that never carries the hook.
    expect(await visibleCount(page, "[data-print-nil]")).toBe(0);
    expect(await visibleCount(page, `text=${NIL_MARKER}`)).toBe(0);
  });

  test("still prints the gaps themselves", async ({ page }) => {
    await page.goto("/gaps");

    // The example cards, located by the facility link each one is built
    // around rather than by its utility classes.
    const CARD = "li:has(a[href^='/facilities/'])";
    const onScreen = await page.locator(CARD).count();
    expect(onScreen).toBeGreaterThan(0);

    await page.emulateMedia({ media: "print" });

    // The scoping removes a redundant marker, not the page. Its heading and
    // every example card still print exactly as they did before.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await visibleCount(page, CARD)).toBe(onScreen);
  });
});

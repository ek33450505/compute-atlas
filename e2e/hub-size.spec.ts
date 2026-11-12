import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Hub size budget — /operators, /counties, /stakeholders, /power and /opposition must stay small as data grows
// (audit U-11, 2026-11-11: 2,726 KB and 1,595 KB against `/` at 330 KB).
// ---------------------------------------------------------------------------
//
// Playwright, not Vitest: the cost that matters is the DECODED server
// response, which includes the RSC flight payload that repeats the rendered
// content. jsdom never sees that payload; only a real server response does.
//
// CI runs on the ~68-record fixture, where even a full-list page is small:
// the byte ceilings below CANNOT catch a regression to the old layout there;
// only a run against the real snapshot does. On the fixture the assertions
// that still bite are that the letter/state links are present, that the
// fullest page stays within chrome + rows x bytes/row, and the per-row slope
// across sub-views where the spread is wide enough to compute it (otherwise
// it is annotated as skipped). Two further
// checks make the budget scale to the real 1,500+ operators: a cap on rows per
// document, and a cap on bytes per row. Rows x bytes/row <= budget, at any
// dataset size. Bytes are measured from raw HTML via `request.get`, never a
// hydrated DOM (hydration strips the flight payload).
const BUDGET_BYTES = 500 * 1024;
const MAX_ROWS_PER_DOCUMENT = 250;
const MAX_BYTES_PER_ROW = BUDGET_BYTES / MAX_ROWS_PER_DOCUMENT;
// Fixed per-document cost outside the rows; measured ~85 KB on both hubs, 2026-11-12.
const PAGE_CHROME_BYTES = 120 * 1024;

// Hubs with a by-state nav, summary sections or charts carry more fixed weight
// than the A–Z hubs. Measured 2026-11-12 on the real 3,174-record snapshot as
// (bytes of the fullest page) - (its rows x MAX_BYTES_PER_ROW), i.e. the weight
// outside the rows: /opposition ?state=va 199 KB with 42 rows -> ~115 KB;
// /power default 316 KB with 58 rows -> ~200 KB (state nav ~50 KB, charts, and
// the offtaker summary, which the page caps at 25 lines so it cannot grow).
// Allowances are the measurement plus ~15% headroom.
// `param` is the query key that selects a sub-view: `letter` for the A–Z
// hubs, `state` for the by-state hubs (/power, /opposition).
const HUBS = [
  { path: "/operators", param: "letter", rowHref: /href="\/operators\/[^"?#]+"/g },
  { path: "/counties", param: "letter", rowHref: /href="\/counties\/[^"?#]+"/g },
  { path: "/stakeholders", param: "letter", rowHref: /href="\/stakeholders\/[^"?#]+"/g },
  { path: "/power", param: "state", chromeBytes: 230 * 1024, rowHref: /href="\/facilities\/[^"?#]+"/g },
  { path: "/opposition", param: "state", chromeBytes: 135 * 1024, rowHref: /href="\/facilities\/[^"?#]+"/g },
];

for (const { path, param, rowHref, chromeBytes = PAGE_CHROME_BYTES } of HUBS) {
  test.describe(`${path} size budget`, () => {
    test("bare path and every sub-view fit the budget", async ({ request }) => {
      const bare = await request.get(path);
      expect(bare.status()).toBe(200);
      const bareHtml = await bare.text();

      const letterHrefs = [
        ...new Set(
          [...bareHtml.matchAll(new RegExp(`href="(${path}\\?${param}=[a-z]+)"`, "g"))].map(
            (m) => m[1],
          ),
        ),
      ];
      expect(letterHrefs.length, "the index links to at least one sub-view").toBeGreaterThan(0);

      const pages: { url: string; bytes: number; rows: number }[] = [];
      for (const url of [path, ...letterHrefs]) {
        const html = url === path ? bareHtml : await (await request.get(url)).text();
        const bytes = Buffer.byteLength(html, "utf8");
        const rows = new Set(html.match(rowHref) ?? []).size;
        pages.push({ url, bytes, rows });

        expect(bytes, `${url} is ${bytes} bytes`).toBeLessThanOrEqual(BUDGET_BYTES);
        expect(rows, `${url} lists ${rows} rows`).toBeLessThanOrEqual(MAX_ROWS_PER_DOCUMENT);
      }

      // Bytes per row, unconditional: the fullest page may weigh at most a
      // fixed allowance for page chrome (layout, masthead, stat row, flight
      // boilerplate) plus MAX_BYTES_PER_ROW for each row it lists. A page that
      // lists no rows at all cannot be costed, so that fails loudly rather
      // than skipping. On the ~68-record CI fixture the fullest page lists a
      // few dozen rows, so this bounds the per-row cost there too, at the
      // price of a coarse bound (the chrome allowance absorbs a small page).
      const big = [...pages].sort((a, b) => b.rows - a.rows)[0];
      expect(big.rows, `${path} pages list no rows`).toBeGreaterThan(0);
      expect(
        big.bytes,
        `${big.url}: ${big.bytes} bytes for ${big.rows} rows`,
      ).toBeLessThanOrEqual(chromeBytes + big.rows * MAX_BYTES_PER_ROW);

      // With enough spread between sub-views, also check the marginal cost of
      // a row (slope between the fullest and emptiest sub-view), free of
      // chrome. The default view is left out: it carries summary sections the
      // sub-views do not, so its extra bytes are not row cost. When the
      // sub-views are too alike to give a slope, say so in the report rather
      // than skip silently.
      const subViews = pages.filter((p) => p.url !== path);
      const bigSub = [...subViews].sort((a, b) => b.rows - a.rows)[0];
      const smallSub = [...subViews].sort((a, b) => a.rows - b.rows)[0];
      if (bigSub.rows - smallSub.rows >= 10) {
        const perRow = (bigSub.bytes - smallSub.bytes) / (bigSub.rows - smallSub.rows);
        expect(perRow, `${path} costs ${Math.round(perRow)} bytes per row`).toBeLessThanOrEqual(
          MAX_BYTES_PER_ROW,
        );
      } else {
        test.info().annotations.push({
          type: "slope-check-skipped",
          description: `${path}: sub-views list ${smallSub.rows}-${bigSub.rows} rows (spread < 10), too alike to cost a row`,
        });
      }
    });

    test("an invalid sub-view falls back to the default view", async ({ request }) => {
      const identity = (html: string) => ({
        h1: html.match(/<h1[^>]*>[\s\S]*?<\/h1>/)?.[0],
        canonical: html.match(/<link rel="canonical"[^>]*>/)?.[0],
        rows: (html.match(rowHref) ?? []).slice(0, 5),
      });
      const bare = identity(await (await request.get(path)).text());
      expect(bare.h1, `${path} has an h1`).toBeTruthy();
      expect(bare.canonical, `${path} has a canonical link`).toBeTruthy();
      for (const q of ["zz", "%00", "../x", "", "%C4%B1a"]) {
        const response = await request.get(`${path}?${param}=${q}`);
        expect(response.status(), `?${param}=${q}`).toBe(200);
        // Same page, not merely a 200: same h1, same canonical, same first rows.
        expect(identity(await response.text()), `?${param}=${q}`).toEqual(bare);
      }
    });
  });
}

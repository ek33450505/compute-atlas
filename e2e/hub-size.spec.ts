import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Hub size budget — /operators and /counties must stay small as data grows
// (audit U-11, 2026-11-11: 2,726 KB and 1,595 KB against `/` at 330 KB).
// ---------------------------------------------------------------------------
//
// Playwright, not Vitest: the cost that matters is the DECODED server
// response, which includes the RSC flight payload that repeats the rendered
// content. jsdom never sees that payload; only a real server response does.
//
// CI runs on the 68-record fixture, where a full-list page would still be
// small, so a byte ceiling alone passes while the bug is present. Two further
// checks make the budget scale to the real 1,500+ operators: a cap on rows per
// document, and a cap on bytes per row. Rows x bytes/row <= budget, at any
// dataset size. Bytes are measured from raw HTML via `request.get`, never a
// hydrated DOM (hydration strips the flight payload).
const BUDGET_BYTES = 500 * 1024;
const MAX_ROWS_PER_DOCUMENT = 250;
const MAX_BYTES_PER_ROW = BUDGET_BYTES / MAX_ROWS_PER_DOCUMENT;
// Fixed per-document cost outside the rows; measured ~85 KB on both hubs, 2026-11-12.
const PAGE_CHROME_BYTES = 120 * 1024;

const HUBS = [
  { path: "/operators", rowHref: /href="\/operators\/[^"?#]+"/g },
  { path: "/counties", rowHref: /href="\/counties\/[^"?#]+"/g },
];

for (const { path, rowHref } of HUBS) {
  test.describe(`${path} size budget`, () => {
    test("bare path and every letter page fit the budget", async ({ request }) => {
      const bare = await request.get(path);
      expect(bare.status()).toBe(200);
      const bareHtml = await bare.text();

      const letterHrefs = [
        ...new Set(
          [...bareHtml.matchAll(new RegExp(`href="(${path}\\?letter=[a-z]+)"`, "g"))].map(
            (m) => m[1],
          ),
        ),
      ];
      expect(letterHrefs.length, "the index links to at least one letter page").toBeGreaterThan(0);

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
      ).toBeLessThanOrEqual(PAGE_CHROME_BYTES + big.rows * MAX_BYTES_PER_ROW);

      // With enough spread between pages, also check the marginal cost of a
      // row (slope between fullest and emptiest page), free of chrome.
      const small = [...pages].sort((a, b) => a.rows - b.rows)[0];
      if (big.rows - small.rows >= 10) {
        const perRow = (big.bytes - small.bytes) / (big.rows - small.rows);
        expect(perRow, `${path} costs ${Math.round(perRow)} bytes per row`).toBeLessThanOrEqual(
          MAX_BYTES_PER_ROW,
        );
      }
    });

    test("an invalid letter falls back to the default view", async ({ request }) => {
      for (const q of ["zz", "%00", "../x", ""]) {
        const response = await request.get(`${path}?letter=${q}`);
        expect(response.status(), `?letter=${q}`).toBe(200);
      }
    });
  });
}

import { test, expect } from "@playwright/test";

/**
 * Evidence harness for the segmented sitemap (unit 1b-ii): a sitemap index at
 * `/sitemap.xml` plus one child `<urlset>` per route family at
 * `/sitemaps/<family>.xml`. Uses Playwright's `request` fixture (raw HTTP)
 * throughout, deliberately not `page.goto` — these are XML/text HTTP
 * responses, not rendered pages, and a hydrated DOM would tell us nothing a
 * raw fetch doesn't already.
 *
 * Kept to this one file: the cold Playwright build already eats 187s of a
 * 240s CI budget (playwright.config.ts), so this spec fetches only what each
 * assertion needs and adds no per-test rebuild.
 */

const SITEMAP_FAMILY_IDS = [
  "static",
  "learn",
  "states",
  "operators",
  "stakeholders",
  "facilities",
  "status",
  "metros",
  "counties",
] as const;

test("GET /sitemap.xml — 200, xml content-type, well-formed index with one <sitemap> per family", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("xml");

  const body = await response.text();
  expect(body).toContain("<sitemapindex");
  const sitemapEntryCount = (body.match(/<sitemap>/g) ?? []).length;
  expect(sitemapEntryCount).toBe(SITEMAP_FAMILY_IDS.length);
});

test("every <loc> in the sitemap index is fetchable and serves a well-formed <urlset>", async ({
  request,
}) => {
  const indexResponse = await request.get("/sitemap.xml");
  const indexBody = await indexResponse.text();
  const locs = [...indexBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  // Pin the count too: if <loc> extraction silently found nothing, the loop
  // below would vacuously pass with zero iterations.
  expect(locs).toHaveLength(SITEMAP_FAMILY_IDS.length);

  for (const loc of locs) {
    const url = new URL(loc);
    const childResponse = await request.get(url.pathname);
    expect(childResponse.status(), `${loc} should be fetchable`).toBe(200);
    const childBody = await childResponse.text();
    expect(childBody, `${loc} should serve a <urlset>`).toContain("<urlset");
  }
});

test("GET /sitemaps/bogus.xml — 404", async ({ request }) => {
  const response = await request.get("/sitemaps/bogus.xml");
  expect(response.status()).toBe(404);
});

test("GET /robots.txt — Sitemap: line for the index and for every family child", async ({
  request,
}) => {
  const response = await request.get("/robots.txt");
  expect(response.status()).toBe(200);
  const body = await response.text();

  const sitemapLines = body
    .split("\n")
    .filter((line) => line.startsWith("Sitemap:"))
    .map((line) => line.replace("Sitemap:", "").trim());

  expect(sitemapLines.some((line) => line.endsWith("/sitemap.xml"))).toBe(true);
  for (const id of SITEMAP_FAMILY_IDS) {
    expect(sitemapLines.some((line) => line.endsWith(`/sitemaps/${id}.xml`))).toBe(true);
  }
});

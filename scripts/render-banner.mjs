/**
 * Rasterise docs/media/banner.svg to banner.png at 2x for the README.
 *
 * GitHub renders SVG in a README, but strips the embedded @font-face, so the
 * wordmark would fall back to a system serif. Shipping a PNG keeps Fraunces.
 *
 *   python3 scripts/make-banner.py && node scripts/render-banner.mjs
 *
 * Uses the Playwright Chromium already installed for the e2e suite.
 */
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = path.join(root, "docs/media/banner.svg");
const png = path.join(root, "docs/media/banner.png");

if (!fs.existsSync(svg)) {
  console.error(`missing ${svg} — run: python3 scripts/make-banner.py`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 340 },
  deviceScaleFactor: 2,
});
await page.goto(`file://${svg}`);
// The base64 font is inline, but the face still has to be parsed and applied
// before the wordmark measures correctly.
await page.waitForTimeout(1200);
await page.screenshot({ path: png });
await browser.close();

console.log(`wrote ${path.relative(root, png)}`);

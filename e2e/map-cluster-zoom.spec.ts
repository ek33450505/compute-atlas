import { test, expect, type Page } from "@playwright/test";

/**
 * Regression: clicking a cluster bubble on /map must zoom in meaningfully at
 * every viewport width. The old handler fitted the cluster's bbox with a fixed
 * 80 px padding, which on a 375 px phone left 215 px and produced a +0.25 to
 * +0.8 zoom change (mostly a pan). Fix: viewport-scaled padding plus a minimum
 * +2 zoom gain (lib/map.ts clusterTargetZoom).
 *
 * Zoom is read from the `data-map-zoom` attribute on the map wrapper, which
 * mirrors the React zoom state set in onZoomEnd, so it changes only once a
 * camera move has settled. playwright.config.ts forces reducedMotion, so the
 * ease itself has duration 0.
 */

const CLUSTERS = '.maplibregl-marker button[aria-label^="Cluster of"]';

async function zoomOf(page: Page): Promise<number> {
  const raw = await page.locator("[data-map-zoom]").first().getAttribute("data-map-zoom");
  return Number(raw);
}

/** Polls until zoom and cluster count are unchanged across two reads ~300 ms apart. */
async function waitForStableMap(page: Page): Promise<void> {
  let prev = "";
  let stable = 0;
  await expect
    .poll(
      async () => {
        const now = `${await zoomOf(page)}|${await page.locator(CLUSTERS).count()}`;
        stable = now === prev ? stable + 1 : 0;
        prev = now;
        await page.waitForTimeout(300);
        return stable;
      },
      { timeout: 20_000, message: "map never settled" },
    )
    .toBeGreaterThanOrEqual(2);
}

const VIEWPORTS = [
  { name: "phone 375x812", width: 375, height: 812 },
  { name: "desktop 1280x800", width: 1280, height: 800 },
];

for (const vp of VIEWPORTS) {
  test(`/map cluster click gains about 2 zoom levels — ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/map");
    await expect(page.locator(CLUSTERS).first()).toBeAttached({ timeout: 30_000 });
    await waitForStableMap(page);

    // Largest cluster fully inside the viewport and clear of the header and
    // bottom controls (off-screen ones are culled-but-mounted and unclickable).
    // Record its centre so the click does not depend on a re-resolved locator.
    const clusters = page.locator(CLUSTERS);
    const count = await clusters.count();
    let target: { size: number; label: string; x: number; y: number } | null = null;
    for (let i = 0; i < count; i++) {
      const el = clusters.nth(i);
      const box = await el.boundingBox();
      if (
        !box ||
        box.x < 8 ||
        box.y < 120 ||
        box.x + box.width > vp.width - 80 ||
        box.y + box.height > vp.height - 120
      ) {
        continue;
      }
      const size = Number(await el.textContent());
      if (!target || size > target.size) {
        target = {
          size,
          label: (await el.getAttribute("aria-label")) ?? "",
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
        };
      }
    }
    expect(target, "no cluster is clickable at the initial view").not.toBeNull();
    const t = target!;

    // The element at the recorded point must be that cluster before we click.
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest("button")?.getAttribute("aria-label") ?? null;
      },
      [t.x, t.y],
    );
    expect(hit, "recorded point is no longer the target cluster").toBe(t.label);

    const before = await zoomOf(page);
    await page.mouse.click(t.x, t.y);
    await expect
      .poll(() => zoomOf(page), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(before + 1.9);
  });
}

/**
 * #572: the map-tools column's transparent wrappers used to capture pointer
 * events in their empty gaps, so a click on a marker beside or under the column
 * did nothing. The fixture puts no cluster under the column, so this asserts
 * the mechanism instead: a point in the gap between two control buttons must
 * hit through to the map, the buttons must stay clickable, and the column must
 * still scroll by wheel when it overflows a short viewport.
 */
async function openTools(page: Page) {
  await page.goto("/map");
  // The column starts open on wide+tall viewports and collapsed otherwise.
  const show = page.getByRole("button", { name: "Show map tools" });
  const hide = page.getByRole("button", { name: "Hide map tools" });
  await expect(show.or(hide)).toBeVisible({ timeout: 30_000 });
  if (await show.isVisible()) await show.click();
  const panelId = await hide.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  return page.locator(`[id="${panelId}"]`);
}

test("/map tools column: gaps between controls do not capture clicks (#572)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  const panel = await openTools(page);
  await expect(panel).toBeVisible();

  const a = await page.getByRole("button", { name: "Toggle radius rings tool" }).boundingBox();
  const b = await page
    .getByRole("button", { name: "Show map coordinates readout" })
    .boundingBox();
  expect(a && b).toBeTruthy();
  const x = a!.x + a!.width / 2;
  const y = (a!.y + a!.height + b!.y) / 2; // inside the gap-2 between the buttons
  expect(y).toBeGreaterThan(a!.y + a!.height);
  expect(y).toBeLessThan(b!.y);

  const hitsColumn = await page.evaluate(
    ([px, py, id]) => {
      const el = document.elementFromPoint(px as number, py as number);
      return !!el?.closest(`[id="${id}"]`);
    },
    [x, y, await panel.getAttribute("id")],
  );
  expect(hitsColumn, "gap point must pass through to the map").toBe(false);

  // The real controls still take clicks.
  const rings = page.getByRole("button", { name: "Toggle radius rings tool" });
  await rings.click();
  await expect(rings).toHaveAttribute("aria-pressed", "true");

  // A panel opened from the column (Layers) stays interactive.
  await page.getByRole("button", { name: "Show map layers panel" }).click();
  const layerBox = panel.getByRole("checkbox").first();
  await expect(layerBox).toBeVisible();
  await layerBox.click();
  await expect(layerBox).toBeChecked();
});

test("/map tools column still scrolls by wheel on a short viewport (#572)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 400 });
  const panel = await openTools(page);
  const overflow = await panel.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, "panel must overflow for this test to mean anything").toBeGreaterThan(0);
  // Hover the first control: the later ones sit in the clipped, scrolled-away part of the panel.
  const box = await page.getByRole("button", { name: "Reset map orientation to north" }).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

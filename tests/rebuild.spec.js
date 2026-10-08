// Tweaks after the first build don't regenerate the 3D model: they mark
// it stale, "Rebuild 3D" (or Download STEP) rebuilds it. Profile stages
// are cached in the worker, so layout-only tweaks come back instantly.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "scraper-template.jpg");

const idle = (page) => expect.poll(() => page.evaluate(() =>
  !document.getElementById("rebuild-3d").disabled), { timeout: 120000 })
  .toBe(true);
const tagBin = (page) => page.evaluate(() => { window.__bin.tag = 1; });
const sameBin = (page) => page.evaluate(() => window.__bin.tag === 1);

test("3D model waits for Rebuild; export rebuilds a stale model", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "25");
  await page.click("#start-scan");
  // the first build of a design is still automatic
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  await idle(page);
  const stale = page.locator("#bin-stale");
  await expect(stale).toBeHidden();
  const firstFitMs = await page.evaluate(() => window.__profile.ms);

  // layout-only tweak: cached stages, no rebuild, overlay up
  await tagBin(page);
  await page.fill("#bin-thickness", "30");
  await page.locator("#bin-thickness").dispatchEvent("change");
  await expect.poll(() => page.evaluate(() =>
    window.__profile.params.thickness)).toBe(30);
  const p = await page.evaluate(() => window.__profile);
  expect(p.cached).toEqual({ base: true, cut: true });
  expect(p.ms).toBeLessThan(Math.max(500, firstFitMs / 5));
  await expect(stale).toBeVisible();
  expect(await sameBin(page)).toBe(true);

  // geometry tweak: refit, still no rebuild
  await page.locator("#sl-clearance").fill("1.5");
  await expect.poll(() => page.evaluate(() =>
    window.__profile.params.clearance), { timeout: 120000 }).toBe(1.5);
  await idle(page);
  expect(await sameBin(page)).toBe(true);

  // Rebuild 3D
  await page.click("#rebuild-3d");
  await expect.poll(() => page.evaluate(() =>
    window.__bin && window.__bin.ok && window.__bin.tag !== 1),
    { timeout: 120000 }).toBe(true);
  await expect(stale).toBeHidden();
  expect(await page.evaluate(() => window.__bin.H)).toBe(42); // 30 mm + floor

  // build-only option: stale, no rebuild
  await idle(page);
  await tagBin(page);
  await page.uncheck("#opt-deboss");
  await expect(stale).toBeVisible();
  expect(await sameBin(page)).toBe(true);

  // Download STEP on a stale model rebuilds first
  const dl = page.waitForEvent("download", { timeout: 120000 });
  await page.click("#export-step");
  await dl;
  expect(await sameBin(page)).toBe(false);
  await expect(stale).toBeHidden();
  const logs = await page.evaluate(() => window.__bin.logs.join(" | "));
  expect(logs).not.toContain("rev deboss");
});

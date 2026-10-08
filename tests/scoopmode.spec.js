// Scoop mode dropdown in the real UI: mirrored pairs sit at the same
// height, left/right only keep one scoop on that side, and switching
// back from a single scoop restores a mirrored pair; the fillet slider
// drives the scoop junction radius.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "snips-closed.jpg");

const settled = (page, mode) => expect.poll(() => page.evaluate((m) =>
  !!(window.__profile && window.__profile.params &&
     window.__profile.params.scoop_mode === m), mode), { timeout: 120000 })
  .toBe(true);
const spots = (page) => page.evaluate(() => window.__profile.scoops);

test("scoop modes: mirrored / left only / right only / independent", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "25");
  await page.click("#start-scan");
  await settled(page, "mirror");
  const pair = await spots(page);
  expect(pair.length).toBe(2);
  expect(Math.abs(pair[0][1] - pair[1][1])).toBeLessThan(0.5);

  await page.selectOption("#opt-scoop-mode", "left");
  await settled(page, "left");
  expect(await spots(page)).toEqual([pair[0]]);

  await page.selectOption("#opt-scoop-mode", "right");
  await settled(page, "right");
  const right = await spots(page);
  expect(right.length).toBe(1);
  expect(right[0][0]).toBeGreaterThan(pair[0][0]);

  await page.selectOption("#opt-scoop-mode", "free");
  await settled(page, "free");
  const free = await spots(page);
  expect(free.length).toBe(2);
  expect(Math.abs(free[0][1] - free[1][1])).toBeLessThan(0.5);

  // fillet slider: 6 mm by default, feeds the scoop/pocket junction radius
  const before = await page.evaluate(() => ({
    blend: window.__profile.params.scoop_blend,
    area: window.__profile.pocketPts.reduce((a, [x, y], i, P) =>
      a + x * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * y, 0) / 2 }));
  expect(before.blend).toBe(6);
  await page.locator("#sl-fillet").fill("2");
  await expect.poll(() => page.evaluate(() => window.__profile.params.scoop_blend),
    { timeout: 120000 }).toBe(2);
  // a smaller fillet fills in less around the scoops
  const after = await page.evaluate(() => window.__profile.pocketPts.reduce(
    (a, [x, y], i, P) => a + x * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * y, 0) / 2);
  expect(after).toBeLessThan(before.area);
});

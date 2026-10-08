// Scoop suggestions in the real UI: hidden when the scoops don't
// cost a grid unit; when they do, each offered fix is real — applying
// it shrinks the bin footprint and keeps the height.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "snips-closed.jpg");

const settled = (page, d) => expect.poll(() => page.evaluate((dd) =>
  !!(window.__profile && window.__profile.params.scoop_d === dd &&
     window.__suggest && window.__suggest.done), d), { timeout: 120000 })
  .toBe(true);
const layout = (page) => page.evaluate(() => window.__profile.layout);

test("scoop suggestions only appear when they save a unit, and do", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "25");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() =>
    !!(window.__suggest && window.__suggest.done)), { timeout: 240000 }).toBe(true);
  // default 25 mm scoops fit inside the bin the tool needs anyway
  const base = await layout(page);
  await expect(page.locator("#scoop-suggest")).toBeHidden();

  for (const kind of ["size", "move"]) {
    await page.locator("#sl-scoop").fill("40");
    await settled(page, 40);
    const big = await layout(page);
    expect(big.nx * big.ny).toBeGreaterThan(base.nx * base.ny);
    const btn = page.locator(`#sg-${kind}`);
    await expect(btn).toBeVisible();
    const offered = await page.evaluate((k) => window.__suggest[k].L, kind);
    const sizeD = await page.evaluate(() =>
      window.__suggest.size && window.__suggest.size.d);
    await btn.click();
    await settled(page, kind === "size" ? sizeD : 40);
    const after = await layout(page);
    expect(after.nx * after.ny).toBeLessThan(big.nx * big.ny);
    expect([after.nx, after.ny, after.nz]).toEqual([offered.nx, offered.ny, offered.nz]);
    expect(after.nz).toBe(big.nz);
    // (the size round leaves the auto spots; the move round runs next)
  }
});

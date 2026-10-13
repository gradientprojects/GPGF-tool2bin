// Where the rev deboss goes (owner, 2026-10-13): "Place rev" + a click
// on a foot in the 3D view picks its cell, ⟳ turns it 90°, Esc ends
// placing, and both ride in the STEP (a revise restores them).
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "scraper-template.jpg");

const built = (page) => expect.poll(() => page.evaluate(() =>
  window.__bin && window.__bin.ok &&
  !document.getElementById("rebuild-3d").disabled &&
  document.getElementById("bin-stale").hidden), { timeout: 240000 }).toBe(true);
const box = (page) => page.evaluate(() => window.__debossBox);
const cellOf = (page, b) => page.evaluate(([x, y]) => {
  const p = window.__profile, L = p.layout, G = 42;
  return [Math.round((x - p.center[0]) / G + (L.nx - 1) / 2) + 0, // no -0
          Math.round((y - p.center[1]) / G + (L.ny - 1) / 2) + 0];
}, [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);

test("rev deboss: pick the cell in 3D, turn it, keep it in the STEP", async ({ page }, info) => {
  test.setTimeout(400000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "25");
  await page.click("#start-scan");
  await built(page);
  const L = await page.evaluate(() => window.__profile.layout);
  expect(L.nx * L.ny).toBeGreaterThan(1); // the fixture's bin has room to move
  const b0 = await box(page);
  expect(await cellOf(page, b0)).toEqual([0, 0]); // default: as before

  // Place rev: bottom view, click the far cell's foot
  const target = L.nx > 1 ? [L.nx - 1, 0] : [0, L.ny - 1];
  await page.click("#rev-place");
  await expect(page.locator("#rev-place")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#rev-hint")).toBeVisible();
  // mouse events only land on the part of the canvas inside the viewport
  await page.locator("#bin-view").scrollIntoViewIfNeeded();
  const [sx, sy] = await page.evaluate(([i, j]) => {
    const p = window.__profile, L = p.layout, G = 42;
    const x = p.center[0] + (i - (L.nx - 1) / 2) * G + 8;
    const y = p.center[1] + (j - (L.ny - 1) / 2) * G + 8;
    return window.__toScreen(x, y, window.__bin.bbox.min[2]);
  }, target);
  await page.mouse.click(sx, sy);
  await expect(page.locator("#bin-stale")).toBeVisible(); // no auto regen
  await expect(page.locator("#rev-reset")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rev-place")).toHaveAttribute("aria-pressed", "false");
  await page.click("#rebuild-3d");
  await built(page);
  const b1 = await box(page);
  expect(await cellOf(page, b1)).toEqual(target);

  // ⟳ 90°: same cell, the text now runs the other way
  await page.click("#rev-rot");
  await page.click("#rebuild-3d");
  await built(page);
  const b2 = await box(page);
  expect(await cellOf(page, b2)).toEqual(target);
  expect(Math.abs((b2[2] - b2[0]) - (b1[3] - b1[1]))).toBeLessThan(0.3);
  expect(Math.abs((b2[3] - b2[1]) - (b1[2] - b1[0]))).toBeLessThan(0.3);

  // both live in the STEP: a revise restores them
  const dl = page.waitForEvent("download", { timeout: 300000 });
  await page.click("#export-step");
  const saved = info.outputPath("rev-placed.step");
  await (await dl).saveAs(saved);
  await page.reload();
  await page.setInputFiles("#photo", saved);
  await built(page);
  const b3 = await box(page);
  expect(await cellOf(page, b3)).toEqual(target);
  expect(Math.abs((b3[2] - b3[0]) - (b2[2] - b2[0]))).toBeLessThan(0.3);

  // Reset rev: back under the default cell, unturned
  await page.click("#rev-reset");
  await page.click("#rebuild-3d");
  await built(page);
  const b4 = await box(page);
  expect(await cellOf(page, b4)).toEqual([0, 0]);
  // unturned again: reads along x (the rev number changed, so not its width)
  expect(b4[2] - b4[0]).toBeGreaterThan(b4[3] - b4[1]);
});

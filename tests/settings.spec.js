// Reusing a saved bin's settings through the ONE file input: a STEP
// opened over an open tool asks "revise" or "use only its settings";
// settings carry over to the open tool and the next photo — never its
// outline, thickness or scoop spots. With nothing open, a STEP revises.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTOS = path.join(import.meta.dirname, "fixtures", "photos");

const scan = async (page, photo, thickness) => {
  await page.setInputFiles("#photo", path.join(PHOTOS, photo));
  await page.fill("#bin-thickness", thickness);
  await page.click("#start-scan");
};
const profiled = (page, pred, arg) => expect.poll(() => page.evaluate(
  ([f, a]) => !!(window.__profile && window.__profile.ok &&
                 new Function("p", "a", f)(window.__profile.params, a)),
  [pred, arg]), { timeout: 240000 }).toBe(true);

// what a good bin looked like
const GOOD = { clearance: 1.5, smooth_r: 12, scoop_d: 30, scoop_blend: 3,
               min_wall: 4, scoop_mode: "left", flat_faithful: true,
               magnets: false, edge: "" };
const params = (page) => page.evaluate(() => window.__profile.params);
const expectGood = (p) => {
  expect(p).toMatchObject({ clearance: GOOD.clearance, smooth_r: GOOD.smooth_r,
    scoop_d: GOOD.scoop_d, scoop_blend: GOOD.scoop_blend,
    min_wall: GOOD.min_wall, scoop_mode: GOOD.scoop_mode,
    flat_faithful: GOOD.flat_faithful, edge: {} });
  expect(!!p.magnets.enabled).toBe(false);
};

test("settings from a saved STEP apply to the open design and the next one", async ({ page }, info) => {
  test.setTimeout(600000);
  await page.goto("/");

  // 1. make the "good" bin and save it
  await scan(page, "snips-closed.jpg", "25");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  await page.locator("#sl-clearance").fill(String(GOOD.clearance));
  await page.locator("#sl-smooth").fill(String(GOOD.smooth_r));
  await page.locator("#sl-scoop").fill(String(GOOD.scoop_d));
  await page.locator("#sl-fillet").fill(String(GOOD.scoop_blend));
  await page.locator("#sl-wall").fill(String(GOOD.min_wall));
  await page.selectOption("#opt-scoop-mode", GOOD.scoop_mode);
  await page.check("#opt-flat");
  await page.uncheck("#opt-magnets");
  await page.selectOption("#opt-edge", GOOD.edge);
  await profiled(page, "return p.scoop_mode === a && p.edge.style === undefined",
    GOOD.scoop_mode);
  expectGood(await params(page));
  const dl = page.waitForEvent("download", { timeout: 240000 });
  await page.click("#export-step");
  const saved = info.outputPath("good.step");
  await (await dl).saveAs(saved);

  // 2. fresh session, a different tool at default settings
  await page.reload();
  await scan(page, "scraper-template.jpg", "12");
  await profiled(page, "return true");
  const before = await page.evaluate(() => ({
    params: window.__profile.params, contour: window.__contour.contourMm.length,
    name: document.getElementById("bin-name").value }));
  expect(before.params.clearance).not.toBe(GOOD.clearance);

  // 3. apply: the open design refits with the good settings, keeps its tool
  await expect(page.locator("#step-choice")).toBeHidden();
  await page.setInputFiles("#photo", saved);
  await expect(page.locator("#step-choice")).toBeVisible();
  await page.click("#step-settings");
  await expect(page.locator("#step-choice")).toBeHidden();
  await profiled(page, "return p.clearance === a", GOOD.clearance);
  const after = await params(page);
  expectGood(after);
  expect(after.thickness).toBe(12);   // the tool's own
  expect(after.scoops).toBeUndefined(); // spots re-placed, not copied
  expect(await page.evaluate(() => window.__profile.scoops.length)).toBe(1);
  expect(await page.evaluate(() => window.__contour.contourMm.length))
    .toBe(before.contour);
  expect(await page.inputValue("#bin-name")).toBe(before.name);
  await expect(page.locator("#scan-status")).toContainText("settings from");

  // 4. ... and they stay for the next photo
  await scan(page, "snips-closed.jpg", "20");
  await profiled(page, "return p.thickness === a", 20);
  expectGood(await params(page));

  // 5. "Revise this bin" opens the saved design itself
  await page.setInputFiles("#photo", saved);
  await page.click("#step-revise");
  await profiled(page, "return p.thickness === a", 25);
  expect(await page.inputValue("#bin-name")).toBe("snips-closed");
});

test("a STEP opened with no tool open goes straight to revision", async ({ page }, info) => {
  test.setTimeout(300000);
  await page.goto("/");
  await scan(page, "snips-closed.jpg", "25");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  const dl = page.waitForEvent("download", { timeout: 240000 });
  await page.click("#export-step");
  const saved = info.outputPath("plain.step");
  await (await dl).saveAs(saved);
  await page.reload();
  await page.setInputFiles("#photo", saved);
  await expect(page.locator("#step-choice")).toBeHidden();
  await profiled(page, "return p.thickness === a", 25);
  await expect(page.locator("#scan-status")).toContainText("revising");
});

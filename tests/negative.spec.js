// Two download buttons: "Download bin STEP" saves only the bin,
// "Download negative STEP" only "<stem> NEG.step" — the plain pocket
// cutout as one solid (no design embedded, so it never reopens as a
// bin). Click both for both.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "scraper-template.jpg");

test("bin or negative body: each button downloads only its own STEP", async ({ page }, info) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "12");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);

  // the fit-test tip explains spiral vase use + the line-width margin
  await expect(page.locator("#tip-negative")).toHaveAttribute("title", /spiral vase/);
  await expect(page.locator("#tip-negative")).toHaveAttribute("title", /line width/);

  const saved = [];
  page.on("download", async (d) => {
    const out = info.outputPath(d.suggestedFilename());
    await d.saveAs(out);
    saved.push({ fn: d.suggestedFilename(), out });
  });
  const oneMore = async (btn, n) => {
    await page.click(btn);
    await expect.poll(() => saved.length, { timeout: 120000 }).toBe(n);
    await page.waitForTimeout(1500); // and nothing else arrives
    expect(saved.length).toBe(n);
  };

  // bin only
  await oneMore("#export-step", 1);
  expect(saved[0].fn).toMatch(/ R01\.step$/);
  expect(saved[0].fn).not.toMatch(/NEG/);
  const bin = fs.readFileSync(saved[0].out, "utf8");
  expect(bin).toContain("S2S|");
  await expect(page.locator("#bin-status")).not.toContainText("NEG");

  // negative only (same stem: nothing changed, so the rev stays R01)
  await oneMore("#export-neg", 2);
  expect(saved[1].fn).toMatch(/ R01 NEG\.step$/);
  expect(saved[1].fn.replace(" NEG.step", "")).toBe(saved[0].fn.replace(".step", ""));
  const neg = fs.readFileSync(saved[1].out, "utf8");
  expect(neg.match(/MANIFOLD_SOLID_BREP/g).length).toBe(1);
  expect(neg).toContain("negative");
  expect(neg).not.toContain("S2S|");   // not a revisable design
  expect(neg.length).toBeLessThan(bin.length);
  await expect(page.locator("#bin-status")).toContainText("NEG.step");

  // no leftover option: the old "also export" checkbox is gone
  await expect(page.locator("#opt-negative")).toHaveCount(0);
});

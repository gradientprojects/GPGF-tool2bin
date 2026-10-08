// "also export the negative body": Download STEP saves a second file,
// "<stem> NEG.step" — the plain pocket cutout as one solid (no design
// embedded, so it never reopens as a bin). The option is remembered.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "scraper-template.jpg");

test("negative body: second STEP next to the bin, option remembered", async ({ page }, info) => {
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

  // off (default): one file
  await expect(page.locator("#opt-negative")).not.toBeChecked();
  const names = [];
  page.on("download", (d) => names.push(d.suggestedFilename()));
  await page.click("#export-step");
  await expect.poll(() => names.length, { timeout: 120000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect(names.length).toBe(1);

  // on: bin + NEG
  await page.check("#opt-negative");
  const saved = {};
  const got = new Promise((resolve) => {
    const onDl = async (d) => {
      const fn = d.suggestedFilename();
      const out = info.outputPath(fn);
      await d.saveAs(out);
      saved[fn] = out;
      if (Object.keys(saved).length === 2) { page.off("download", onDl); resolve(); }
    };
    page.on("download", onDl);
  });
  await page.click("#export-step");
  await got;
  const fns = Object.keys(saved).sort();
  expect(fns[0]).toMatch(/ R01 NEG\.step$/);
  expect(fns[1]).toMatch(/ R01\.step$/);
  expect(fns[0].replace(" NEG.step", "")).toBe(fns[1].replace(".step", ""));
  const neg = fs.readFileSync(saved[fns[0]], "utf8");
  const bin = fs.readFileSync(saved[fns[1]], "utf8");
  expect(neg.match(/MANIFOLD_SOLID_BREP/g).length).toBe(1);
  expect(neg).toContain("negative");
  expect(neg).not.toContain("S2S|");   // not a revisable design
  expect(bin).toContain("S2S|");
  expect(neg.length).toBeLessThan(bin.length);
  await expect(page.locator("#bin-status")).toContainText("NEG.step");

  // remembered on this device
  await page.reload();
  await expect(page.locator("#opt-negative")).toBeChecked();
});

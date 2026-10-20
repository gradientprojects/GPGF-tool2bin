// Frame-only template (owner, 2026-10-19): the default printable template
// has no gray field; shiny metal goes on a dark sheet laid in the frame.
// Synthetic fixture (tools/make_frame_fixture.py): a mid-gray 20 x 120 mm
// "aluminium" rod — the gray template's own field shade — on a dark
// sheet overlapping the marker gap. The markers must still be found and
// the rod come out at its true size.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "frame-dark-sheet-metal.jpg");

test("step 1 offers frame-only templates first, gray as the alternative", async ({ page }) => {
  await page.goto("/");
  const hrefs = await page.locator("#template a").evaluateAll(
    (as) => as.map((a) => a.getAttribute("href")));
  expect(hrefs).toEqual([
    "templates/tool2bin-template-letter.pdf",
    "templates/tool2bin-template-a4.pdf",
    "templates/tool2bin-template-letter-gray.pdf",
    "templates/tool2bin-template-a4-gray.pdf",
  ]);
  for (const h of hrefs) {
    expect((await page.request.get(h)).status()).toBe(200);
  }
});

test("metal rod on a dark sheet in the frame-only template", async ({ page }) => {
  test.setTimeout(300000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "20");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() => window.__profile && window.__profile.ok),
    { timeout: 240000 }).toBe(true);
  const r = await page.evaluate(() => {
    const xs = window.__contour.contourMm.map((q) => q[0]);
    const ys = window.__contour.contourMm.map((q) => q[1]);
    return { mode: window.__warp.mode,
      bbox: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
        .sort((a, b) => a - b) };
  });
  console.log(`FRAME: ${r.mode}, rod ${r.bbox.map((v) => v.toFixed(2)).join(" x ")} mm`);
  expect(r.mode).toBe("template");
  expect(Math.abs(r.bbox[0] - 20)).toBeLessThan(0.5);
  expect(Math.abs(r.bbox[1] - 120)).toBeLessThan(0.5);
});

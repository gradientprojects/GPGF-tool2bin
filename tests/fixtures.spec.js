// Self-sufficient end-to-end smoke (C6 exit gate): the committed,
// EXIF-stripped fixture photos run through the real UI chain and land
// on the committed expected values — no reference repo needed, runs in
// CI on every push. Desktop runs the plain-paper photo at 20 px/mm,
// the mobile project runs the template photo at its adaptive 12 px/mm.
//
// Regenerate expectations (local): GEN_EXPECTED=1 npx playwright test fixtures
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const PHOTOS = path.join(import.meta.dirname, "fixtures", "photos");
const EXPECTED = path.join(PHOTOS, "expected.json");
const GEN = !!process.env.GEN_EXPECTED;

const PLAN = [
  { photo: "snips-closed.jpg", project: "desktop", mode: "desktop" },
  { photo: "scraper-template.jpg", project: "mobile", mode: "mobile" },
];

async function runChain(page, photo) {
  await page.goto("/");
  await page.setInputFiles("#photo", path.join(PHOTOS, photo));
  await expect
    .poll(async () => page.evaluate(() => window.__bin), { timeout: 560000 })
    .not.toBeNull();
  return page.evaluate(() => {
    const w = window.__warp, c = window.__contour, p = window.__profile,
      b = window.__bin;
    const xs = c.contourMm.map((q) => q[0]), ys = c.contourMm.map((q) => q[1]);
    return {
      ok: w.ok && c.ok && p.ok && b.ok,
      error: [w, c, p, b].map((o) => o && o.error).filter(Boolean).join("; "),
      mode: w.mode, warpSize: w.warpSize,
      contourBbox: [Math.max(...xs) - Math.min(...xs),
                    Math.max(...ys) - Math.min(...ys)],
      areaMm2: c.areaMm2, angleDeg: c.angleDeg, flipped: c.flipped,
      layout: p.layout, binDims: b.bbox.dims, zTop: b.bbox.zTop,
      warnings: p.warnings,
    };
  });
}

test.describe("fixture photos through the full chain", () => {
  for (const { photo, project, mode } of PLAN) {
    test(`${mode}: ${photo}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== project,
        `runs in the ${project} project only`);
      test.setTimeout(600000);
      const r = await runChain(page, photo);
      expect(r.ok, r.error).toBe(true);
      if (GEN) {
        const all = fs.existsSync(EXPECTED)
          ? JSON.parse(fs.readFileSync(EXPECTED, "utf8")) : {};
        all[mode] = { photo, ...r };
        fs.writeFileSync(EXPECTED, JSON.stringify(all, null, 1));
        console.log(`GENERATED ${mode}:`, JSON.stringify(r));
        return;
      }
      const e = JSON.parse(fs.readFileSync(EXPECTED, "utf8"))[mode];
      console.log(`FIXTURE ${mode}: contour ${r.contourBbox.map((v) => v.toFixed(2))}` +
        ` (exp ${e.contourBbox.map((v) => v.toFixed(2))}), area ${r.areaMm2.toFixed(1)}` +
        ` (exp ${e.areaMm2.toFixed(1)}), bin ${r.binDims.map((v) => v.toFixed(2))}`);
      expect(r.mode).toBe(e.mode);
      expect(r.warpSize).toEqual(e.warpSize);
      expect(r.flipped).toBe(e.flipped);
      expect(Math.abs(r.angleDeg - e.angleDeg)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(r.areaMm2 - e.areaMm2))
        .toBeLessThanOrEqual(e.areaMm2 * 0.01 + 1);
      expect(Math.abs(r.contourBbox[0] - e.contourBbox[0])).toBeLessThan(0.3);
      expect(Math.abs(r.contourBbox[1] - e.contourBbox[1])).toBeLessThan(0.3);
      expect(r.layout).toEqual(e.layout);
      // bin dims are grid-quantized: must match to kernel precision
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(r.binDims[i] - e.binDims[i])).toBeLessThan(0.05);
      }
      expect(Math.abs(r.zTop - e.zTop)).toBeLessThan(0.05);
    });
  }
});

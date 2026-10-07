// C3 exit gate: stage 2+3 (segmentation + pose) parity vs the reference
// pipeline's oracle dumps. Local-only (needs the private reference repo);
// skips in CI.
//
// Two tiers:
//  1. STRICT — the JS stages run on the reference's own warped canvas
//     (lossless PNG dumped by the oracle), so the input is bit-identical
//     and the plan's contour gate (Hausdorff < 0.1 mm) applies directly.
//  2. END-TO-END — full JS chain from the raw photo. Stage-1 RANSAC
//     legitimately differs from the reference more than 0.1 mm on poorly
//     conditioned photos (see parity.spec.js), so this tier gates at the
//     warp-agreement level, not the strict contour gate.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { layout, markerCornersMm } from "../src/template.js";

const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");
const ORACLE = path.join(POC, "_ORACLE");
const available = fs.existsSync(ORACLE);

const dumps = available
  ? fs.readdirSync(ORACLE).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(ORACLE, f), "utf8")))
      .filter((d) => d.stage2 && fs.existsSync(path.join(ORACLE, d.stage2.warp_png)))
  : [];

// symmetric Hausdorff distance between two dense closed polylines
// (point-to-segment, both directions)
function directed(A, B) {
  const out = new Float64Array(A.length);
  for (let k = 0; k < A.length; k++) {
    const [px, py] = A[k];
    let best = Infinity;
    for (let i = 0; i < B.length - 1; i++) {
      const [x1, y1] = B[i], [x2, y2] = B[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
    out[k] = Math.sqrt(best);
  }
  return out;
}
// symmetric point-to-segment distances: { max (Hausdorff), p99 }
function contourDist(A, B) {
  const all = [...directed(A, B), ...directed(B, A)].sort((a, b) => a - b);
  return { max: all[all.length - 1], p99: all[Math.floor(all.length * 0.99)] };
}
const hausdorff = (A, B) => contourDist(A, B).max;

// how well-conditioned the reference homography was (same logic as the
// C2 suite): residuals of its projected corners vs the printed layout
function refResidualMedian(s1) {
  if (s1.mode !== "template") return 0; // plain quads agreed within 3 px
  const L = layout(s1.page);
  const r = [];
  s1.marker_ids.forEach((id, i) => {
    const want = markerCornersMm(...L.markers.get(id));
    for (let k = 0; k < 4; k++) {
      const got = s1.corners_mm[4 * i + k];
      r.push(Math.hypot(got[0] - want[k][0], got[1] - want[k][1]));
    }
  });
  r.sort((a, b) => a - b);
  return r[Math.floor(r.length / 2)];
}

async function injectOracleWarp(page, d) {
  const b64 = fs.readFileSync(path.join(ORACLE, d.stage2.warp_png)).toString("base64");
  return page.evaluate(async ({ b64: data, field }) => {
    const bin = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    return window.__segmentWarp(new Blob([bin], { type: "image/png" }), field);
  }, { b64, field: d.stage2.field_mm });
}

test.describe("stage-2/3 segmentation + pose parity vs oracle", () => {
  test.skip(!available, "reference repo not present (local-only test)");

  for (const d of dumps) {
    test(`strict (oracle warp): ${d.photo}`, async ({ page }) => {
      test.setTimeout(600000);
      await page.goto("/");
      const r = await injectOracleWarp(page, d);
      expect(r.ok, r.error || "").toBe(true);
      expect(r.flipped).toBe(d.flipped);
      expect(Math.abs(r.angleDeg - d.angle_deg)).toBeLessThanOrEqual(0.1);
      expect(Math.abs(r.iou - d.mirror_iou)).toBeLessThanOrEqual(0.005);
      expect(Math.abs(r.areaMm2 - d.mask_area_mm2)).toBeLessThanOrEqual(2);
      const hPx = hausdorff(r.contourPx, d.stage2.contour_px) / d.px_per_mm;
      const hMm = hausdorff(r.contourMm, d.contour_mm);
      console.log(`STRICT ${d.photo}: contour ${r.contourPx.length} pts ` +
        `(ref ${d.stage2.contour_px.length}), pre-pose H ${hPx.toFixed(4)} mm, ` +
        `final H ${hMm.toFixed(4)} mm, angle ${r.angleDeg.toFixed(2)} ` +
        `(ref ${d.angle_deg}), iou ${r.iou.toFixed(5)} (ref ${d.mirror_iou}), ` +
        `area ${r.areaMm2.toFixed(1)} (ref ${d.mask_area_mm2}) [${r.ms} ms]`);
      expect(hPx).toBeLessThan(0.1); // segmentation alone
      expect(hMm).toBeLessThan(0.1); // the C3 plan gate: + pose + orientation
    });

    test(`end-to-end from photo: ${d.photo}`, async ({ page }) => {
      test.setTimeout(600000);
      await page.goto("/");
      // the oracle ran at 20 px/mm; "fine detail" restores it in the UI
      await page.check("#opt-fine");
      await page.setInputFiles("#photo", path.join(POC, d.photo));
      await page.fill("#bin-thickness", "25");
      await page.click("#start-scan");
      await expect
        .poll(async () => page.evaluate(() => window.__contour), { timeout: 580000 })
        .not.toBeNull();
      const r = await page.evaluate(() => window.__contour);
      expect(r.ok, r.error || "").toBe(true);
      // debug artifact: the full JS result for offline diffing vs oracle
      const dumpDir = path.join(import.meta.dirname, "..", "test-results");
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(path.join(dumpDir,
        `e2e-${path.basename(d.photo)}.json`), JSON.stringify(r));
      const refMed = refResidualMedian(d.stage1);
      const wellConditioned = refMed <= 0.1;
      // Bulk agreement is gated at p99; the max is only a sanity bound.
      // On poorly-conditioned photos a threshold-marginal concave detail
      // can legitimately flip with the warp (measured: scissors @40/96
      // inliers — one 2.4x0.8 mm sliver at the pivot, 2.84 mm max, while
      // p99 stayed 0.39 mm and the strict tier is bit-exact).
      const p99Lim = wellConditioned ? 0.3 : 0.5;
      const hLim = wellConditioned ? 0.5 : 3.5;
      const dist = contourDist(r.contourMm, d.contour_mm);
      console.log(`E2E ${d.photo}: H max ${dist.max.toFixed(4)} / p99 ` +
        `${dist.p99.toFixed(4)} mm (limits ${hLim}/${p99Lim}, ref residual ` +
        `median ${refMed.toFixed(3)}), angle ${r.angleDeg.toFixed(2)} ` +
        `(ref ${d.angle_deg}), area ${r.areaMm2.toFixed(1)} (ref ${d.mask_area_mm2})`);
      expect(r.flipped).toBe(d.flipped);
      expect(Math.abs(r.angleDeg - d.angle_deg))
        .toBeLessThanOrEqual(wellConditioned ? 0.5 : 1.0);
      expect(Math.abs(r.areaMm2 - d.mask_area_mm2))
        .toBeLessThanOrEqual(d.mask_area_mm2 * 0.02 + 2);
      expect(dist.p99).toBeLessThan(p99Lim);
      expect(dist.max).toBeLessThan(hLim);
    });
  }
});

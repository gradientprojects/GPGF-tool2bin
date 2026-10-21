// Tilted tools (owner, 2026-10-21): a tool too long to lie straight on
// the sheet goes on the diagonal, and the symmetry axis must still be
// found. The reference searched only +-20 deg about vertical; snips at
// ~35 deg came out ~15 deg off. Synthetic warp canvases (no photo): a
// mirror-symmetric snips-like silhouette drawn at several angles, run
// through stages 2+3 via the parity hook.
import { test, expect } from "@playwright/test";

// [tilt, shape]: "snips" 52 x 200 mm, long axis = symmetry axis;
// "scraper" 100 x 60 mm, WIDE: the symmetry axis crosses the long axis
const CASES = [[0, "snips"], [12, "snips"], [35, "snips"], [-50, "snips"],
  [80, "snips"], [0, "scraper"], [30, "scraper"], [-65, "scraper"]];
const SIZE = { snips: [52, 200], scraper: [100, 60] };

test("symmetry axis found at any tilt", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop project only");
  test.setTimeout(300000);
  await page.goto("/");
  for (const [deg, shape] of CASES) {
    const r = await page.evaluate(async ([deg, shape]) => {
      const PX = 20, W = 200 * PX, H = 260 * PX; // 200 x 260 mm page
      const cnv = new OffscreenCanvas(W, H);
      const g = cnv.getContext("2d");
      g.fillStyle = "#e6e4df"; g.fillRect(0, 0, W, H);
      g.translate(W / 2, H / 2);
      g.rotate((deg * Math.PI) / 180);
      g.scale(PX, PX);
      g.fillStyle = "#2b2b2b";
      g.beginPath();
      if (shape === "scraper") {
        // 100 mm blade over a 24 mm handle, symmetric about x = 0
        g.moveTo(-50, -30); g.lineTo(50, -30); g.lineTo(50, -12);
        g.lineTo(12, -6); g.lineTo(12, 30); g.lineTo(-12, 30);
        g.lineTo(-12, -6); g.lineTo(-50, -12);
        g.closePath(); g.fill();
      } else {
      // 200 mm long, symmetric about x = 0: jaws, pivot boss, handles
      g.moveTo(0, -100); g.lineTo(9, -60); g.lineTo(14, -30);
      g.lineTo(22, -18); g.lineTo(14, -6); g.lineTo(26, 95);
      g.lineTo(12, 100); g.lineTo(4, 10); g.lineTo(-4, 10);
      g.lineTo(-12, 100); g.lineTo(-26, 95); g.lineTo(-14, -6);
      g.lineTo(-22, -18); g.lineTo(-14, -30); g.lineTo(-9, -60);
      g.closePath(); g.fill();
      }
      const blob = await cnv.convertToBlob({ type: "image/png" });
      const c = await window.__segmentWarp(blob, null);
      if (!c.ok) return { error: c.error };
      const xs = c.contourMm.map((q) => q[0]), ys = c.contourMm.map((q) => q[1]);
      return { angleDeg: c.angleDeg, iou: c.iou,
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }, [deg, shape]);
    console.log(`${shape} tilt ${deg}: ${JSON.stringify(r)}`);
    expect(r.error).toBeUndefined();
    // the canvas turns clockwise by +tilt, so +tilt stands it back up (mod
    // 180: tip up/down is settled later by toOrientedMm)
    const off = ((((r.angleDeg - deg) % 180) + 270) % 180) - 90;
    expect(Math.abs(off)).toBeLessThan(0.5);
    expect(r.iou).toBeGreaterThan(0.95);
    expect(Math.abs(r.w - SIZE[shape][0])).toBeLessThan(1.5);
    expect(Math.abs(r.h - SIZE[shape][1])).toBeLessThan(1.5);
  }
});

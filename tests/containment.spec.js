// C4 feature gates (app-side features, not in the reference):
//  - strict_contain: the final pocket keeps >= clearance - 0.05 mm to
//    the tool everywhere, even where the reference's smooth fit would
//    accept an intruding curve.
//  - max_contour: the pocket never follows concave notches inward
//    (convex-hull base), and still clears the tool.
// Runs in CI: input is the synthetic notched tool from the profile
// fixtures (the same shape the smooth-chain goldens use).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import cvPromise from "@techstark/opencv-js";
import { profileResponse, convexHull } from "../src/profilestage.js";
import { rasterize, sdf, PX } from "../src/smoothprof.js";

const FIX = path.join(import.meta.dirname, "fixtures", "profile");
const tool = JSON.parse(
  fs.readFileSync(path.join(FIX, "smooth_chain.json"), "utf8")).tool;

async function cvReady() {
  let c = cvPromise;
  if (c && typeof c.then === "function") c = await c;
  if (c && !c.Mat && "onRuntimeInitialized" in c) {
    await new Promise((res) => { c.onRuntimeInitialized = res; });
  }
  return c;
}

/** min signed distance (mm) from pts to the polygon's boundary-grown zone */
function minClearanceOf(c, poly, pts) {
  const { mask, origin } = rasterize(c, poly, 12.0);
  const sd = sdf(c, mask);
  const H = mask.rows, W = mask.cols;
  mask.delete();
  let worst = Infinity;
  for (const [x, y] of pts) {
    const r = (y - origin[1]) * PX, cc = (x - origin[0]) * PX;
    const r0 = Math.max(0, Math.min(H - 2, Math.floor(r)));
    const c0 = Math.max(0, Math.min(W - 2, Math.floor(cc)));
    const fr = r - r0, fc = cc - c0;
    const i00 = r0 * W + c0;
    const v = (sd[i00] * (1 - fr) * (1 - fc) + sd[i00 + 1] * (1 - fr) * fc +
               sd[i00 + W] * fr * (1 - fc) + sd[i00 + W + 1] * fr * fc) / PX;
    if (v < worst) worst = v;
  }
  return worst;
}

const PARAMS = { thickness: 25, clearance: 1.0, smooth_r: 8.0, min_wall: 3.0,
                 scallop_d: 25.0, scallop_blend: 4.0, symmetric: false };

test("strict_contain: pocket clears the tool everywhere", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const r = profileResponse(c, tool, { ...PARAMS, strict_contain: true });
  const mc = minClearanceOf(c, tool, r.pocketPts);
  console.log(`strict_contain min clearance: ${mc.toFixed(4)} mm`);
  expect(mc).toBeGreaterThanOrEqual(PARAMS.clearance - 0.05 - 1e-6);
});

test("max_contour: pocket ignores the concave notch and clears the hull", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const base = profileResponse(c, tool, { ...PARAMS, scallop_d: 0 });
  const r = profileResponse(c, tool,
    { ...PARAMS, scallop_d: 0, max_contour: true, strict_contain: true });
  const hull = convexHull(tool);
  const mcHull = minClearanceOf(c, hull, r.pocketPts);
  console.log(`max_contour min clearance to hull: ${mcHull.toFixed(4)} mm`);
  // the pocket stays outside hull+clearance (so no inward hugging at all)
  expect(mcHull).toBeGreaterThanOrEqual(PARAMS.clearance - 0.1);
  // and is a strict superset of the default pocket (area grows)
  const area = (pts) => {
    let a2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a2 += pts[i][0] * pts[j][1] - pts[i][1] * pts[j][0];
    }
    return Math.abs(a2 / 2);
  };
  expect(area(r.pocketPts)).toBeGreaterThan(area(base.pocketPts) + 1);
});

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

/** max signed distance (mm) of pts beyond the polygon boundary */
function maxBulgeOf(c, poly, pts) {
  const { mask, origin } = rasterize(c, poly, 12.0);
  const sd = sdf(c, mask);
  const H = mask.rows, W = mask.cols;
  mask.delete();
  let worst = -Infinity;
  for (const [x, y] of pts) {
    const r = (y - origin[1]) * PX, cc = (x - origin[0]) * PX;
    const r0 = Math.max(0, Math.min(H - 2, Math.floor(r)));
    const c0 = Math.max(0, Math.min(W - 2, Math.floor(cc)));
    const fr = r - r0, fc = cc - c0;
    const i00 = r0 * W + c0;
    const v = (sd[i00] * (1 - fr) * (1 - fc) + sd[i00 + 1] * (1 - fr) * fc +
               sd[i00 + W] * fr * (1 - fc) + sd[i00 + W + 1] * fr * fc) / PX;
    if (v > worst) worst = v;
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
  // regression: the union refit must come out CCW — a CW pocket
  // inverted the pocket-entry flare's outward normals and shipped
  // bins with no chamfer on the pocket edge
  let a2 = 0;
  for (let i = 0; i < r.pocketPts.length; i++) {
    const j = (i + 1) % r.pocketPts.length;
    a2 += r.pocketPts[i][0] * r.pocketPts[j][1] -
          r.pocketPts[i][1] * r.pocketPts[j][0];
  }
  expect(a2).toBeGreaterThan(0);
});

// Regression: a tall tool whose 25 mm scallop lobes reach past the
// tool bbox + the union canvas margin. The union canvas used to be
// sized from the tool alone; the clipped pocket shattered the union
// contour at the canvas border and the refit produced a pocket that
// cut off the bottom half of the tool (min clearance -9.4 mm).
test("strict_contain: scallop lobes past the tool bbox stay on canvas", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const tall = JSON.parse(
    fs.readFileSync(path.join(FIX, "tall_tool.json"), "utf8")).tool;
  const r = profileResponse(c, tall, { thickness: 25, clearance: 1.5,
    smooth_r: 0, min_wall: 3.0, scallop_d: 25.0, scallop_blend: 4.0,
    symmetric: true, strict_contain: true });
  const mc = minClearanceOf(c, tall, r.pocketPts);
  console.log(`tall-tool strict min clearance: ${mc.toFixed(4)} mm`);
  expect(mc).toBeGreaterThanOrEqual(1.3);
  const y = (pts) => pts.reduce((m, p) => [Math.min(m[0], p[1]),
    Math.max(m[1], p[1])], [Infinity, -Infinity]);
  const [ty0, ty1] = y(tall), [py0, py1] = y(r.pocketPts);
  expect(py0).toBeLessThan(ty0);
  expect(py1).toBeGreaterThan(ty1);
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

// Custom scallop centers (draggable dots in the UI): the worker uses
// the passed positions instead of auto-placement and echoes them back.
test("params.scallops overrides auto placement and still clears", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const auto = profileResponse(c, tool, PARAMS);
  // move both scallops to the top edge of the auto fit
  const topY = auto.fit.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  const pick = (sx) => auto.fit.reduce((b, p) =>
    Math.abs(p[1] - topY) < 2 && Math.abs(p[0] - sx) < Math.abs(b[0] - sx)
      ? p : b, [Infinity, 0]);
  const custom = [pick(-20), pick(20)];
  const r = profileResponse(c, tool, { ...PARAMS, scallops: custom });
  expect(r.scallops).toEqual(custom);
  expect(r.scallops).not.toEqual(auto.scallops);
  const mc = minClearanceOf(c, tool, r.pocketPts);
  console.log(`custom-scallop min clearance: ${mc.toFixed(4)} mm`);
  expect(mc).toBeGreaterThanOrEqual(PARAMS.clearance - 0.05 - 1e-6);
});

// flat_faithful: along the long straight edges of a rectangle the
// pocket must stay within ~0.3 mm of the true offset; without the flag
// the accepted smoothing rung bows the flats visibly. Corner regions
// are exempt (containment inflation overshoots there by design), so
// the metric samples only the mid-edge stretch.
test("flat_faithful: flats stay flat on a rectangle tool", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const rect = [[-70, -10], [70, -10], [70, 10], [-70, 10]];
  const P = { thickness: 25, clearance: 1.0, smooth_r: 8.0, min_wall: 3.0,
              scallop_d: 0, scallop_blend: 4.0, symmetric: false };
  const onFlats = (pts) =>
    pts.filter(([x, y]) => Math.abs(x) <= 55 && Math.abs(y) >= 5);
  const loose = profileResponse(c, rect, P);
  const flat = profileResponse(c, rect, { ...P, flat_faithful: true });
  const bulgeLoose = maxBulgeOf(c, rect, onFlats(loose.pocketPts)) - P.clearance;
  const bulgeFlat = maxBulgeOf(c, rect, onFlats(flat.pocketPts)) - P.clearance;
  console.log(`rectangle flat-edge bulge: default ${bulgeLoose.toFixed(3)} mm, ` +
              `flat_faithful ${bulgeFlat.toFixed(3)} mm`);
  expect(bulgeFlat).toBeLessThanOrEqual(0.35);
  expect(bulgeLoose).toBeGreaterThan(0.4); // the flag has something to fix
  const mc = minClearanceOf(c, rect, flat.pocketPts);
  expect(mc).toBeGreaterThanOrEqual(P.clearance - 0.05 - 1e-6);
});

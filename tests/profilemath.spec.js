// C4 per-function golden tests: every numeric building block of the
// profile-math port vs reference-environment dumps (scipy/cv2/skimage).
// Pure-math parts run as plain Node; the cv-dependent chain loads the
// same opencv-js WASM Node-side. Runs in CI (fixtures committed).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import cvPromise from "@techstark/opencv-js";
import { gaussianFilter1d, mapCoordinatesBilinear } from "../src/nummath.js";
import { designMatrix, splev, evalPeriodic } from "../src/bspline.js";
import {
  resample, detectCorners, fitProfile, sampleSegs, pspline, fitSegment,
} from "../src/profilefit.js";
import {
  sdf, closing, rasterize, offsetContour, symmetrizeContour,
  periodicFit, curvaturePeriodic, smoothProfile, addScallops,
} from "../src/smoothprof.js";

const FIX = path.join(import.meta.dirname, "fixtures", "profile");
const load = (n) => JSON.parse(fs.readFileSync(path.join(FIX, `${n}.json`), "utf8"));

async function cvReady() {
  let c = cvPromise;
  if (c && typeof c.then === "function") c = await c;
  if (c && !c.Mat && "onRuntimeInitialized" in c) {
    await new Promise((res) => { c.onRuntimeInitialized = res; });
  }
  return c;
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
function maxPtDiff(A, B) {
  let m = 0;
  for (let i = 0; i < A.length; i++) {
    m = Math.max(m, Math.hypot(A[i][0] - B[i][0], A[i][1] - B[i][1]));
  }
  return m;
}

test("gaussian_filter1d (wrap) matches scipy", () => {
  for (const c of load("gaussian1d").cases) {
    const y = gaussianFilter1d(c.x, c.sigma);
    expect(maxAbsDiff(y, c.y)).toBeLessThan(1e-12);
  }
});

test("clamped P-spline: design matrix, solve, splev + derivatives", () => {
  for (const c of load("pspline_clamped").cases) {
    const rows = designMatrix(c.u, c.knots, 3);
    const nc = c.knots.length - 4;
    // partition of unity on every row
    for (const r of rows) {
      let s = 0;
      for (const v of r.vals) s += v;
      expect(Math.abs(s - 1)).toBeLessThan(1e-12);
    }
    // dense sample rows vs scipy design_matrix
    const stride = Math.max(1, Math.trunc(c.q.length / 7));
    let fi = 0;
    for (let ri = 0; ri < c.q.length; ri += stride, fi++) {
      const dense = new Float64Array(nc);
      const { start, vals } = rows[ri];
      vals.forEach((v, j) => { dense[start + j] = v; });
      expect(maxAbsDiff(dense, c.design_sample[fi])).toBeLessThan(1e-12);
    }
    const s = pspline(c.q, 3e-7);
    expect(maxAbsDiff(s.cx, c.coef_x)).toBeLessThan(1e-7);
    expect(maxAbsDiff(s.cy, c.coef_y)).toBeLessThan(1e-7);
    expect(maxAbsDiff(s.dev, c.dev)).toBeLessThan(1e-7);
    for (const [der, ref] of [[0, c.eval0], [1, c.eval1], [2, c.eval2]]) {
      const got = splev(c.eval_u, s.t, s.cx, s.cy, s.k, der);
      expect(maxPtDiff(got, ref)).toBeLessThan(1e-6 * (1 + der * 10));
    }
  }
});

test("fit_segment lambda search matches", () => {
  for (const c of load("fit_segment").cases) {
    const r = fitSegment(c.q);
    expect(r.mult).toBe(c.lam_mult);
    expect(Math.abs(r.rms - c.rms)).toBeLessThan(1e-9);
    expect(Math.abs(r.max - c.max)).toBeLessThan(1e-9);
    expect(maxAbsDiff(r.tck.cx, c.coef_x)).toBeLessThan(1e-7);
    expect(maxAbsDiff(r.tck.cy, c.coef_y)).toBeLessThan(1e-7);
  }
});

test("periodic P-spline fit + eval + curvature match", () => {
  for (const c of load("periodic_fit").cases) {
    const tck = periodicFit(c.q, 3e-7 * c.mult);
    expect(maxAbsDiff(tck.tExt, c.t_ext)).toBeLessThan(1e-14);
    expect(maxPtDiff(tck.C, c.C)).toBeLessThan(1e-8);
    const pts = evalPeriodic(tck.tExt, tck.C, tck.k, 500);
    expect(maxPtDiff(pts, c.pts)).toBeLessThan(1e-8);
    const { kap } = curvaturePeriodic(tck, 500);
    expect(maxAbsDiff(kap, c.kappa)).toBeLessThan(1e-6);
  }
});

test("map_coordinates order=1 matches", () => {
  const f = load("map_coordinates");
  const img = Float64Array.from(f.img.flat());
  const v = mapCoordinatesBilinear(img, f.shape[0], f.shape[1],
    f.coords.map((p) => p[0]), f.coords.map((p) => p[1]));
  expect(maxAbsDiff(v, f.values)).toBeLessThan(1e-12);
});

test("corner detection + literal profile fit match", () => {
  const f = load("corners_literal");
  const p = resample(f.contour);
  expect(p.length).toBe(f.resampled.length);
  expect(maxPtDiff(p, f.resampled)).toBeLessThan(1e-9);
  const { corners, refined } = detectCorners(p);
  expect(corners).toEqual(f.corners);
  for (const [k, v] of Object.entries(f.refined)) {
    const got = refined.get(Number(k));
    expect(Math.hypot(got[0] - v[0], got[1] - v[1])).toBeLessThan(1e-8);
  }
  const { segs, report } = fitProfile(p, [...corners], new Map(refined));
  expect(report.map((r) => r.lam_mult)).toEqual(f.report.map((r) => r.lam_mult));
  const { pts } = sampleSegs(segs, 400);
  for (let i = 0; i < pts.length; i++) {
    expect(maxPtDiff(pts[i], f.fit_pts[i])).toBeLessThan(1e-6);
  }
});

test("cv chain: sdf / closing / offset / symmetrize / smooth / scallops", async () => {
  test.setTimeout(240000);
  const c = await cvReady();
  const f = load("smooth_chain");
  const tool = f.tool;

  const { mask, origin } = rasterize(c, tool, 6.0);
  expect(origin[0]).toBeCloseTo(f.rasterize.origin[0], 10);
  expect(origin[1]).toBeCloseTo(f.rasterize.origin[1], 10);
  expect([mask.rows, mask.cols]).toEqual(f.rasterize.shape);
  let sum = 0;
  for (const v of mask.data) sum += v;
  expect(sum).toBe(f.rasterize.mask_sum);
  const sd = sdf(c, mask);
  f.rasterize.sdf_probe_rc.forEach(([r, cc], i) => {
    expect(Math.abs(sd[r * mask.cols + cc] - f.rasterize.sdf_probe_vals[i]))
      .toBeLessThan(1e-4);
  });
  const closed = closing(c, mask, 4.0 * 20.0);
  let cSum = 0;
  for (const v of closed.data) cSum += v;
  expect(cSum).toBe(f.rasterize.closed_sum);
  mask.delete(); closed.delete();

  const off = offsetContour(c, tool, 1.0);
  expect(off.length).toBe(f.offset_1mm.length);
  expect(maxPtDiff(off, f.offset_1mm)).toBeLessThan(1e-5);

  const sym = symmetrizeContour(c, tool.map(([x, y]) => [x + 3.0, y]));
  expect(sym.length).toBe(f.symmetrized.length);
  expect(maxPtDiff(sym, f.symmetrized)).toBeLessThan(1e-5);

  const logs = [];
  const sm = smoothProfile(c, tool, 1.0, 8.0, (l) => logs.push(l));
  expect(Math.abs(sm.minClearance - f.smooth.min_clearance)).toBeLessThan(1e-6);
  expect(sm.closingQ.length).toBe(f.smooth.closing_q.length);
  expect(maxPtDiff(sm.closingQ, f.smooth.closing_q)).toBeLessThan(1e-5);
  expect(sm.fit.length).toBe(f.smooth.fit.length);
  expect(maxPtDiff(sm.fit, f.smooth.fit)).toBeLessThan(1e-5);

  const sc = addScallops(c, sm.fit, [[-26.0, 0.0], [26.0, 0.0]], 20.0, 4.0,
    (l) => logs.push(l));
  expect(sc.pts.length).toBe(f.scallops.pocket.length);
  expect(maxPtDiff(sc.pts, f.scallops.pocket)).toBeLessThan(1e-5);
  console.log("cv chain logs:", logs.join(" | "));
});

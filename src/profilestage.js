// Stage 4-5 driver: mirror of server.compute_profile / layout /
// auto_scallops / profile_response (the profile-side subset; bin
// construction is C5). Adds two app-side features the reference does
// not have, both OFF by default so parity against the oracle holds:
//   maxContour     — pocket derives from the convex hull of the tool
//                    contour (never hugs into concavities).
//   strictContain  — after everything, the pocket is unioned with the
//                    tool+clearance outline, guaranteeing containment
//                    even where the reference accepts a non-converged
//                    smooth fit.
//   flatFaithful   — extra smooth-fit acceptance gate: along straight
//                    stretches of the outline the curve must stay
//                    within 0.3 mm (corners exempt — the containment
//                    inflation overshoots there by design), so flat
//                    tool edges stay flat on a lower smoothing rung.
import {
  symmetrizeContour, offsetContour, smoothProfile, addScallops,
  periodicFit, rasterize, sdf, fillMask, bbox, PX, LAM_BASE,
} from "./smoothprof.js";
import { evalPeriodic } from "./bspline.js";
import { resample, detectCorners, fitProfile, sampleSegs } from "./profilefit.js";
import { roundHalfEven, GridNN } from "./nummath.js";
import { findContours } from "./marching.js";

export const GRID = 42.0;
export const GAP = 0.5;
export const MIN_FLOOR = 5.0;

/** Andrew monotone chain, CCW hull of mm points. */
export function convexHull(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

export function computeProfile(c, cMm, clearance, smoothR, log = () => {},
                               flatCap = Infinity) {
  if (smoothR > 0) {
    const r = smoothProfile(c, cMm, clearance, smoothR, log, flatCap);
    return { segs: [r.tck], periodic: true, fit: r.fit,
             extra: { minClearance: r.minClearance } };
  }
  let src = cMm;
  if (clearance > 0) src = offsetContour(c, cMm, clearance);
  const p = resample(src);
  const { corners, refined } = detectCorners(p, log);
  const { segs } = fitProfile(p, corners, refined, log);
  const { pts } = sampleSegs(segs);
  return { segs, periodic: false, fit: pts.flat(), extra: {} };
}

export function layout(fitPts, thickness, minWall) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of fitPts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const nx = Math.ceil((x1 - x0 + 2 * minWall + GAP) / GRID);
  const ny = Math.ceil((y1 - y0 + 2 * minWall + GAP) / GRID);
  const nz = Math.max(1, roundHalfEven((thickness + 7.0) / 7.0));
  const H = nz * 7.0;
  let depth = thickness, proud = 0.0;
  if (H - depth < MIN_FLOOR) {
    depth = H - MIN_FLOOR;
    proud = thickness - depth;
  }
  return { nx, ny, nz, H, depth, proud,
           bboxC: [(x1 + x0) / 2, (y1 + y0) / 2] };
}

function snap(fitPts, pt) {
  let best = Infinity, bi = 0;
  fitPts.forEach(([x, y], i) => {
    const d = Math.hypot(x - pt[0], y - pt[1]);
    if (d < best) { best = d; bi = i; }
  });
  return [fitPts[bi][0], fitPts[bi][1]];
}

export function autoScallops(fitPts) {
  let cy = 0, minX = Infinity;
  for (const [x, y] of fitPts) { cy += y; if (x < minX) minX = x; }
  cy /= fitPts.length;
  const left = snap(fitPts, [minX - 5, cy]);
  const right = snap(fitPts, [-left[0], left[1]]);
  return [left, right];
}

/** strictContain post-pass: union the pocket with tool+clearance, refit. */
function containmentUnion(c, pocketPts, toolMm, clearance, log) {
  const margin = clearance + 8.0;
  // the canvas must cover the pocket as well as the tool: scallop lobes
  // reach well past the tool bbox, and a pocket clipped at the canvas
  // edge shatters the union contour into open border fragments that the
  // periodic refit then closes into garbage
  const b = bbox([...toolMm, ...pocketPts]);
  const origin = [b.x0 - margin, b.y0 - margin];
  const W = Math.trunc((b.x1 - b.x0 + 2 * margin) * PX) + 2;
  const H = Math.trunc((b.y1 - b.y0 + 2 * margin) * PX) + 2;
  const mask = fillMask(c, H, W, [toolMm], origin);
  const sdTool = sdf(c, mask);
  mask.delete();
  // worst intrusion of the pocket into the clearance zone
  let worst = Infinity;
  const probe = (x, y) => {
    const r = (y - origin[1]) * PX, cc = (x - origin[0]) * PX;
    const r0 = Math.max(0, Math.min(H - 2, Math.floor(r)));
    const c0 = Math.max(0, Math.min(W - 2, Math.floor(cc)));
    const fr = r - r0, fc = cc - c0;
    const i00 = r0 * W + c0;
    return (sdTool[i00] * (1 - fr) * (1 - fc) + sdTool[i00 + 1] * (1 - fr) * fc +
            sdTool[i00 + W] * fr * (1 - fc) + sdTool[i00 + W + 1] * fr * fc) / PX;
  };
  for (const [x, y] of pocketPts) {
    const v = probe(x, y);
    if (v < worst) worst = v;
  }
  if (worst >= clearance - 0.05) return null; // already contained
  // union raster: pocket polygon OR sd <= clearance
  const { mask: pm } = (() => {
    const m = c.Mat.zeros(H, W, c.CV_8UC1);
    const flat = new Int32Array(pocketPts.length * 2);
    pocketPts.forEach((p, i) => {
      flat[2 * i] = roundHalfEven((p[0] - origin[0]) * PX);
      flat[2 * i + 1] = roundHalfEven((p[1] - origin[1]) * PX);
    });
    const mat = c.matFromArray(pocketPts.length, 1, c.CV_32SC2, flat);
    const vec = new c.MatVector();
    vec.push_back(mat);
    c.fillPoly(m, vec, new c.Scalar(1));
    mat.delete(); vec.delete();
    return { mask: m };
  })();
  const u = new c.Mat(H, W, c.CV_8UC1);
  {
    const pd = pm.data, ud = u.data;
    for (let i = 0; i < ud.length; i++) {
      ud[i] = pd[i] || sdTool[i] <= clearance * PX ? 1 : 0;
    }
  }
  pm.delete();
  const sdU = sdf(c, u);
  u.delete();
  const cs = findContours(sdU, H, W, 0.0);
  let bestC = cs[0];
  for (const cc of cs) if (cc.length > bestC.length) bestC = cc;
  let poly = bestC.map(([r, col]) => [col / PX + origin[0], r / PX + origin[1]]);
  // light refit so the result is a spline again (tight cap, like scallops)
  const step = 0.2;
  const q = [];
  {
    const qq = [...poly, poly[0]];
    let s = 0;
    const svals = [0];
    for (let i = 1; i < qq.length; i++) {
      s += Math.hypot(qq[i][0] - qq[i - 1][0], qq[i][1] - qq[i - 1][1]);
      svals.push(s);
    }
    const m = Math.ceil(s / step);
    for (let i = 0; i < m; i++) {
      const t = i * step;
      let lo = 0, hi = svals.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (svals[mid] <= t) lo = mid; else hi = mid; }
      const f = (t - svals[lo]) / (svals[hi] - svals[lo] || 1);
      q.push([qq[lo][0] + f * (qq[hi][0] - qq[lo][0]),
              qq[lo][1] + f * (qq[hi][1] - qq[lo][1])]);
    }
  }
  const tree = new GridNN(q, 1.0);
  let tck = null, pts = null, dev = Infinity, minSd = -Infinity;
  for (const mult of [1, 0.3, 0.1, 0.03, 0.01, 0.003, 0.001, 0.0003, 0.0001]) {
    tck = periodicFit(q, LAM_BASE * mult, 1.25);
    pts = evalPeriodic(tck.tExt, tck.C, tck.k, 8000);
    dev = 0; minSd = Infinity;
    for (const [x, y] of pts) {
      const dd = tree.query(x, y).dist;
      if (dd > dev) dev = dd;
      const sv = probe(x, y);
      if (sv < minSd) minSd = sv;
    }
    // the refit itself must not reintroduce intrusion
    if (dev <= 0.15 && minSd >= clearance - 0.05) break;
  }
  // never hand back something worse than the pocket we were given
  if (minSd < worst) {
    log(`WARNING: strict containment refit went wrong (min clearance ` +
        `${minSd.toFixed(2)} mm vs ${worst.toFixed(2)} mm before); ` +
        `keeping the unfixed pocket`);
    return { failed: true };
  }
  log(`strict containment: pocket unioned with tool+clearance ` +
      `(was ${(clearance - worst).toFixed(2)} mm short), refit dev ` +
      `${dev.toFixed(3)} mm, min clearance ${minSd.toFixed(3)} mm`);
  return { tck, pts, minSd };
}

/** Port of server.profile_response (profile side only). */
export function profileResponse(c, cMm, params, log = () => {}) {
  const clearance = +(params.clearance ?? 1.0);
  const smoothR = +(params.smooth_r ?? 8.0);
  const thickness = +(params.thickness ?? 25.0);
  const minWall = +(params.min_wall ?? 3.0);
  const scallopD = +(params.scallop_d ?? 25.0);
  const scallopBlend = +(params.scallop_blend ?? 4.0);

  let cSrc = cMm;
  if (params.max_contour) {
    cSrc = convexHull(cSrc);
    log("max contour: convex hull of the tool outline");
  }
  if (params.symmetric ?? true) {
    cSrc = symmetrizeContour(c, cSrc);
    log("symmetric cutout: mirrored union across centerline");
  }
  const prof = computeProfile(c, cSrc, clearance, smoothR, log,
    params.flat_faithful ? 0.3 : Infinity);
  const scallops = params.scallops || autoScallops(prof.fit);

  let cutSegs = prof.segs, cutPeriodic = prof.periodic, pocketPts = prof.fit;
  if (scallopD > 0 && scallops.length) {
    const s = addScallops(c, prof.fit, scallops, scallopD, scallopBlend, log);
    cutSegs = [s.tck]; cutPeriodic = true; pocketPts = s.pts;
  }
  const warnings = [];
  if (params.strict_contain) {
    const fixed = containmentUnion(c, pocketPts, cMm, clearance, log);
    if (fixed && fixed.failed) {
      warnings.push("containment fix-up failed -- lower scallop/clearance or re-scan");
    } else if (fixed) {
      cutSegs = [fixed.tck]; cutPeriodic = true; pocketPts = fixed.pts;
    }
  }

  const L = layout(pocketPts, thickness, minWall);
  if (L.proud > 0) {
    warnings.push(`pocket depth clamped; tool sits ${L.proud.toFixed(1)} mm proud`);
  }
  if ((prof.extra.minClearance ?? clearance) < clearance - 0.05 && !params.strict_contain) {
    warnings.push("containment not met -- lower smoothness or clearance");
  }
  return {
    segs: cutSegs, periodic: cutPeriodic, fit: prof.fit, pocketPts,
    layout: { nx: L.nx, ny: L.ny, nz: L.nz, H: L.H, depth: L.depth },
    center: L.bboxC, scallops, warnings,
  };
}

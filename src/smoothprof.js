// Port of scan2step/smooth.py: raster SDF machinery (rasterize, signed
// distance, morphological closing by distance threshold), sub-pixel
// offset / symmetrize via marching squares on the SDF, periodic
// P-splines with the containment inflation loop, and scallop blending.
// `c` is the ready OpenCV instance; PX mirrors the reference 20 px/mm.
import {
  roundHalfEven, gaussianFilter1d, interp, solve, mapCoordinatesBilinear, GridNN,
} from "./nummath.js";
import { designMatrix, evalPeriodic } from "./bspline.js";
import { findContours } from "./marching.js";

export const PX = 20.0;
export const CONTAIN_TOL = 0.05;
export const OUT_CAP = 2.5;
export const RESAMPLE = 0.25;
export const KNOT_MM = 3.0;
export const LAM_BASE = 3e-7;

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function polyMat(c, pts, origin, scale) {
  const flat = new Int32Array(pts.length * 2);
  pts.forEach((p, i) => {
    flat[2 * i] = roundHalfEven((p[0] - origin[0]) * scale);
    flat[2 * i + 1] = roundHalfEven((p[1] - origin[1]) * scale);
  });
  return c.matFromArray(pts.length, 1, c.CV_32SC2, flat);
}

/** cv2.fillPoly of mm polygons into a fresh 0/1 CV_8UC1 mask.
 *  One fillPoly call PER polygon: a single call with several contours
 *  fills even-odd, turning overlaps into holes (reference loops too). */
export function fillMask(c, h, w, polys, origin) {
  const mask = c.Mat.zeros(h, w, c.CV_8UC1);
  for (const p of polys) {
    const m = polyMat(c, p, origin, PX);
    const vec = new c.MatVector();
    vec.push_back(m);
    c.fillPoly(mask, vec, new c.Scalar(1));
    m.delete(); vec.delete();
  }
  return mask;
}

export function rasterize(c, contourMm, marginMm) {
  const b = bbox(contourMm);
  const origin = [b.x0 - marginMm, b.y0 - marginMm];
  const w = (b.x1 - b.x0 + 2 * marginMm) * PX;
  const h = (b.y1 - b.y0 + 2 * marginMm) * PX;
  const mask = fillMask(c, Math.trunc(h) + 2, Math.trunc(w) + 2, [contourMm], origin);
  return { mask, origin };
}

/** Signed distance in px, positive outside (float32 data). */
export function sdf(c, mask) {
  const inv = new c.Mat();
  const one = new c.Mat(mask.rows, mask.cols, c.CV_8UC1, new c.Scalar(1));
  c.subtract(one, mask, inv);
  one.delete();
  const dIn = new c.Mat(), dOut = new c.Mat();
  c.distanceTransform(mask, dIn, c.DIST_L2, 5);
  c.distanceTransform(inv, dOut, c.DIST_L2, 5);
  inv.delete();
  const out = new Float32Array(mask.rows * mask.cols);
  const a = dOut.data32F, b = dIn.data32F;
  for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
  dIn.delete(); dOut.delete();
  return out; // row-major, mask.cols wide
}

/** Morphological closing via distance thresholds (reference _closing). */
export function closing(c, mask, rPx) {
  const inv = new c.Mat();
  const one = new c.Mat(mask.rows, mask.cols, c.CV_8UC1, new c.Scalar(1));
  c.subtract(one, mask, inv);
  one.delete();
  const d = new c.Mat();
  c.distanceTransform(inv, d, c.DIST_L2, 5);
  inv.delete();
  const dil = new c.Mat(mask.rows, mask.cols, c.CV_8UC1);
  {
    const dd = d.data32F, md = mask.data, od = dil.data;
    for (let i = 0; i < od.length; i++) od[i] = dd[i] <= rPx || md[i] ? 1 : 0;
  }
  d.delete();
  const d2 = new c.Mat();
  c.distanceTransform(dil, d2, c.DIST_L2, 5);
  dil.delete();
  const out = new c.Mat(mask.rows, mask.cols, c.CV_8UC1);
  {
    const dd = d2.data32F, od = out.data;
    for (let i = 0; i < od.length; i++) od[i] = dd[i] > rPx ? 1 : 0;
  }
  d2.delete();
  return out;
}

export function ccw(pts) {
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = i === 0 ? pts.length - 1 : i - 1;
    a2 += pts[i][0] * pts[j][1] - pts[i][1] * pts[j][0];
  }
  return 0.5 * a2 > 0 ? [...pts].reverse() : pts;
}

export function resampleClosed(p, step) {
  const q = [...p, p[0]];
  const s = new Float64Array(q.length);
  for (let i = 1; i < q.length; i++) {
    s[i] = s[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  }
  const m = Math.ceil(s[s.length - 1] / step);
  const t = Float64Array.from({ length: m }, (_, i) => i * step);
  const xs = interp(t, s, q.map((v) => v[0]));
  const ys = interp(t, s, q.map((v) => v[1]));
  return Array.from(xs, (x, i) => [x, ys[i]]);
}

/** Longest marching-squares contour of a float field at `level`,
 *  returned in (x, y) px order. */
function longestContour(field, rows, cols, level) {
  const cs = findContours(field, rows, cols, level);
  let best = cs[0];
  for (const cc of cs) if (cc.length > best.length) best = cc;
  return best.map(([r, col]) => [col, r]);
}

export function symmetrizeContour(c, contourMm, blend = 1.5) {
  const mirror = contourMm.map(([x, y]) => [-x, y]);
  const b = bbox([...contourMm, ...mirror]);
  const margin = blend + 4.0;
  const origin = [b.x0 - margin, b.y0 - margin];
  const w = b.x1 - b.x0 + 2 * margin, h = b.y1 - b.y0 + 2 * margin;
  const mask = fillMask(c, Math.trunc(h * PX) + 2, Math.trunc(w * PX) + 2,
    [contourMm, mirror], origin);
  const closed = closing(c, mask, blend * PX);
  mask.delete();
  const sd = sdf(c, closed);
  const rows = closed.rows, cols = closed.cols;
  closed.delete();
  const cPx = longestContour(sd, rows, cols, 0.0);
  return ccw(cPx.map(([x, y]) => [x / PX + origin[0], y / PX + origin[1]]));
}

export function offsetContour(c, contourMm, clearance) {
  const { mask, origin } = rasterize(c, contourMm, clearance + 5.0);
  const sd = sdf(c, mask);
  const rows = mask.rows, cols = mask.cols;
  mask.delete();
  const cPx = longestContour(sd, rows, cols, clearance * PX);
  return ccw(cPx.map(([x, y]) => [x / PX + origin[0], y / PX + origin[1]]));
}

/** Periodic cubic P-spline through closed q. Returns { tExt, C, k }. */
export function periodicFit(q, lamScale, knotMm = KNOT_MM) {
  const n = q.length;
  const segLens = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segLens[i] = Math.hypot(q[j][0] - q[i][0], q[j][1] - q[i][1]);
  }
  let L = 0;
  for (const v of segLens) L += v;
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) u[i] = u[i - 1] + segLens[i - 1];
  for (let i = 0; i < n; i++) u[i] /= L;
  const nseg = Math.max(8, roundHalfEven(L / knotMm));
  const k = 3;
  const tExt = Array.from({ length: nseg + 2 * k + 1 }, (_, i) => (i - k) / nseg);
  const rows = designMatrix(Array.from(u), tExt, k);

  // W^T W and W^T q with wrapped columns, assembled sparsely
  const WtW = Array.from({ length: nseg }, () => new Float64Array(nseg));
  const Wtq = Array.from({ length: nseg }, () => new Float64Array(2));
  for (let r = 0; r < n; r++) {
    const { start, vals } = rows[r];
    for (let a = 0; a <= k; a++) {
      const ca = (((start + a) % nseg) + nseg) % nseg;
      const va = vals[a];
      Wtq[ca][0] += va * q[r][0];
      Wtq[ca][1] += va * q[r][1];
      for (let b2 = 0; b2 <= k; b2++) {
        const cb = (((start + b2) % nseg) + nseg) % nseg;
        WtW[ca][cb] += va * vals[b2];
      }
    }
  }
  // cyclic second-difference penalty: D^T D added densely
  const lam = lamScale * n * nseg ** 3;
  const M = WtW;
  for (let i = 0; i < nseg; i++) {
    // row i of D: -2 at i, +1 at i±1
    const cols = [[i, -2], [(i + 1) % nseg, 1], [(i - 1 + nseg) % nseg, 1]];
    for (const [ca, va] of cols) {
      for (const [cb, vb] of cols) M[ca][cb] += lam * va * vb;
    }
  }
  const C = solve(M, Wtq).map((r) => [r[0], r[1]]);
  return { tExt, C, k };
}

export function curvaturePeriodic(tck, m = 4000) {
  const [pts, d1, d2] = evalPeriodic(tck.tExt, tck.C, tck.k, m, 2);
  const kap = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const sp = Math.max(Math.hypot(d1[i][0], d1[i][1]), 1e-12);
    kap[i] = (d1[i][0] * d2[i][1] - d1[i][1] * d2[i][0]) / sp ** 3;
  }
  return { pts, kap };
}

export function addScallops(c, basePts, scallops, d, blend = 4.0, log = () => {}) {
  const extra = [];
  for (const s of scallops) {
    extra.push([s[0] + d / 2, s[1] + d / 2], [s[0] - d / 2, s[1] - d / 2]);
  }
  const b = bbox([...basePts, ...extra]);
  const margin = blend * 2 + 3.0;
  const origin = [b.x0 - margin, b.y0 - margin];
  const w = b.x1 - b.x0 + 2 * margin, h = b.y1 - b.y0 + 2 * margin;
  const H = Math.trunc(h * PX) + 2, W = Math.trunc(w * PX) + 2;
  const mask = fillMask(c, H, W, [basePts], origin);
  const zone = c.Mat.zeros(H, W, c.CV_8UC1);
  for (const [sx, sy] of scallops) {
    const cx = Math.trunc(roundHalfEven((sx - origin[0]) * PX));
    const cy = Math.trunc(roundHalfEven((sy - origin[1]) * PX));
    c.circle(mask, new c.Point(cx, cy), Math.trunc(roundHalfEven((d / 2) * PX)),
      new c.Scalar(1), -1);
    c.circle(zone, new c.Point(cx, cy),
      Math.trunc(roundHalfEven((d / 2 + 2 * blend) * PX)), new c.Scalar(1), -1);
  }
  const closed = closing(c, mask, blend * PX);
  const final = new c.Mat(H, W, c.CV_8UC1);
  {
    const zd = zone.data, cd = closed.data, md = mask.data, fd = final.data;
    for (let i = 0; i < fd.length; i++) fd[i] = zd[i] > 0 ? cd[i] : md[i];
  }
  mask.delete(); zone.delete(); closed.delete();
  const sd = sdf(c, final);
  final.delete();
  const cPx = longestContour(sd, H, W, 0.0);
  const cMm = ccw(cPx.map(([x, y]) => [x / PX + origin[0], y / PX + origin[1]]));
  const q = resampleClosed(cMm, 0.2);
  const tree = new GridNN(q, 1.0);
  let tck = null, pts = null, dev = Infinity;
  for (const mult of [3, 1, 0.3, 0.1, 0.03, 0.01, 0.003, 0.001, 0.0003, 0.0001]) {
    tck = periodicFit(q, LAM_BASE * mult, 1.25);
    pts = evalPeriodic(tck.tExt, tck.C, tck.k, 8000);
    dev = 0;
    for (const [x, y] of pts) {
      const dd = tree.query(x, y).dist;
      if (dd > dev) dev = dd;
    }
    if (dev <= 0.15) break;
  }
  log(`scallops blended (r ${blend} mm junctions), refit dev ${dev.toFixed(3)} mm`);
  return { tck, pts };
}

export function smoothProfile(c, contourMm, clearance, radius, log = () => {}) {
  const margin = clearance + radius + OUT_CAP + 5.0;
  const { mask, origin } = rasterize(c, contourMm, margin);
  const sdTool = sdf(c, mask);
  const H = mask.rows, W = mask.cols;

  // scipy map_coordinates keeps the input's float32 dtype, so every
  // sampled value is float32-rounded before later math — mirror that.
  const sdAt = (pts) => {
    const rows = pts.map((p) => (p[1] - origin[1]) * PX);
    const cols = pts.map((p) => (p[0] - origin[0]) * PX);
    const v = mapCoordinatesBilinear(sdTool, H, W, rows, cols);
    return Float64Array.from(v, (x) => Math.fround(x) / PX);
  };
  const gradAt = (pts) => {
    const rows = pts.map((p) => (p[1] - origin[1]) * PX);
    const cols = pts.map((p) => (p[0] - origin[0]) * PX);
    const xp = mapCoordinatesBilinear(sdTool, H, W, rows, cols.map((v) => v + 1));
    const xm = mapCoordinatesBilinear(sdTool, H, W, rows, cols.map((v) => v - 1));
    const yp = mapCoordinatesBilinear(sdTool, H, W, rows.map((v) => v + 1), cols);
    const ym = mapCoordinatesBilinear(sdTool, H, W, rows.map((v) => v - 1), cols);
    return pts.map((_, i) => {
      const gx = Math.fround(Math.fround(xp[i]) - Math.fround(xm[i]));
      const gy = Math.fround(Math.fround(yp[i]) - Math.fround(ym[i]));
      const n = Math.max(Math.fround(Math.hypot(gx, gy)), 1e-9);
      return [gx / n, gy / n];
    });
  };

  const grown = new c.Mat(H, W, c.CV_8UC1);
  {
    const gd = grown.data;
    for (let i = 0; i < gd.length; i++) gd[i] = sdTool[i] <= clearance * PX ? 1 : 0;
  }
  mask.delete();
  const closed = closing(c, grown, radius * PX);
  grown.delete();
  const sdClosed = sdf(c, closed);
  closed.delete();
  const cPx = longestContour(sdClosed, H, W, 0.0);
  const cMm = ccw(cPx.map(([x, y]) => [x / PX + origin[0], y / PX + origin[1]]));
  const q = resampleClosed(cMm, RESAMPLE);
  const treeQ = new GridNN(q, 1.0);

  let chosen = null;
  let tck = null, pts = null, mc = -Infinity, devOut = Infinity, multUsed = 0;
  for (const mult of [3000, 1000, 300, 100, 30, 10, 3, 1, 0.3, 0.1, 0.03]) {
    let qw = q.map((p) => [p[0], p[1]]);
    multUsed = mult;
    for (let it = 0; it < 20; it++) {
      tck = periodicFit(qw, LAM_BASE * mult);
      pts = evalPeriodic(tck.tExt, tck.C, tck.k, 4000);
      const sdv = sdAt(pts);
      mc = Infinity;
      for (const v of sdv) if (v < mc) mc = v;
      devOut = 0;
      for (const [x, y] of pts) {
        const dd = treeQ.query(x, y).dist;
        if (dd > devOut) devOut = dd;
      }
      if (mc >= clearance - CONTAIN_TOL) break;
      // inflate: push data outward where the curve intrudes
      const push = new Float64Array(qw.length);
      const treeW = new GridNN(qw, 1.0);
      for (let i = 0; i < pts.length; i++) {
        const viol = clearance + 0.1 - sdv[i];
        if (viol > 0) {
          const { idx } = treeW.query(pts[i][0], pts[i][1]);
          if (viol > push[idx]) push[idx] = viol;
        }
      }
      const sm = gaussianFilter1d(push, 10);
      const g = gradAt(qw);
      qw = qw.map((p, i) => [p[0] + g[i][0] * sm[i] * 2.0,
                             p[1] + g[i][1] * sm[i] * 2.0]);
    }
    if (mc >= clearance - CONTAIN_TOL && devOut <= OUT_CAP) {
      chosen = { tck, pts, mc, mult, devOut };
      break;
    }
  }
  if (!chosen) {
    chosen = { tck, pts, mc, mult: multUsed, devOut };
    log(`WARNING: smooth fit did not converge (clearance ${mc.toFixed(2)}, ` +
        `bulge ${devOut.toFixed(2)} mm)`);
  }
  const { kap } = curvaturePeriodic(chosen.tck);
  let kMax = 0;
  for (const v of kap) if (Math.abs(v) > kMax) kMax = Math.abs(v);
  const rmin = kMax > 0 ? 1 / kMax : Infinity;
  log(`smooth profile: closing R ${radius} mm, lam x${chosen.mult}, ` +
      `${chosen.tck.C.length} ctrl pts, min clearance ${chosen.mc.toFixed(2)} mm, ` +
      `max bulge ${chosen.devOut.toFixed(2)} mm, min radius ${rmin.toFixed(1)} mm`);
  return { tck: chosen.tck, fit: chosen.pts, kap,
           minClearance: chosen.mc, closingQ: q };
}

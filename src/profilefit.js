// Port of scan2step/profile.py: multi-scale corner detection and
// per-segment clamped cubic P-splines with the per-segment lambda
// search. Pure math — no OpenCV. Hard-won reference lessons apply:
// never interpolate through raw samples, lambda search goes below x1,
// refined corners must stay on the measured contour, hooks at clamped
// ends revert refinement.
import {
  gaussianFilter1d, interp, solve, principalDir, mean2, GridNN,
} from "./nummath.js";
import { designMatrix, splev } from "./bspline.js";

export const STEP = 0.1;
export const KNOT_MM = 3.0;
export const LAM_BASE = 3e-7;
export const RMS_BUDGET = 0.12;
export const MAX_BUDGET = 0.45;
export const HOOK_RADIUS = 0.25;

export function resample(p, step = STEP) {
  const q = [...p, p[0]];
  const s = new Float64Array(q.length);
  for (let i = 1; i < q.length; i++) {
    s[i] = s[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  }
  const m = Math.ceil(s[s.length - 1] / step); // np.arange(0, L, step) count
  const t = Float64Array.from({ length: Math.max(m, 0) }, (_, i) => i * step);
  const xs = interp(t, s, q.map((v) => v[0]));
  const ys = interp(t, s, q.map((v) => v[1]));
  return Array.from(xs, (x, i) => [x, ys[i]]);
}

function turning(p, hw) {
  const N = p.length;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const f = p[(i + hw) % N], b = p[(((i - hw) % N) + N) % N], c = p[i];
    const ax = f[0] - c[0], ay = f[1] - c[1];
    const bx = c[0] - b[0], by = c[1] - b[1];
    out[i] = (Math.atan2(bx * ay - by * ax, ax * bx + ay * by) * 180) / Math.PI;
  }
  return out;
}

function smoothXY(p, sigma) {
  const xs = gaussianFilter1d(p.map((v) => v[0]), sigma);
  const ys = gaussianFilter1d(p.map((v) => v[1]), sigma);
  return Array.from(xs, (x, i) => [x, ys[i]]);
}

export function detectCorners(p, log = () => {}) {
  const N = p.length;
  const ps = smoothXY(p, 4);
  const q8 = smoothXY(p, 2);
  const ang = turning(ps, 15);
  const ang2 = turning(ps, 30);
  const ang8 = turning(q8, 8);

  const winMaxAbs = (arr, i, hw) => {
    let m = 0;
    for (let j = i - hw; j <= i + hw; j++) {
      const v = Math.abs(arr[((j % N) + N) % N]);
      if (v > m) m = v;
    }
    return m;
  };

  const cand = [];
  for (let i = 0; i < N; i++) {
    if (Math.abs(ang[i]) >= 35 &&
        Math.abs(ang[i]) === winMaxAbs(ang, i, 15) &&
        Math.abs(ang2[i]) >= 20 &&
        Math.sign(ang2[i]) === Math.sign(ang[i]) &&
        winMaxAbs(ang8, i, 15) >= 45) {
      cand.push(i);
    }
  }
  const corners = [];
  for (const i of cand) {
    if (!corners.length ||
        ((i - corners[corners.length - 1]) % N + N) % N > 25) {
      corners.push(i);
    }
  }
  if (corners.length &&
      ((corners[0] - corners[corners.length - 1]) % N + N) % N <= 25) {
    corners.pop();
  }

  // refine to tangent-line intersections, kept on the measured contour
  const tline = (lo, hi) => {
    const q = [];
    for (let j = lo; j < hi; j++) q.push(p[((j % N) + N) % N]);
    const m = mean2(q);
    return [m, principalDir(q, m)];
  };
  const tree = new GridNN(p, 1.0);
  const refined = new Map();
  for (const i of corners) {
    const [m1, d1] = tline(i - 30, i - 5);
    const [m2, d2] = tline(i + 5, i + 30);
    const det = d1[0] * -d2[1] - -d2[0] * d1[1];
    if (Math.abs(det) < 0.2) { refined.set(i, p[i]); continue; }
    const rx = m2[0] - m1[0], ry = m2[1] - m1[1];
    const t0 = (rx * -d2[1] - -d2[0] * ry) / det; // Cramer on [d1, -d2]
    const X = [m1[0] + t0 * d1[0], m1[1] + t0 * d1[1]];
    const onData = tree.query(X[0], X[1]).dist < 0.4;
    const near = Math.hypot(X[0] - p[i][0], X[1] - p[i][1]) < 1.5;
    refined.set(i, near && onData ? X : p[i]);
  }
  log(`${corners.length} corners: ` + corners.map((i) =>
    `(${p[i][0].toFixed(1)},${p[i][1].toFixed(1)}) ${ang[i] >= 0 ? "+" : ""}${ang[i].toFixed(0)}deg`).join(", "));
  return { corners, refined, ang };
}

/** Clamped cubic P-spline through q. Returns { t, cx, cy, k, dev }. */
export function pspline(q, lamScale) {
  const n = q.length;
  const d = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    d[i] = d[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
  }
  const L = d[n - 1];
  const u = Array.from(d, (v) => v / L);
  const nseg = Math.max(1, Math.round(L / KNOT_MM));
  const k = 3;
  const t = [
    ...Array(k).fill(0),
    ...Array.from({ length: nseg + 1 }, (_, i) => i / nseg),
    ...Array(k).fill(1),
  ];
  const nc = t.length - k - 1;
  const rows = designMatrix(u, t, k);

  // normal equations on the free (interior) coefficients, endpoints clamped
  const nf = nc - 2;
  const M = Array.from({ length: nf }, () => new Float64Array(nf));
  const R = Array.from({ length: nf }, () => new Float64Array(2));
  const q0 = q[0], qe = q[n - 1];
  for (let r = 0; r < n; r++) {
    const { start, vals } = rows[r];
    // rhs_r = q_r - B[r,0]*q0 - B[r,nc-1]*qe
    let b0 = 0, bl = 0;
    for (let j = 0; j <= k; j++) {
      const cidx = start + j;
      if (cidx === 0) b0 = vals[j];
      if (cidx === nc - 1) bl = vals[j];
    }
    const rhs = [q[r][0] - b0 * q0[0] - bl * qe[0],
                 q[r][1] - b0 * q0[1] - bl * qe[1]];
    for (let j = 0; j <= k; j++) {
      const ci = start + j - 1; // free index
      if (ci < 0 || ci >= nf) continue;
      const vj = vals[j];
      R[ci][0] += vj * rhs[0];
      R[ci][1] += vj * rhs[1];
      for (let j2 = 0; j2 <= k; j2++) {
        const ci2 = start + j2 - 1;
        if (ci2 < 0 || ci2 >= nf) continue;
        M[ci][ci2] += vj * vals[j2];
      }
    }
  }
  // second-difference penalty D (nc-2 x nc): row i = e_i - 2e_{i+1} + e_{i+2}
  const lam = lamScale * n * nseg ** 3;
  const dRow = [1, -2, 1];
  for (let i = 0; i < nc - 2; i++) {
    // D[i, col] for col = i..i+2; dr contribution from cols 0 and nc-1
    let dr0 = 0, dr1 = 0;
    for (let a = 0; a < 3; a++) {
      const col = i + a;
      if (col === 0) { dr0 -= dRow[a] * q0[0]; dr1 -= dRow[a] * q0[1]; }
      if (col === nc - 1) { dr0 -= dRow[a] * qe[0]; dr1 -= dRow[a] * qe[1]; }
    }
    for (let a = 0; a < 3; a++) {
      const ca = i + a - 1;
      if (ca < 0 || ca >= nf) continue;
      R[ca][0] += lam * dRow[a] * dr0;
      R[ca][1] += lam * dRow[a] * dr1;
      for (let b = 0; b < 3; b++) {
        const cb = i + b - 1;
        if (cb < 0 || cb >= nf) continue;
        M[ca][cb] += lam * dRow[a] * dRow[b];
      }
    }
  }
  const cf = solve(M, R);
  const cx = [q0[0], ...cf.map((r) => r[0]), qe[0]];
  const cy = [q0[1], ...cf.map((r) => r[1]), qe[1]];
  const dev = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const { start, vals } = rows[r];
    let fx = 0, fy = 0;
    for (let j = 0; j <= k; j++) {
      fx += vals[j] * cx[start + j];
      fy += vals[j] * cy[start + j];
    }
    dev[r] = Math.hypot(fx - q[r][0], fy - q[r][1]);
  }
  return { t, cx, cy, k, dev };
}

const MULTS = [0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000];

export function fitSegment(q, log = () => {}, tag = "") {
  let best = null;
  for (const mult of MULTS) {
    const s = pspline(q, LAM_BASE * mult);
    let ss = 0, mx = 0;
    for (const v of s.dev) { ss += v * v; if (v > mx) mx = v; }
    const rms = Math.sqrt(ss / s.dev.length);
    if (rms <= RMS_BUDGET && mx <= MAX_BUDGET) best = { tck: s, rms, max: mx, mult };
    else if (best !== null) break;
  }
  if (best === null) {
    const s = pspline(q, LAM_BASE * 0.003);
    let ss = 0, mx = 0;
    for (const v of s.dev) { ss += v * v; if (v > mx) mx = v; }
    best = { tck: s, rms: Math.sqrt(ss / s.dev.length), max: mx, mult: 0.003 };
    log(`WARNING segment ${tag}: fit over budget (rms ${best.rms.toFixed(3)}, ` +
        `max ${best.max.toFixed(3)} mm)`);
  }
  return best;
}

function linspace(a, b, n) {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}

function minRadiusEnd(tck) {
  const u = linspace(0, 1, 2000);
  const d1 = splev(u, tck.t, tck.cx, tck.cy, tck.k, 1);
  const d2 = splev(u, tck.t, tck.cx, tck.cy, tck.k, 2);
  let kMax = -Infinity, iMax = 0;
  for (let i = 0; i < u.length; i++) {
    const sp = Math.max(Math.hypot(d1[i][0], d1[i][1]), 1e-12);
    const kap = Math.abs((d1[i][0] * d2[i][1] - d1[i][1] * d2[i][0]) / sp ** 3);
    if (kap > kMax) { kMax = kap; iMax = i; }
  }
  const r = kMax > 0 ? 1 / kMax : Infinity;
  return { r, atStart: iMax < u.length / 2 };
}

export function fitProfile(p, corners, refined, log = () => {}) {
  const N = p.length;
  if (!corners.length) {
    const ang = turning(smoothXY(p, 4), 15);
    let i0 = 0;
    for (let i = 1; i < N; i++) if (Math.abs(ang[i]) > Math.abs(ang[i0])) i0 = i;
    log("WARNING: no corners found; closing loop with a C0 join at max curvature");
    corners = [i0];
    refined = new Map([[i0, p[i0]]]);
  }
  const cs = [...corners, corners[0] + N];
  const spans = cs.slice(0, -1).map((a, i) => [a, cs[i + 1]]);

  const fitOne = (i0, i1) => {
    const segLen = i1 - i0;
    const drop = Math.min(10, Math.max(1, Math.trunc(segLen / 5)));
    const q = [refined.get(((i0 % N) + N) % N)];
    for (let j = i0 + drop; j <= i1 - drop; j++) q.push(p[((j % N) + N) % N]);
    q.push(refined.get(((i1 % N) + N) % N));
    const { tck, rms, max, mult } = fitSegment(q, log, `${i0}-${i1}`);
    return [tck, { rms, max, lam_mult: mult, n_ctrl: tck.cx.length,
                   arc_mm: segLen * STEP }];
  };

  const segs = [], report = [];
  for (const [i0, i1] of spans) {
    const [tck, rep] = fitOne(i0, i1);
    segs.push(tck); report.push(rep);
  }

  for (let pass = 0; pass < 3; pass++) {
    const bad = new Set();
    segs.forEach((tck, j) => {
      const { r, atStart } = minRadiusEnd(tck);
      if (r < HOOK_RADIUS) {
        const ci = (((atStart ? spans[j][0] : spans[j][1]) % N) + N) % N;
        const rf = refined.get(ci);
        if (rf[0] !== p[ci][0] || rf[1] !== p[ci][1]) {
          bad.add(ci);
          log(`hook (R=${r.toFixed(4)} mm) at corner ` +
              `(${p[ci][0].toFixed(1)},${p[ci][1].toFixed(1)}); reverting refinement`);
        }
      }
    });
    if (!bad.size) break;
    for (const ci of bad) refined.set(ci, p[ci]);
    spans.forEach(([i0, i1], j) => {
      if (bad.has(((i0 % N) + N) % N) || bad.has(((i1 % N) + N) % N)) {
        const [tck, rep] = fitOne(i0, i1);
        segs[j] = tck; report[j] = rep;
      }
    });
  }
  for (const r of report) {
    log(`seg arc ${r.arc_mm.toFixed(1)} mm  ctrl ${r.n_ctrl}  lam x${r.lam_mult}` +
        ` rms ${r.rms.toFixed(3)}  max ${r.max.toFixed(3)} mm`);
  }
  return { segs, report };
}

/** Dense samples + signed curvature per segment (n each). */
export function sampleSegs(segs, n = 2000) {
  const pts = [], curv = [];
  for (const tck of segs) {
    const u = linspace(0, 1, n);
    const s0 = splev(u, tck.t, tck.cx, tck.cy, tck.k, 0);
    const d1 = splev(u, tck.t, tck.cx, tck.cy, tck.k, 1);
    const d2 = splev(u, tck.t, tck.cx, tck.cy, tck.k, 2);
    const kap = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const sp = Math.max(Math.hypot(d1[i][0], d1[i][1]), 1e-12);
      kap[i] = (d1[i][0] * d2[i][1] - d1[i][1] * d2[i][0]) / sp ** 3;
    }
    pts.push(s0); curv.push(kap);
  }
  return { pts, curv };
}

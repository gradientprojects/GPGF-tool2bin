// Cubic B-spline kernel equivalent to the scipy pieces the reference
// uses: BSpline.design_matrix, splev (values + derivatives), and the
// periodic evaluation trick in smooth.py (coefficients wrapped mod nseg).

/** Index of the knot span containing u: t[span] <= u < t[span+1],
 *  with u == t[n] mapping to the last non-empty span (scipy behavior). */
function findSpan(t, k, u) {
  const n = t.length - k - 1; // number of basis functions
  if (u >= t[n]) {
    let s = n - 1;
    while (s > 0 && t[s] === t[s + 1]) s--;
    return s;
  }
  let lo = k, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= u) lo = mid; else hi = mid;
  }
  return lo;
}

/** Nonzero basis values N_{span-k..span,k}(u) (Cox–de Boor, de Boor's alg). */
function basisFuns(t, k, span, u) {
  const N = new Float64Array(k + 1);
  const left = new Float64Array(k + 1);
  const right = new Float64Array(k + 1);
  N[0] = 1;
  for (let j = 1; j <= k; j++) {
    left[j] = u - t[span + 1 - j];
    right[j] = t[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom !== 0 ? N[r] / denom : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** BSpline.design_matrix(u[], t, k) as sparse rows {start, vals[k+1]}. */
export function designMatrix(us, t, k) {
  return Array.from(us, (u) => {
    const span = findSpan(t, k, u);
    return { start: span - k, vals: basisFuns(t, k, span, u) };
  });
}

/** Evaluate a (possibly vector-valued) spline at u. coef: (nc x dim). */
export function evalBSpline(t, coef, k, u) {
  const span = findSpan(t, k, u);
  const N = basisFuns(t, k, span, u);
  const dim = coef[0].length;
  const out = new Float64Array(dim);
  for (let j = 0; j <= k; j++) {
    const c = coef[span - k + j];
    for (let d = 0; d < dim; d++) out[d] += N[j] * c[d];
  }
  return out;
}

/** Derivative spline (t', coef', k-1) — scipy BSpline.derivative(1). */
export function derivative(t, coef, k) {
  const nc = coef.length;
  const dim = coef[0].length;
  const dcoef = [];
  for (let i = 0; i < nc - 1; i++) {
    const dt = t[i + k + 1] - t[i + 1];
    const row = new Float64Array(dim);
    if (dt !== 0) {
      for (let d = 0; d < dim; d++) row[d] = (k * (coef[i + 1][d] - coef[i][d])) / dt;
    }
    dcoef.push(row);
  }
  return { t: t.slice(1, t.length - 1), coef: dcoef, k: k - 1 };
}

/** splev(u[], (t, [cx, cy], k), der) -> (n x 2) points. */
export function splev(us, t, cx, cy, k, der = 0) {
  let tt = Array.from(t);
  let coef = cx.map((x, i) => [x, cy[i]]);
  let kk = k;
  for (let d = 0; d < der; d++) {
    const dd = derivative(tt, coef, kk);
    tt = dd.t; coef = dd.coef; kk = dd.k;
  }
  return us.map((u) => {
    const v = evalBSpline(tt, coef, kk, u);
    return [v[0], v[1]];
  });
}

/** smooth.py eval_periodic: tck = {tExt, C (nseg x 2), k}. */
export function evalPeriodic(tExt, C, k, m = 4000, der = 0) {
  const nseg = C.length;
  const coef = [];
  for (let i = 0; i < nseg + k; i++) coef.push(C[i % nseg]);
  const us = Array.from({ length: m }, (_, i) => i / m);
  const pts = splev(us, tExt, coef.map((c) => c[0]), coef.map((c) => c[1]), k, 0);
  if (der === 0) return pts;
  const d1 = splev(us, tExt, coef.map((c) => c[0]), coef.map((c) => c[1]), k, 1);
  const d2 = splev(us, tExt, coef.map((c) => c[0]), coef.map((c) => c[1]), k, 2);
  return [pts, d1, d2];
}

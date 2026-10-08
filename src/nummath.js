// Small numeric kernel for the profile-math port: the scipy/numpy
// building blocks profile.py and smooth.py lean on, ported exactly.
// Everything is float64 (JS numbers), matching the reference dtypes.

/** np.round / python round: banker's rounding (half to even). */
export function roundHalfEven(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** scipy.ndimage.gaussian_filter1d(x, sigma, mode="wrap"), truncate=4. */
export function gaussianFilter1d(x, sigma) {
  const lw = Math.trunc(4.0 * sigma + 0.5);
  const w = new Float64Array(2 * lw + 1);
  let s = 0;
  for (let i = -lw; i <= lw; i++) {
    const v = Math.exp(-0.5 * (i * i) / (sigma * sigma));
    w[i + lw] = v; s += v;
  }
  for (let i = 0; i < w.length; i++) w[i] /= s;
  const n = x.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -lw; j <= lw; j++) {
      acc += w[j + lw] * x[(((i + j) % n) + n) % n];
    }
    out[i] = acc;
  }
  return out;
}

/** np.interp over increasing xp (clamped ends), vectorized over t[]. */
export function interp(t, xp, fp) {
  const out = new Float64Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const v = t[i];
    if (v <= xp[0]) { out[i] = fp[0]; continue; }
    if (v >= xp[xp.length - 1]) { out[i] = fp[fp.length - 1]; continue; }
    let lo = 0, hi = xp.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xp[mid] <= v) lo = mid; else hi = mid;
    }
    const f = (v - xp[lo]) / (xp[hi] - xp[lo]);
    out[i] = fp[lo] + f * (fp[hi] - fp[lo]);
  }
  return out;
}

/** Dense LU solve with partial pivoting; B may be (n) or (n x m). */
export function solve(A, B) {
  const n = A.length;
  const a = A.map((row) => Float64Array.from(row));
  const vec = !Array.isArray(B[0]) && !(B[0] instanceof Float64Array);
  const m = vec ? 1 : B[0].length;
  const b = new Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = vec ? Float64Array.of(B[i]) : Float64Array.from(B[i]);
  }
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (a[piv][col] === 0) throw new Error("singular matrix");
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv], a[col]];
      [b[col], b[piv]] = [b[piv], b[col]];
    }
    const d = a[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / d;
      if (f === 0) continue;
      a[r][col] = 0;
      for (let c2 = col + 1; c2 < n; c2++) a[r][c2] -= f * a[col][c2];
      for (let c2 = 0; c2 < m; c2++) b[r][c2] -= f * b[col][c2];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let c2 = 0; c2 < m; c2++) {
      let acc = b[r][c2];
      for (let k = r + 1; k < n; k++) acc -= a[r][k] * b[k][c2];
      b[r][c2] = acc / a[r][r];
    }
  }
  return vec ? b.map((row) => row[0]) : b.map((row) => Array.from(row));
}

/** scipy map_coordinates(img, [rows, cols], order=1), in-bounds inputs. */
export function mapCoordinatesBilinear(img, H, W, rows, cols) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    let r = rows[i], c = cols[i];
    if (r < 0 || c < 0 || r > H - 1 || c > W - 1) {
      // mode="constant" cval=0 with order=1: linear falloff at the border
      // is not needed by our callers (margins guarantee in-bounds); treat
      // genuinely outside as 0 like scipy's constant mode at integer dist.
      if (r < -1 || c < -1 || r > H || c > W) { out[i] = 0; continue; }
      // partial cell at the edge: clamp-free bilinear with zero outside
      const r0 = Math.floor(r), c0 = Math.floor(c);
      const fr = r - r0, fc = c - c0;
      const at = (rr, cc) =>
        rr >= 0 && rr < H && cc >= 0 && cc < W ? img[rr * W + cc] : 0;
      out[i] = at(r0, c0) * (1 - fr) * (1 - fc) + at(r0, c0 + 1) * (1 - fr) * fc +
               at(r0 + 1, c0) * fr * (1 - fc) + at(r0 + 1, c0 + 1) * fr * fc;
      continue;
    }
    const r0 = Math.min(Math.floor(r), H - 2), c0 = Math.min(Math.floor(c), W - 2);
    const fr = r - r0, fc = c - c0;
    const i00 = r0 * W + c0;
    out[i] = img[i00] * (1 - fr) * (1 - fc) + img[i00 + 1] * (1 - fr) * fc +
             img[i00 + W] * fr * (1 - fc) + img[i00 + W + 1] * fr * fc;
  }
  return out;
}

/** Exact nearest neighbor over 2D points (cKDTree.query replacement;
 *  returns {dist, idx}). A static k-d tree: query cost stays ~log n
 *  however far the query point is from the data (the smooth-fit ladder
 *  queries from stiff curves sitting up to ~20 mm off the outline,
 *  which made the old grid's ring search the profile's hot spot).
 *  Ties resolve to the lowest index, and d2 is computed exactly as
 *  before, so results are bit-identical to a brute-force argmin.
 *  `cell` is unused (kept for the old grid's signature). */
const LEAF = 8;
export class GridNN {
  constructor(pts, cell = 1.0) {
    const n = pts.length;
    this.pts = pts;
    const xs = this.xs = new Float64Array(n);
    const ys = this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) { xs[i] = pts[i][0]; ys[i] = pts[i][1]; }
    const idx = this.idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    // implicit tree over idx ranges: node = {lo, hi, axis, split, l, r}
    this.nodes = [];
    if (n) this.root = this.build(0, n);
  }
  build(lo, hi) {
    const { xs, ys, idx } = this;
    const id = this.nodes.length;
    const node = { lo, hi, axis: -1, split: 0, l: -1, r: -1 };
    this.nodes.push(node);
    if (hi - lo <= LEAF) return id;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = lo; k < hi; k++) {
      const x = xs[idx[k]], y = ys[idx[k]];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const axis = x1 - x0 >= y1 - y0 ? 0 : 1;
    const v = axis === 0 ? xs : ys;
    const sub = Array.from(idx.subarray(lo, hi)).sort((a, b) => v[a] - v[b]);
    idx.set(sub, lo);
    const mid = (lo + hi) >> 1;
    node.axis = axis;
    node.split = v[idx[mid]];
    // left holds coords <= split, right >= split (sorted ranges)
    node.l = this.build(lo, mid);
    node.r = this.build(mid, hi);
    return id;
  }
  query(x, y) {
    let best = Infinity, bestI = -1;
    if (this.root === undefined) return { dist: Math.sqrt(best), idx: bestI };
    const { xs, ys, idx, nodes } = this;
    // (node, squared distance to its region's split plane) pairs
    const stack = [this.root], bound = [0];
    while (stack.length) {
      const nd = nodes[stack.pop()];
      if (bound.pop() > best) continue; // best improved since the push
      if (nd.axis < 0) {
        for (let k = nd.lo; k < nd.hi; k++) {
          const i = idx[k];
          const ex = xs[i] - x, ey = ys[i] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 < best || (d2 === best && i < bestI)) { best = d2; bestI = i; }
        }
        continue;
      }
      const d = (nd.axis === 0 ? x : y) - nd.split;
      const near = d <= 0 ? nd.l : nd.r, far = d <= 0 ? nd.r : nd.l;
      // far side can't beat best unless the split plane is within reach;
      // <= keeps equal-distance points reachable for the index tie-break
      if (d * d <= best) { stack.push(far); bound.push(d * d); }
      stack.push(near); bound.push(0);
    }
    return { dist: Math.sqrt(best), idx: bestI };
  }
}

/** Principal direction of centered 2D points (np.linalg.svd vt[0], up to sign). */
export function principalDir(pts, mean) {
  let a = 0, b = 0, c = 0;
  for (const [x, y] of pts) {
    const dx = x - mean[0], dy = y - mean[1];
    a += dx * dx; b += dx * dy; c += dy * dy;
  }
  const lMax = (a + c) / 2 + Math.hypot((a - c) / 2, b);
  let vx, vy;
  if (b === 0) { [vx, vy] = a >= c ? [1, 0] : [0, 1]; }
  else { vx = b; vy = lMax - a; }
  const n = Math.hypot(vx, vy) || 1;
  return [vx / n, vy / n];
}

export function mean2(pts) {
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return [sx / pts.length, sy / pts.length];
}

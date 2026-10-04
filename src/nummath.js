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

/** Exact nearest neighbor over 2D points via uniform grid hash
 *  (cKDTree.query replacement; returns {dist, idx}). */
export class GridNN {
  constructor(pts, cell = 1.0) {
    this.pts = pts;
    this.cell = cell;
    let minX = Infinity, minY = Infinity;
    for (const [x, y] of pts) { if (x < minX) minX = x; if (y < minY) minY = y; }
    this.minX = minX; this.minY = minY;
    this.map = new Map();
    pts.forEach(([x, y], i) => {
      const key = this.key(Math.floor((x - minX) / cell), Math.floor((y - minY) / cell));
      let arr = this.map.get(key);
      if (!arr) { arr = []; this.map.set(key, arr); }
      arr.push(i);
    });
  }
  key(gx, gy) { return gx * 73856093 ^ gy * 19349663; }
  query(x, y) {
    const gx = Math.floor((x - this.minX) / this.cell);
    const gy = Math.floor((y - this.minY) / this.cell);
    let best = Infinity, bestI = -1;
    for (let ring = 0; ; ring++) {
      // once a candidate exists, stop after the ring that could still beat it
      if (bestI >= 0 && (ring - 1) * this.cell > Math.sqrt(best)) break;
      let any = false;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const arr = this.map.get(this.key(gx + dx, gy + dy));
          if (!arr) continue;
          any = true;
          for (const i of arr) {
            const ex = this.pts[i][0] - x, ey = this.pts[i][1] - y;
            const d2 = ex * ex + ey * ey;
            if (d2 < best || (d2 === best && i < bestI)) { best = d2; bestI = i; }
          }
        }
      }
      if (any === false && bestI === -1 && ring * this.cell > 1e4) break; // safety
      if (ring * this.cell > 1e5) break;
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

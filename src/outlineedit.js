// Hand edits of a design's outline (pure geometry, no OpenCV): dragging
// the tool outline, and the straight spans the pocket is held to. The
// oriented contour is centred on the tool's symmetry axis (x = 0), the
// same axis symmetrizeContour mirrors across.

export const DRAG_R = 6.0; // mm of outline that follows a drag, each side

/** index of the point of `pts` nearest to p */
export function nearestIndex(pts, p) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - p[0]) ** 2 + (pts[i][1] - p[1]) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

/** move pts[idx] by d (in place on `out`) and its neighbours along the
 *  closed outline with a cosine falloff over arc length `r` */
function pull(out, pts, idx, [dx, dy], r) {
  const n = pts.length;
  out[idx][0] += dx; out[idx][1] += dy;
  for (const dir of [1, -1]) {
    let s = 0, prev = idx;
    for (let step = 1; step < n / 2; step++) {
      const k = ((idx + dir * step) % n + n) % n;
      s += Math.hypot(pts[k][0] - pts[prev][0], pts[k][1] - pts[prev][1]);
      if (s >= r) break;
      const w = 0.5 * (1 + Math.cos(Math.PI * s / r));
      out[k][0] += w * dx; out[k][1] += w * dy;
      prev = k;
    }
  }
}

/** The outline with pts[idx] dragged by d. mirror: the same edit, x-
 *  mirrored, at the matching spot on the other side (skipped when that's
 *  the grabbed spot itself, i.e. a grab on the axis). */
export function dragContour(pts, idx, d, r = DRAG_R, mirror = false) {
  const out = pts.map((p) => p.slice());
  pull(out, pts, idx, d, r);
  if (mirror) {
    const m = nearestIndex(pts, [-pts[idx][0], pts[idx][1]]);
    if (Math.hypot(pts[m][0] - pts[idx][0], pts[m][1] - pts[idx][1]) >= r) {
      pull(out, pts, m, [-d[0], d[1]], r);
    }
  }
  return out;
}

/** Shift-click: p moved onto the ray from a at the nearest multiple of
 *  `step` degrees. dir is that angle folded into [0, 180). */
export function snapAngle(a, p, step = 45) {
  const dx = p[0] - a[0], dy = p[1] - a[1];
  const th = Math.round(Math.atan2(dy, dx) * 180 / Math.PI / step) * step;
  const u = [Math.cos(th * Math.PI / 180), Math.sin(th * Math.PI / 180)];
  const t = dx * u[0] + dy * u[1];
  return { target: [a[0] + u[0] * t, a[1] + u[1] * t],
           dir: ((th % 180) + 180) % 180 };
}

/** Where the line through `a` at `dirDeg` crosses the closed outline
 *  `pts`, nearest to `near` (crossings within 2 mm of a are a's own).
 *  Shift-click puts the far end ON the pocket, not off it. */
export function rayHit(pts, a, dirDeg, near) {
  const ux = Math.cos(dirDeg * Math.PI / 180), uy = Math.sin(dirDeg * Math.PI / 180);
  const side = (p) => ux * (p[1] - a[1]) - uy * (p[0] - a[0]);
  let best = null, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const dp = side(p), dq = side(q);
    if (dp * dq > 0 || dp === dq) continue;
    const t = dp / (dp - dq);
    const x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
    if (Math.hypot(x[0] - a[0], x[1] - a[1]) < 2) continue;
    const d = Math.hypot(x[0] - near[0], x[1] - near[1]);
    if (d < bd) { bd = d; best = x; }
  }
  return best;
}

/** One-click straighten of a DENT: if outline point `idx` sits in a
 *  concavity (more than `eps` mm inside the convex hull), the hull edge
 *  spanning it — its two ends are the outermost outline points either
 *  side, so the line between them is the tangent that bridges the dent
 *  however steep its sides. null when `idx` is on the hull (a bulge:
 *  bowSpan handles those). Returns [a, b] (outline points). */
export function hullBridge(pts, idx, eps = 0.1) {
  const n = pts.length;
  const order = [...pts.keys()].sort((i, j) =>
    pts[i][0] - pts[j][0] || pts[i][1] - pts[j][1]);
  const cross = (o, a, b) => (pts[a][0] - pts[o][0]) * (pts[b][1] - pts[o][1]) -
    (pts[a][1] - pts[o][1]) * (pts[b][0] - pts[o][0]);
  const lo = [], hi = [];
  for (const i of order) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop();
    lo.push(i);
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], i) <= 0) hi.pop();
    hi.push(i);
  }
  // hull vertices in OUTLINE order (a simple loop visits them in turn)
  const hull = [...new Set([...lo.slice(0, -1), ...hi.slice(0, -1)])].sort((a, b) => a - b);
  if (hull.length < 3) return null;
  // the pair of consecutive hull vertices whose outline stretch holds idx
  for (let k = 0; k < hull.length; k++) {
    const s = hull[k], e = hull[(k + 1) % hull.length];
    const within = s < e ? idx > s && idx < e : idx > s || idx < e;
    if (!within) continue;
    const ex = pts[e][0] - pts[s][0], ey = pts[e][1] - pts[s][1];
    const L = Math.hypot(ex, ey);
    if (L < 3) return null;
    const dist = Math.abs((pts[idx][0] - pts[s][0]) * ey - (pts[idx][1] - pts[s][1]) * ex) / L;
    if (dist <= eps) return null; // on the hull: not a dent
    return [[pts[s][0], pts[s][1]], [pts[e][0], pts[e][1]]];
  }
  return null;
}

/** One-click straighten: the gently curved stretch of the closed outline
 *  `pts` around index `idx` — walking both ways while the direction
 *  stays within `maxTurn` degrees of the direction at the click (the
 *  tangent is taken over ±`win` mm, so jaggies don't stop it). Corners
 *  and finger scoops turn sharply, so a bow between two corners comes
 *  back whole. Returns [a, b] (outline points), or null if too short. */
export function bowSpan(pts, idx, maxTurn = 30, win = 1.5) {
  const n = pts.length;
  const s = new Float64Array(n + 1); // arc length, s[n] = perimeter
  for (let i = 1; i <= n; i++) {
    const p = pts[i - 1], q = pts[i % n];
    s[i] = s[i - 1] + Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  const per = s[n];
  // the point `d` mm along the outline from index i (either direction)
  const along = (i, d) => {
    let k = i, acc = 0;
    const step = d > 0 ? 1 : -1;
    while (acc < Math.abs(d)) {
      const k2 = (k + step + n) % n;
      acc += Math.hypot(pts[k2][0] - pts[k][0], pts[k2][1] - pts[k][1]);
      k = k2;
      if (k === i) break;
    }
    return k;
  };
  const angle = (i) => {
    const a = pts[along(i, -win)], b = pts[along(i, win)];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const ref = angle(idx), lim = (maxTurn * Math.PI) / 180;
  const off = (i) => {
    let d = angle(i) - ref;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d);
  };
  // walk in ~0.5 mm hops (cheap on dense outlines), half the way round at most
  const hop = Math.max(1, Math.round(n * 0.5 / per));
  const walk = (dir) => {
    let i = idx;
    for (let t = 0; t < n / 2; t += hop) {
      const j = (i + dir * hop + n) % n;
      if (off(j) > lim) break;
      i = j;
    }
    return i;
  };
  const ia = walk(-1), ib = walk(1);
  const a = pts[ia], b = pts[ib];
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return null;
  return [[a[0], a[1]], [b[0], b[1]]];
}

/** The tangent line a straighten makes across `arc` (pocket points from
 *  one end of the stretch to the other, in order): parallel to unit `u`,
 *  resting on the arc's OUTERMOST points (unit normal `out` points out of
 *  the pocket), so a dip between them is bridged (owner: "max straighten
 *  the tangent line"). -> { sup, ia, ib, a, b }: sup = how far out of
 *  arc[0] the line sits along `out`; ia..ib = the first and last arc
 *  points it touches (within eps); a, b = those, exactly on the line. */
export function tangentLine(arc, u, out, eps = 0.03) {
  const o = arc[0];
  const d = arc.map((p) => (p[0] - o[0]) * out[0] + (p[1] - o[1]) * out[1]);
  let sup = -Infinity;
  for (const v of d) if (v > sup) sup = v;
  let ia = d.findIndex((v) => v >= sup - eps);
  let ib = d.length - 1;
  while (ib > ia && d[ib] < sup - eps) ib--;
  const onLine = (k) => [arc[k][0] + (sup - d[k]) * out[0],
                         arc[k][1] + (sup - d[k]) * out[1]];
  return { sup, ia, ib, a: onLine(ia), b: onLine(ib) };
}

/** pocket drags [[at, d], ...] plus x-mirrored copies (symmetric
 *  pocket); a drag within r of the axis is its own mirror */
export function mirrorDrags(drags, r = DRAG_R) {
  const out = [];
  for (const [at, d] of drags) {
    out.push([at, d]);
    if (Math.abs(at[0]) >= r) out.push([[-at[0], at[1]], [-d[0], d[1]]]);
  }
  return out;
}

/** straight spans ([a, b], [a, b, dirDeg] or [a, b, dirDeg|null, offMm])
 *  plus their x-mirrors (symmetric pockets). A span that crosses the
 *  axis, or whose mirror is itself, isn't mirrored. */
export function mirrorSpans(spans, tol = 2.0) {
  const out = [];
  for (const span of spans) {
    const [a, b, dir, off] = span;
    out.push(span);
    if (a[0] * b[0] < 0) continue;
    const ma = [-a[0], a[1]], mb = [-b[0], b[1]];
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
    if ((near(ma, a) && near(mb, b)) || (near(ma, b) && near(mb, a))) continue;
    const m = [ma, mb];
    if (dir != null || off) m.push(dir == null ? null : (180 - dir) % 180);
    if (off) m.push(off);
    out.push(m);
  }
  return out;
}

/** The tool outline from the detected one plus its hand drags, in order:
 *  [{ at, d, mirror }] (at = outline point grabbed, d = its move). Kept
 *  as a list, not baked in, so any one drag can be taken out later. */
export function applyToolDrags(orig, drags, r = DRAG_R) {
  let pts = orig;
  for (const { at, d, mirror } of drags) {
    pts = dragContour(pts, nearestIndex(pts, at), d, r, !!mirror);
  }
  return pts;
}

/** distance from p to segment a-b */
export function segDist(p, a, b) {
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const L2 = ux * ux + uy * uy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / L2));
  return Math.hypot(p[0] - a[0] - t * ux, p[1] - a[1] - t * uy);
}

/** the shorter way round the closed outline from index i to j:
 *  { from, to } such that walking +1 from `from` reaches `to` */
export function shorterArc(pts, i, j) {
  const n = pts.length;
  let fwd = 0;
  for (let k = i; k !== j; k = (k + 1) % n) {
    const q = (k + 1) % n;
    fwd += Math.hypot(pts[q][0] - pts[k][0], pts[q][1] - pts[k][1]);
  }
  let total = 0;
  for (let k = 0; k < n; k++) {
    const q = (k + 1) % n;
    total += Math.hypot(pts[q][0] - pts[k][0], pts[q][1] - pts[k][1]);
  }
  return fwd <= total - fwd ? { from: i, to: j, len: fwd }
    : { from: j, to: i, len: total - fwd };
}

/** pts with the shorter arc between the points nearest a and b replaced
 *  by the straight chord between those two points */
export function chordReplace(pts, a, b) {
  const n = pts.length;
  const { from, to } = shorterArc(pts, nearestIndex(pts, a), nearestIndex(pts, b));
  if (from === to) return pts;
  // keep to .. from (the long way), so the chord closes from -> to
  const out = [];
  for (let k = to; ; k = (k + 1) % n) {
    out.push(pts[k]);
    if (k === from) break;
  }
  return out;
}

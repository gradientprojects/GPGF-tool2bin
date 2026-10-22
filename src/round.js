// Round (revolved) tool mode (owner, 2026-10-13): a rotationally
// symmetric tool (screwdriver, drill bit, file, pen) gets a cradle — the
// pocket's half-outline revolved about the tool's axis — instead of a
// constant-depth trench. The axis is the symmetric frame's x = 0 line
// along +Y (pose.js / symmetrizeContour), so the revolve axis is that
// line at height axisZ. Above the axis the walls go straight up (owner:
// drop in / lift out, no overhang).
//
// Pure geometry, no imports: the CV worker (layout) and the CAD worker
// (the solid) both use it.
const MIN_FLOOR = 7.0; // same as profilestage.js / bin3d.js
export const AXIS_MODES = ["flush", "sub"];

/** Half-width w(y) of the closed outline `pts` about x = 0 (the widest
 *  crossing at each height, so notches don't matter) as an open polyline
 *  [[x, y], …] from the bottom end to the top end, both ON the axis,
 *  resampled every ~`step` mm along its length. */
export function meridian(pts, step = 0.5) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const n = Math.max(8, Math.ceil((y1 - y0) / 0.2));
  const raw = [[0, y0]];
  for (let k = 1; k < n; k++) {
    const y = y0 + ((y1 - y0) * k) / n;
    let w = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xa, ya] = pts[j], [xb, yb] = pts[i];
      if ((ya > y) === (yb > y)) continue;
      const x = xa + ((y - ya) * (xb - xa)) / (yb - ya);
      if (Math.abs(x) > w) w = Math.abs(x);
    }
    raw.push([w, y]);
  }
  raw.push([0, y1]);
  // even spacing along the curve: the ends turn sharply toward the axis
  const out = [raw[0]];
  let acc = 0;
  for (let i = 1; i < raw.length; i++) {
    const [xa, ya] = raw[i - 1], [xb, yb] = raw[i];
    const L = Math.hypot(xb - xa, yb - ya);
    acc += L;
    if (acc >= step || i === raw.length - 1) { out.push(raw[i]); acc = 0; }
  }
  return out;
}

export const meridianR = (mer) => mer.reduce((m, p) => Math.max(m, p[0]), 0);

/** Douglas–Peucker: the fewest polyline points within `tol` mm of `poly`
 *  (ends kept). The cradle is built from these straight runs — each
 *  revolves into an exact cone / cylinder face (a straight shaft is ONE
 *  cylinder); a fitted spline overshot wildly where the outline turns
 *  onto the axis at the tool's ends. */
export function simplify(poly, tol = 0.03) {
  const keep = new Uint8Array(poly.length);
  keep[0] = keep[poly.length - 1] = 1;
  const stack = [[0, poly.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = poly[i], [bx, by] = poly[j];
    const L = Math.hypot(bx - ax, by - ay) || 1e-12;
    let dmax = -1, k = -1;
    for (let m = i + 1; m < j; m++) {
      const d = Math.abs((bx - ax) * (ay - poly[m][1]) - (ax - poly[m][0]) * (by - ay)) / L;
      if (d > dmax) { dmax = d; k = m; }
    }
    if (dmax > tol) { keep[k] = 1; stack.push([i, k], [k, j]); }
  }
  return poly.filter((_, i) => keep[i]);
}

/** The two axis choices for a cradle of radius r (incl. clearance)
 *  (owner, 2026-10-21: never proud of the top, no typed depth):
 *  a = mm of the axis BELOW the bin top. "flush": the axis level with the
 *  top (half the tool in), "sub" (UI: Tool flush): a = r, the tool's top
 *  level with the bin top. Bin height rounds up so the deepest point
 *  (a + r) keeps MIN_FLOOR. Old designs: "proud" reads as "flush"; a
 *  typed sub-flush depth is ignored (axisModeOf). */
export function roundOptions(r) {
  const pick = (mode, a) => {
    const depth = a + r;
    const nz = Math.max(1, Math.ceil((depth + MIN_FLOOR) / 7.0 - 1e-9));
    const H = nz * 7.0;
    return { mode, a, nz, H, depth, axisZ: H - a, ok: true, why: null };
  };
  return { sub: pick("sub", r), flush: pick("flush", 0) };
}

/** a saved axis_mode as one of AXIS_MODES (old "proud" -> "flush") */
export const axisModeOf = (m) => m === "flush" || m === "proud" ? "flush" : "sub";

// The round-tool pocket as ONE surface below the axis (owner, 2026-10-21:
// "fix what's crashing, don't bodge it with a 0.5 mm offset"; approved in
// Onshape as v9, 2026-10-23). Replaces the cutter stack (revolved cradle +
// plan prism + slot prisms + SCOOP_LIFT).
//
//  u: along the tool = C(u), the right half of the plan outline U (cradle
//     + finger slots + 2D fillets, G1 everywhere: roundPlan), converted
//     EXACTLY to one rational quadratic B-spline.
//  v: across, one section per pole of C. Every section uses the SAME v
//     weights (1, c, 1, c, 1, c, 1; c = cos 30), so the surface's section at
//     any u is a plain blend of pole sections and no span ever collapses
//     (a 2-micron flat strip imported "with errors").
//       cradle(w): the circle of radius w as three 60 deg arcs (exact)
//       scoop(w):  a conic corner from (w, 0) to (w - Q d, -d), then a flat
//                  floor at z = -d
//     section = lerp(cradle, scoop, s): s = 1 where the plan is wider than
//     the tool (a finger slot), ramping 0 -> 1 over LR mm of outline on
//     the narrow side of each crossing (the blend where the floor meets the
//     cradle or the slot's end wall).
//  Floor depth d (owner, 2026-10-23): the tool drives the height, so a
//  scoop's floor is the tool's bottom, never the 7 mm level. From the slot's
//  wide end it follows the tool (running max of the tool radius, so it only
//  goes down) to the deepest point, then stays flat toward the narrow end
//  for finger room under the narrowing tool.
//  Walls: C and its mirror extruded from the axis up, from C BEFORE the
//  extra knots (owner's Onshape bisection: walls from the knot-refined C
//  failed to import whenever a scoop surface sat below them). Top cap,
//  sewn, made a solid.

const LR = 6.0; // mm: blend length
const RES = 1.0; // mm: knot spacing through blends and slot spans
const Q = 0.6; // the scoop corner's width, as a fraction of the depth
const EPS = 0.2; // mm: plan wider than the floor depth by this = in the slot
const C30 = Math.cos(Math.PI / 6);
const WV = [1, C30, 1, C30, 1, C30, 1];
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** the tool radius at y from the meridian ([half-width, y], y ascending) */
export function merAt(mer, y) {
  if (y <= mer[0][1]) return mer[0][0];
  let lo = 0, hi = mer.length - 1;
  if (y >= mer[hi][1]) return mer[hi][0];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (mer[m][1] <= y) lo = m; else hi = m;
  }
  const t = (y - mer[lo][1]) / (mer[hi][1] - mer[lo][1] || 1);
  return mer[lo][0] + t * (mer[hi][0] - mer[lo][0]);
}

/** per finger slot (plan mode): its y span, and the floor depth along y:
 *  {spanAt(y), depthOf(y)} (depth below the axis, > 0) */
export function slotDepths(plan, mer) {
  const MARGIN = LR + 3, STEP = 0.02;
  const spans = plan.slots.filter((s) => s.run).map((s) => {
    const lo = Math.min(s.run.bot.T[1], s.run.top.T[1]);
    const hi = Math.max(s.run.bot.T[1], s.run.top.T[1]);
    let dm = 0, ys = lo;
    for (let y = lo; y <= hi; y += STEP) {
      const t = merAt(mer, y);
      if (t > dm) { dm = t; ys = y; }
    }
    const wideLow = merAt(mer, lo) >= merAt(mer, hi);
    // running max of the tool radius from the wide end of the margin,
    // sampled every STEP; half a knot spacing of look-ahead so the floor
    // between poles can't ride up over a tool that's still getting deeper
    const y0 = lo - MARGIN, n = Math.ceil((hi - lo + 2 * MARGIN) / STEP) + 1;
    const run = new Float64Array(n);
    const ah = Math.ceil(RES / 2 / STEP);
    if (wideLow) {
      let m = 0;
      for (let k = 0; k < n; k++) { m = Math.max(m, merAt(mer, y0 + (k + ah) * STEP)); run[k] = m; }
    } else {
      let m = 0;
      for (let k = n - 1; k >= 0; k--) { m = Math.max(m, merAt(mer, y0 + (k - ah) * STEP)); run[k] = m; }
    }
    return { lo, hi, dm, ys, wideLow, y0, run, MARGIN };
  });
  const spanAt = (y) => spans.find((sp) => y > sp.lo - sp.MARGIN && y < sp.hi + sp.MARGIN);
  const depthOf = (y) => {
    const sp = spanAt(y);
    if (!sp) return null;
    if (sp.wideLow ? y >= sp.ys : y <= sp.ys) return sp.dm;
    const k = Math.min(sp.run.length - 1, Math.max(0, Math.round((y - sp.y0) / 0.02)));
    return Math.min(sp.dm, sp.run[k]);
  };
  return { spans, spanAt, depthOf };
}

/** C: the plan's right half (lines / arcs) as one exact rational quadratic
 *  B-spline: {poles [[x, y]], wts, knots (0..1), mults, L} */
function planCurve(right) {
  const poles = [], wts = [], kn = [0];
  let L = 0;
  for (const e of right) {
    if (e.type === "line") {
      poles.push(e.a, [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
      wts.push(1, 1);
      L += Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      kn.push(L);
      continue;
    }
    const m = Math.max(1, Math.ceil(Math.abs(e.sw) / (Math.PI / 2) - 1e-9));
    const d = e.sw / m;
    for (let k = 0; k < m; k++) {
      const p0 = e.a0 + d * k, pm = p0 + d / 2, rm = e.r / Math.cos(d / 2);
      poles.push([e.c[0] + e.r * Math.cos(p0), e.c[1] + e.r * Math.sin(p0)],
        [e.c[0] + rm * Math.cos(pm), e.c[1] + rm * Math.sin(pm)]);
      wts.push(1, Math.cos(d / 2));
      L += Math.abs(d) * e.r;
      kn.push(L);
    }
  }
  poles.push(right[right.length - 1].b);
  wts.push(1);
  poles[0] = [0, poles[0][1]];
  poles[poles.length - 1] = [0, poles[poles.length - 1][1]];
  for (const p of poles) p[0] = Math.max(0, p[0]);
  return {
    poles, wts, L,
    knots: kn.map((v) => v / L),
    mults: kn.map((_, i) => (i === 0 || i === kn.length - 1 ? 3 : 2)),
  };
}

function ocCurve(oc, c, z = 0, mirror = false) {
  const n = c.poles.length, nk = c.knots.length;
  const P = new oc.TColgp_Array1OfPnt_2(1, n), W = new oc.TColStd_Array1OfReal_2(1, n);
  c.poles.forEach(([x, y], i) => P.SetValue(i + 1, new oc.gp_Pnt_3(mirror ? -x : x, y, z)));
  c.wts.forEach((w, i) => W.SetValue(i + 1, w));
  const K = new oc.TColStd_Array1OfReal_2(1, nk), M = new oc.TColStd_Array1OfInteger_2(1, nk);
  c.knots.forEach((k, i) => { K.SetValue(i + 1, k); M.SetValue(i + 1, c.mults[i]); });
  return new oc.Geom_BSplineCurve_2(P, W, K, M, 2, false, true);
}

/** The pocket solid: the one surface below the axis, walls from the axis
 *  up to `top`, a flat cap. `plan` = roundPlan(); `round` = {mer, axisZ}.
 *  With debug, also returns the pieces roundPocketChecks needs. */
export function roundPocket(oc, plan, round, top, { debug = false } = {}) {
  const { mer, axisZ } = round;
  const C0 = planCurve(plan.right);
  const Cg = ocCurve(oc, C0);
  const { spans, spanAt, depthOf } = slotDepths(plan, mer);

  // the slot regions along u: crossings of w - depth = EPS (in a span)
  const pnt = new oc.gp_Pnt_1();
  const g = (u) => {
    Cg.D0(u, pnt);
    const d = depthOf(pnt.Y());
    return d === null ? -1 : pnt.X() - d - EPS;
  };
  const NS = 20000, cross = [];
  let prev = g(0);
  for (let a = 1; a <= NS; a++) {
    const u1 = a / NS, cur = g(u1);
    if ((prev > 0) !== (cur > 0)) {
      let lo = (a - 1) / NS, hi = u1;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if ((g(mid) > 0) === (g(lo) > 0)) lo = mid; else hi = mid;
      }
      cross.push((lo + hi) / 2);
    }
    prev = cur;
  }
  // a ramp on the narrow side of each crossing
  const LRu = LR / C0.L, ramps = cross.map((uc) => g(Math.max(0, uc - 1e-4)) < 0
    ? { a: Math.max(0, uc - LRu), b: uc, up: true }
    : { a: uc, b: Math.min(1, uc + LRu), up: false });
  // knots every RES mm through the ramps and the slot spans: on the
  // SURFACE's copy of C only (the walls keep C0)
  const ins = new Set();
  for (const rp of ramps) {
    const n = Math.max(2, Math.ceil(LR / RES));
    for (let k = 0; k <= n; k++) ins.add(+(rp.a + ((rp.b - rp.a) * k) / n).toFixed(12));
  }
  if (spans.length) {
    const du = RES / C0.L;
    for (let u = 0; u <= 1; u += du) { Cg.D0(u, pnt); if (spanAt(pnt.Y())) ins.add(+u.toFixed(12)); }
  }
  for (const u of [...ins].sort((p, q) => p - q)) {
    if (u > 1e-9 && u < 1 - 1e-9) Cg.InsertKnot(u, 2, 1e-10, true);
  }
  const np = Cg.NbPoles(), nk = Cg.NbKnots();
  const poles = [], raw = [], wts = [], knots = [], mults = [];
  for (let i = 1; i <= np; i++) {
    const p = Cg.Pole(i);
    raw.push([p.X(), p.Y()]);
    poles.push([Math.max(0, p.X()), p.Y()]);
    wts.push(Cg.Weight(i));
  }
  for (let i = 1; i <= nk; i++) { knots.push(Cg.Knot(i)); mults.push(Cg.Multiplicity(i)); }
  if (mults.slice(1, -1).some((m) => m !== 2)) throw new Error("round pocket: C's interior knots must be double");
  const flat = [];
  knots.forEach((k, i) => { for (let m = 0; m < mults[i]; m++) flat.push(k); });
  const grev = poles.map((_, i) => (flat[i + 1] + flat[i + 2]) / 2);
  const sOf = (i) => {
    const d = depthOf(poles[i][1]);
    if (d !== null && poles[i][0] - d > EPS) return 1;
    let s = 0;
    for (const rp of ramps) {
      const gi = grev[i];
      if (gi < rp.a - 1e-12 || gi > rp.b + 1e-12) continue;
      const t = (gi - rp.a) / (rp.b - rp.a || 1);
      s = Math.max(s, smooth(rp.up ? t : 1 - t));
    }
    return s;
  };

  // the sections
  const cradle = (w) => [[w, 0], [w, -w * Math.tan(Math.PI / 6)], [w * 0.5, -w * Math.sin(Math.PI / 3)],
    [0, -w / Math.sin(Math.PI / 3)], [-w * 0.5, -w * Math.sin(Math.PI / 3)], [-w, -w * Math.tan(Math.PI / 6)], [-w, 0]];
  const scoop = (w, d) => [[w, 0], [w, -d], [w - Q * d, -d], [0, -d], [-(w - Q * d), -d], [-w, -d], [-w, 0]];
  // G1 across the v knots: J (rows 2 / 4) on the line P1-Tm, at the
  // cradle's ratio tC or the scoop's Q d / w (lerped)
  const cr1 = cradle(1);
  const tC = Math.hypot(cr1[2][0] - cr1[1][0], cr1[2][1] - cr1[1][1]) /
    Math.hypot(cr1[3][0] - cr1[1][0], cr1[3][1] - cr1[1][1]);
  const secs = poles.map(([w, y], i) => {
    const d = depthOf(y) ?? 0, s = d > 0 ? sOf(i) : 0, A = cradle(w), B = scoop(w, d);
    const P = A.map((p, j) => [p[0] + s * (B[j][0] - p[0]), p[1] + s * (B[j][1] - p[1])]);
    if (w > 1e-9) {
      const t = (1 - s) * tC + s * (Q * d / w);
      const J = [P[1][0] + t * (P[3][0] - P[1][0]), P[1][1] + t * (P[3][1] - P[1][1])];
      P[2] = J; P[4] = [-J[0], J[1]];
    }
    return { P, Y: Array(7).fill(y), s };
  });
  // G1 across every interior double knot of C: C passes its joint pole as
  // P_p = (1 - t) P_{p-1} + t P_{p+1}; every row's joint pole follows the
  // same t (rows 0 / 6, the wall edges, stay on C). The plan is G1, so
  // every joint qualifies; one that isn't is left alone (re-placing it
  // there pulled the surface 0.15 mm inside the cradle).
  for (let k = 1; k < nk - 1; k++) {
    const jp = 2 * k;
    const a = raw[jp - 1], b = raw[jp], c = raw[jp + 1];
    const dx = c[0] - a[0], dy = c[1] - a[1], L2 = dx * dx + dy * dy;
    if (L2 < 1e-18) continue;
    if (Math.abs((b[0] - a[0]) * dy - (b[1] - a[1]) * dx) / Math.sqrt(L2) > 1e-6) continue;
    const t = ((b[0] - a[0]) * dx + (b[1] - a[1]) * dy) / L2;
    const A = secs[jp - 1], B = secs[jp + 1];
    for (let j = 1; j <= 5; j++) {
      secs[jp].P[j] = [A.P[j][0] + t * (B.P[j][0] - A.P[j][0]), A.P[j][1] + t * (B.P[j][1] - A.P[j][1])];
      secs[jp].Y[j] = A.Y[j] + t * (B.Y[j] - A.Y[j]);
    }
  }
  const P2 = new oc.TColgp_Array2OfPnt_2(1, np, 1, 7);
  secs.forEach((sec, i) => sec.P.forEach(([x, z], j) =>
    P2.SetValue(i + 1, j + 1, new oc.gp_Pnt_3(x, sec.Y[j], axisZ + z))));
  const uK = new oc.TColStd_Array1OfReal_2(1, nk), uM = new oc.TColStd_Array1OfInteger_2(1, nk);
  knots.forEach((k, i) => { uK.SetValue(i + 1, k); uM.SetValue(i + 1, mults[i]); });
  const vK = new oc.TColStd_Array1OfReal_2(1, 4), vM = new oc.TColStd_Array1OfInteger_2(1, 4);
  [0, 1 / 3, 2 / 3, 1].forEach((k, i) => { vK.SetValue(i + 1, k); vM.SetValue(i + 1, [3, 2, 2, 3][i]); });
  const surf = new oc.Geom_BSplineSurface_1(P2, uK, vK, uM, vM, 2, 2, false, false);
  secs.forEach((_, i) => WV.forEach((wv, j) => surf.SetWeight(i + 1, j + 1, wv * wts[i])));

  // faces: the surface, the two walls (C0 and its mirror, axis up to top),
  // the cap; sewn into one solid
  const edge = (c) => new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(c)).Edge();
  const fS = new oc.BRepBuilderAPI_MakeFace_8(new oc.Handle_Geom_Surface_2(surf), 1e-7).Face();
  const wall = (mirror) => new oc.BRepPrimAPI_MakePrism_1(edge(ocCurve(oc, C0, axisZ, mirror)),
    new oc.gp_Vec_4(0, 0, top - axisZ), false, true).Shape();
  // top at the axis (an Axis flush negative body): no walls, the cap
  // closes the surface itself
  const walls = top - axisZ > 1e-6;
  const zc = walls ? top : axisZ;
  const capW = new oc.BRepBuilderAPI_MakeWire_1();
  capW.Add_1(edge(ocCurve(oc, C0, zc, false)));
  capW.Add_1(edge(ocCurve(oc, C0, zc, true)));
  const cap = new oc.BRepBuilderAPI_MakeFace_15(capW.Wire(), true).Face();
  const sew = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (const f of walls ? [fS, wall(false), wall(true), cap] : [fS, cap]) sew.Add(f);
  sew.Perform(new oc.Message_ProgressRange_1());
  if (sew.NbFreeEdges() > 0) throw new Error(`round pocket: ${sew.NbFreeEdges()} free edges after sewing`);
  const ex = new oc.TopExp_Explorer_2(sew.SewedShape(), oc.TopAbs_ShapeEnum.TopAbs_SHELL,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  if (!ex.More()) throw new Error("round pocket: sewing made no shell");
  const ms = new oc.BRepBuilderAPI_MakeSolid_1();
  ms.Add(oc.TopoDS.Shell_1(ex.Current()));
  let solid = ms.Solid();
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
  if (props.Mass() < 0) solid = solid.Reversed();
  props.delete();
  if (!debug) return solid;
  return { solid, surf, Cg, knots, nk, poles, secs, spanAt, depthOf, spans, axisZ, mer, right: plan.right };
}

/** Quality checks on a debug roundPocket() (tests): normal jumps across
 *  every knot line (u and v, deg), the thinnest strip (max/min |dS/dv|),
 *  folds (normal z flipping), samples outside the plan footprint, pole
 *  sections running back in x, and the scoop floor against its target
 *  depth and against the tool right above it. */
export function roundPocketChecks(oc, b, { NU = 1000, NV = 60 } = {}) {
  const { surf, Cg, knots, nk, secs, spanAt, depthOf, axisZ, mer, right } = b;
  const P = new oc.gp_Pnt_1(), Du = new oc.gp_Vec_1(), Dv = new oc.gp_Vec_1();
  const nrm = (u, v) => {
    surf.D1(u, v, P, Du, Dv);
    const n = Du.Crossed(Dv), m = n.Magnitude();
    return m > 1e-12 ? [n.X() / m, n.Y() / m, n.Z() / m] : null;
  };
  const ang = (a, c) => (a && c ? Math.acos(Math.max(-1, Math.min(1,
    a[0] * c[0] + a[1] * c[1] + a[2] * c[2]))) * 180 / Math.PI : 0);
  const h = 1e-7, u0 = knots[0], u1 = knots[nk - 1];
  let seamU = 0, seamV = 0;
  for (let k = 1; k < nk - 1; k++) {
    for (let j = 1; j < 100; j++) seamU = Math.max(seamU, ang(nrm(knots[k] - h, j / 100), nrm(knots[k] + h, j / 100)));
  }
  for (const v of [1 / 3, 2 / 3]) {
    for (let a = 1; a < NU; a++) {
      const u = u0 + ((u1 - u0) * a) / NU;
      seamV = Math.max(seamV, ang(nrm(u, v - h), nrm(u, v + h)));
    }
  }
  let minDv = Infinity, maxDv = 0, up = 0, down = 0;
  for (let a = Math.round(NU / 100); a <= NU - Math.round(NU / 100); a++) {
    const u = u0 + ((u1 - u0) * a) / NU;
    for (let j = 1; j < NV; j++) {
      surf.D1(u, j / NV, P, Du, Dv);
      minDv = Math.min(minDv, Dv.Magnitude()); maxDv = Math.max(maxDv, Dv.Magnitude());
      const n = nrm(u, j / NV);
      if (n && n[2] > 1e-9) up++; else if (n && n[2] < -1e-9) down++;
    }
  }
  // footprint: the plan outline as a polygon (C's right half + mirror)
  const half = [];
  for (let a = 0; a <= 2000; a++) { Cg.D0(u0 + ((u1 - u0) * a) / 2000, P); half.push([P.X(), P.Y()]); }
  const poly = half.concat(half.slice().reverse().map(([x, y]) => [-x, y]));
  const inside = (p) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], q = poly[j];
      if ((a[1] > p[1]) !== (q[1] > p[1]) && p[0] < ((q[0] - a[0]) * (p[1] - a[1])) / (q[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  const segD = (p, a, q) => {
    const dx = q[0] - a[0], dy = q[1] - a[1], L2 = dx * dx + dy * dy || 1e-30;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  let outside = 0;
  for (let a = 1; a < NU / 2; a++) {
    const u = u0 + ((u1 - u0) * a) / (NU / 2);
    for (let j = 1; j < 40; j++) {
      surf.D0(u, j / 40, P);
      const p = [P.X(), P.Y()];
      if (inside(p)) continue;
      let d = Infinity;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) d = Math.min(d, segD(p, poly[k], poly[i]));
      if (d > 0.02) outside++;
    }
  }
  let crossed = 0;
  for (const sec of secs) for (let j = 1; j < 7; j++) if (sec.P[j][0] > sec.P[j - 1][0] + 1e-9) crossed++;
  // the scoop floor (v = 0.5) where the plan is wider than its depth
  let floorOff = 0, floorAbove = Infinity, wideBelow = 0;
  for (let a = 0; a <= NU; a++) {
    const u = u0 + ((u1 - u0) * a) / NU;
    Cg.D0(u, P);
    const d0 = depthOf(P.Y());
    if (d0 === null || P.X() - d0 <= EPS) continue;
    surf.D0(u, 0.5, P);
    const y = P.Y(), d = depthOf(y), sp = spanAt(y);
    if (d === null) continue;
    floorOff = Math.max(floorOff, Math.abs(P.Z() - (axisZ - d)));
    const under = (axisZ - merAt(mer, y)) - P.Z(); // > 0: under the tool
    floorAbove = Math.min(floorAbove, under);
    if (sp && (sp.wideLow ? y < sp.ys : y > sp.ys)) wideBelow = Math.max(wideBelow, under);
  }
  return {
    seamU, seamV, stripRatio: maxDv / minDv, folds: up && down ? Math.min(up, down) : 0,
    outside, crossed, floorOff, floorAbove, wideBelow, elements: right.length,
  };
}

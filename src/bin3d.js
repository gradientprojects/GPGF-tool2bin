// Port of scan2step/bin3d.py + solid.py onto raw opencascade.js (the
// replicad build's kernel, same OCCT underneath as the reference's OCP).
// Build-specific substitutions, geometry-identical:
//  - straight edges are degree-1 B-splines (GC_MakeSegment not bound)
//  - the magnet chamfer cone is a revolved trapezoid, giving the same
//    analytic conical face as the reference (BRepPrimAPI_MakeCone not
//    bound). A circle-pair ThruSections loft also yields a cone surface,
//    but with B-spline seam/section edges that Bambu and Onshape fail to
//    sew — while passing EVERY OCCT-side check (validity, tolerances,
//    watertight mesh, bare-face re-sew). Bisect-verified 2026-10-04;
//    only a foreign-importer drag test catches this class of bug.
// `oc` is the ready opencascade instance throughout.
import { periodicFit } from "./smoothprof.js";
import { puzzleOutline } from "./puzzle.js";
import { meridianR } from "./round.js";
import { roundPocket } from "./roundsurf.js";

export const GRID = 42.0;
export const GAP = 0.5;
export const FOOT_TOP = 41.5;
export const R_TOP = 7.5 / 2;
export const CH1 = 0.8, STRAIGHT = 1.8, CH2 = 2.15;
export const FOOT_H = CH1 + STRAIGHT + CH2;
export const FOOT_BOT = FOOT_TOP - 2 * (CH1 + CH2);
export const R_BOT = R_TOP - (CH1 + CH2);
export const MAG_OFF = 13.0;
export const MIN_FLOOR = 7.0; // mm under the pocket; feet are 4.75 mm tall

const asCurveHandle = (oc, geom) => new oc.Handle_Geom_Curve_2(geom);

function edgeFromCurve(oc, handle) {
  const mk = new oc.BRepBuilderAPI_MakeEdge_24(handle);
  const e = mk.Edge();
  mk.delete();
  return e;
}

/** straight segment as a degree-1 B-spline edge */
function segmentEdge(oc, p0, p1) {
  const poles = new oc.TColgp_Array1OfPnt_2(1, 2);
  poles.SetValue(1, new oc.gp_Pnt_3(p0[0], p0[1], p0[2]));
  poles.SetValue(2, new oc.gp_Pnt_3(p1[0], p1[1], p1[2]));
  const knots = new oc.TColStd_Array1OfReal_2(1, 2);
  knots.SetValue(1, 0); knots.SetValue(2, 1);
  const mults = new oc.TColStd_Array1OfInteger_2(1, 2);
  mults.SetValue(1, 2); mults.SetValue(2, 2);
  const c = new oc.Geom_BSplineCurve_1(poles, knots, mults, 1, false);
  return edgeFromCurve(oc, asCurveHandle(oc, c));
}

function arcEdge(oc, a, m, b) {
  const mk = new oc.GC_MakeArcOfCircle_4(
    new oc.gp_Pnt_3(a[0], a[1], a[2]),
    new oc.gp_Pnt_3(m[0], m[1], m[2]),
    new oc.gp_Pnt_3(b[0], b[1], b[2]));
  const h = mk.Value();
  const e = edgeFromCurve(oc, new oc.Handle_Geom_Curve_2(h.get()));
  mk.delete();
  return e;
}

/** bin3d._rrect_wire: rounded rectangle wire at height z */
export function rrectWire(oc, cx, cy, w, h, r, z) {
  const hw = w / 2, hh = h / 2;
  const k = r * (1 - 1 / Math.SQRT2);
  const corners = [
    [[cx + hw, cy + hh - r], [cx + hw - r, cy + hh]],
    [[cx - hw + r, cy + hh], [cx - hw, cy + hh - r]],
    [[cx - hw, cy - hh + r], [cx - hw + r, cy - hh]],
    [[cx + hw - r, cy - hh], [cx + hw, cy - hh + r]],
  ];
  const mids = [
    [cx + hw - k, cy + hh - k],
    [cx - hw + k, cy + hh - k],
    [cx - hw + k, cy - hh + k],
    [cx + hw - k, cy - hh + k],
  ];
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < 4; i++) {
    const [start, end] = corners[i];
    mw.Add_1(arcEdge(oc, [start[0], start[1], z], [mids[i][0], mids[i][1], z],
      [end[0], end[1], z]));
    const nxt = corners[(i + 1) % 4][0];
    mw.Add_1(segmentEdge(oc, [end[0], end[1], z], [nxt[0], nxt[1], z]));
  }
  if (!mw.IsDone()) throw new Error("rounded-rect wire failed");
  const w2 = mw.Wire();
  mw.delete();
  return w2;
}

function thruSections(oc, wires, solid = true, ruled = true) {
  const ts = new oc.BRepOffsetAPI_ThruSections(solid, ruled, 1e-6);
  for (const w of wires) ts.AddWire(w);
  ts.Build(new oc.Message_ProgressRange_1());
  if (!ts.IsDone()) throw new Error("loft failed");
  const s = ts.Shape();
  ts.delete();
  return s;
}

/** One Gridfinity foot. `c` (mm, >= 0): the whole profile offset inward
 *  by c per side — every section c smaller, radii too — for a looser fit
 *  in the baseplate (c = 0.25: band 36.7, bottom 35.1, top 41.0). */
function foot(oc, cx, cy, c = 0) {
  const s = (w) => w - 2 * c, r = (v) => Math.max(0.1, v - c);
  return thruSections(oc, [
    rrectWire(oc, cx, cy, s(FOOT_BOT), s(FOOT_BOT), r(R_BOT), 0.0),
    rrectWire(oc, cx, cy, s(FOOT_BOT + 2 * CH1), s(FOOT_BOT + 2 * CH1), r(R_BOT + CH1), CH1),
    rrectWire(oc, cx, cy, s(FOOT_BOT + 2 * CH1), s(FOOT_BOT + 2 * CH1), r(R_BOT + CH1),
      CH1 + STRAIGHT),
    rrectWire(oc, cx, cy, s(FOOT_TOP), s(FOOT_TOP), r(R_TOP), FOOT_H),
  ], true, true);
}

function fuse(oc, a, b) {
  const op = new oc.BRepAlgoAPI_Fuse_3(a, b, new oc.Message_ProgressRange_1());
  op.Build(new oc.Message_ProgressRange_1());
  const s = op.Shape();
  op.delete();
  return s;
}

export function cutAll(oc, base, tools) {
  if (!tools.length) return base;
  const op = new oc.BRepAlgoAPI_Cut_1();
  const args = new oc.TopTools_ListOfShape_1();
  args.Append_1(base);
  const tl = new oc.TopTools_ListOfShape_1();
  for (const t of tools) tl.Append_1(t);
  op.SetArguments(args);
  op.SetTools(tl);
  op.Build(new oc.Message_ProgressRange_1());
  if (!op.IsDone()) throw new Error("boolean cut failed");
  const s = op.Shape();
  op.delete(); args.delete(); tl.delete();
  return s;
}

/** cut `tool` from `shape`; on any failure keep the uncut shape */
export function tryCut(oc, shape, tool, label, log) {
  try {
    const s = cutAll(oc, shape, [tool]);
    if (isValid(oc, s)) {
      log(label);
      return s;
    }
    log(`WARNING: ${label} left an invalid solid; skipped`);
  } catch (err) {
    log(`WARNING: ${label} failed (${err}); skipped`);
  }
  return shape;
}

export function isValid(oc, shape) {
  const an = new oc.BRepCheck_Analyzer(shape, true, false);
  const ok = an.IsValid_2();
  an.delete();
  return ok;
}

export function bbox(oc, shape) {
  const box = new oc.Bnd_Box_1();
  oc.BRepBndLib.AddOptimal(shape, box, false, false);
  const x0 = box.CornerMin().X(), y0 = box.CornerMin().Y(), z0 = box.CornerMin().Z();
  const x1 = box.CornerMax().X(), y1 = box.CornerMax().Y(), z1 = box.CornerMax().Z();
  box.delete();
  return { dims: [x1 - x0, y1 - y0, z1 - z0], zTop: z1,
           min: [x0, y0, z0], max: [x1, y1, z1] };
}

function topEdges(oc, shape, zTop) {
  const out = [];
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const e = oc.TopoDS.Edge_1(exp.Current());
    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(e, box, false);
    const z0 = box.CornerMin().Z(), z1 = box.CornerMax().Z();
    box.delete();
    if (Math.abs(z0 - zTop) < 0.01 && Math.abs(z1 - zTop) < 0.01) {
      if (!out.some((o) => e.IsSame(o))) out.push(e);
    }
    exp.Next();
  }
  exp.delete();
  return out;
}

function treatEdges(oc, shape, edges, style, size, label, log) {
  if (!edges.length) return shape;
  try {
    const op = style === "fillet"
      ? new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)
      : new oc.BRepFilletAPI_MakeChamfer(shape);
    for (const e of edges) op.Add_2(size, e);
    op.Build(new oc.Message_ProgressRange_1());
    if (op.IsDone()) {
      const s = op.Shape();
      if (isValid(oc, s)) {
        log(`${label}: ${style} ${size} mm on ${edges.length} edges`);
        op.delete();
        return s;
      }
    }
    op.delete();
    log(`WARNING: ${label} ${style} failed; stays square`);
  } catch (err) {
    log(`WARNING: ${label} ${style} failed (${err}); stays square`);
  }
  return shape;
}

/** periodic/clamped profile tck -> planar 3D B-spline edge at height z.
 *  (NOTE: SetNotPeriodic-clamped closed wires ABORT ThruSections in this
 *  OCCT 7.6 wasm — do not try that route again; see changelog 2026-10-04.) */
function profileEdge(oc, tck, z, periodic) {
  return edgeFromCurve(oc, asCurveHandle(oc, profileGeom(oc, tck, z, periodic)));
}

function profileGeom(oc, tck, z, periodic) {
  let geom;
  if (periodic) {
    const { C, k } = tck;
    const nseg = C.length;
    const poles = new oc.TColgp_Array1OfPnt_2(1, nseg);
    for (let i = 0; i < nseg; i++) {
      poles.SetValue(i + 1, new oc.gp_Pnt_3(C[i][0], C[i][1], z));
    }
    const knots = new oc.TColStd_Array1OfReal_2(1, nseg + 1);
    const mults = new oc.TColStd_Array1OfInteger_2(1, nseg + 1);
    for (let i = 0; i <= nseg; i++) {
      knots.SetValue(i + 1, i / nseg);
      mults.SetValue(i + 1, 1);
    }
    geom = new oc.Geom_BSplineCurve_1(poles, knots, mults, k, true);
  } else {
    const { t, cx, cy, k } = tck;
    const n = t.length - k - 1;
    const poles = new oc.TColgp_Array1OfPnt_2(1, n);
    for (let i = 0; i < n; i++) {
      poles.SetValue(i + 1, new oc.gp_Pnt_3(cx[i], cy[i], z));
    }
    // unique knots + multiplicities (reference rounds at 1e-12)
    const uk = [], um = [];
    for (const v of t) {
      const r = Math.round(v * 1e12) / 1e12;
      if (uk.length && uk[uk.length - 1] === r) um[um.length - 1]++;
      else { uk.push(r); um.push(1); }
    }
    const knots = new oc.TColStd_Array1OfReal_2(1, uk.length);
    const mults = new oc.TColStd_Array1OfInteger_2(1, uk.length);
    uk.forEach((v, i) => { knots.SetValue(i + 1, v); mults.SetValue(i + 1, um[i]); });
    geom = new oc.Geom_BSplineCurve_1(poles, knots, mults, k, false);
  }
  return geom;
}

/** The pocket prism's outline wire. A closed (periodic) profile goes in
 *  CLAMPED: one edge, end knots of full multiplicity, first pole = last
 *  pole. OCCT 7.6 writes a periodic B-spline to STEP unclamped (knots
 *  past [0, 1], all mult 1), and Onshape's Parasolid drops the pocket
 *  floor bounded by it geometry-dependently while every OCCT check
 *  passes (owner Onshape A/B, 2026-10-08: periodic failed, clamped
 *  imported, splitting into two edges opened a hole at the split). Only
 *  the prism — ThruSections sections stay periodic (see NOTE above). */
/** closed periodic tck -> CLAMPED closed B-spline edge at height z.
 *  SetNotPeriodic alone keeps the unclamped (extended) knot vector and
 *  writes the same STEP; Segment over the full range clamps it. Every
 *  tck with the same knots clamps to the same knot vector. */
function clampedEdge(oc, tck, z) {
  const geom = profileGeom(oc, tck, z, true);
  const a = geom.FirstParameter(), b = geom.LastParameter();
  geom.SetNotPeriodic();
  geom.Segment(a, b, 1e-9);
  return edgeFromCurve(oc, asCurveHandle(oc, geom));
}

function profileWire(oc, segs, periodic, z) {
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  if (periodic) {
    mw.Add_1(clampedEdge(oc, segs[0], z));
  } else {
    for (const tck of segs) mw.Add_1(profileEdge(oc, tck, z, false));
    if (!mw.IsDone()) throw new Error("wire gap: segment endpoints do not connect");
  }
  const w = mw.Wire();
  mw.delete();
  return w;
}

function faceFromWire(oc, wire) {
  const mf = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  const f = mf.Face();
  mf.delete();
  return f;
}

function prism(oc, face, dz) {
  const mp = new oc.BRepPrimAPI_MakePrism_1(face, new oc.gp_Vec_4(0, 0, dz),
    false, true);
  const s = mp.Shape();
  mp.delete();
  return s;
}

function cylinder(oc, cx, cy, z0, r, h) {
  const ax = new oc.gp_Ax2_3(new oc.gp_Pnt_3(cx, cy, z0), new oc.gp_Dir_4(0, 0, 1));
  const mk = new oc.BRepPrimAPI_MakeCylinder_3(ax, r, h);
  const s = mk.Shape();
  mk.delete();
  return s;
}

/** magnet chamfer cone (r0 at z0 -> r1 at z0+h): a trapezoid revolved about
 *  the axis (the reference uses BRepPrimAPI_MakeCone, absent from this
 *  wasm). DO NOT replace with a circle-pair loft: it makes the same cone
 *  surface but with B-spline seam/section edges that Onshape and Bambu
 *  fail to sew, despite passing every OCCT-side check. */
function cone(oc, cx, cy, z0, r0, r1, h) {
  const pts = [[cx, z0], [cx + r0, z0], [cx + r1, z0 + h], [cx, z0 + h]];
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < 4; i++) {
    const [xa, za] = pts[i], [xb, zb] = pts[(i + 1) % 4];
    const me = new oc.BRepBuilderAPI_MakeEdge_3(
      new oc.gp_Pnt_3(xa, cy, za), new oc.gp_Pnt_3(xb, cy, zb));
    mw.Add_1(me.Edge());
    me.delete();
  }
  const w = mw.Wire();
  mw.delete();
  const ax = new oc.gp_Ax1_2(new oc.gp_Pnt_3(cx, cy, z0),
    new oc.gp_Dir_4(0, 0, 1));
  const mr = new oc.BRepPrimAPI_MakeRevol_2(faceFromWire(oc, w), ax, false);
  const s = mr.Shape();
  mr.delete();
  return s;
}

// np.gradient along axis 0 with the reference's wrap-pad trick
function wrapTangents(q0) {
  const n = q0.length;
  const pad = [...q0.slice(n - 5), ...q0, ...q0.slice(0, 5)];
  const t = [];
  for (let i = 5; i < 5 + n; i++) {
    const gx = (pad[i + 1][0] - pad[i - 1][0]) / 2;
    const gy = (pad[i + 1][1] - pad[i - 1][1]) / 2;
    const nn = Math.max(Math.hypot(gx, gy), 1e-9);
    t.push([gx / nn, gy / nn]);
  }
  return t;
}

/** Pocket-entry flare cutter (chamfer/fillet on the pocket rim).
 *
 *  PARASOLID RULE (Onshape bisect, 2026-10-04): never hand ThruSections
 *  section curves in different knot bases. Its ruled knot-merge emits
 *  surfaces Onshape rejects geometry-dependently (snips-closed failed,
 *  scissors survived) while every OCCT check passes. For periodic
 *  profiles all sections are therefore built from the exact profile's
 *  own control points, offset along control-polygon normals — one
 *  shared knot vector, no merging, and the off=0 rim is exactly the
 *  pocket-wall curve. Pole offset ≈ curve offset within a few percent
 *  of the 1 mm flare, and exact at off=0. */
function pocketEntryCutter(oc, segs, periodic, pocketPts, size, H, style, log) {
  let mkWire;
  if (periodic) {
    const { C, k } = segs[0];
    const n = C.length;
    // Pole normals over a ~2.5 mm baseline, not adjacent poles: dense
    // refit tcks (1.25 mm knots after scoops / strict containment)
    // carry high-frequency wiggle in the control polygon, and
    // neighbor-difference normals then point erratically — the offset
    // wire folds inside the wall and the flare cuts nothing there
    // (live bug: chamfer missing on most of a smooth-0 pocket).
    let perim = 0;
    for (let i = 0; i < n; i++) {
      const p0 = C[i], p1 = C[(i + 1) % n];
      perim += Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    }
    const span = Math.max(1, Math.min(Math.round(2.5 / (perim / n)),
                                      Math.floor(n / 8)));
    // (dy,-dx) is outward only for CCW polygons; flip with the actual
    // winding (a CW tck once turned the flare inside out — it landed
    // wholly inside the pocket prism and cut nothing)
    let a2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      a2 += C[i][0] * C[j][1] - C[i][1] * C[j][0];
    }
    const sgn = a2 >= 0 ? 1 : -1;
    const nrmP = [];
    for (let i = 0; i < n; i++) {
      const p0 = C[(i - span + n) % n], p1 = C[(i + span) % n];
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
      const l = Math.hypot(dx, dy) || 1e-9;
      nrmP.push([(dy / l) * sgn, (-dx / l) * sgn]);
    }
    mkWire = (off, z) => {
      const C2 = C.map((p, i) => [p[0] + nrmP[i][0] * off, p[1] + nrmP[i][1] * off]);
      const mw = new oc.BRepBuilderAPI_MakeWire_1();
      mw.Add_1(clampedEdge(oc, { C: C2, k }, z));
      const w = mw.Wire();
      mw.delete();
      return w;
    };
  } else {
    // segmented profiles (corner tools): reference construction — raw
    // outward offset of the dense samples, refit periodically. Mixed
    // bases, so subject to the Parasolid rule above; convert to a
    // per-segment pole offset if a corner tool ever fails an import.
    const stride = Math.max(1, Math.trunc(pocketPts.length / 1500));
    const q0 = [];
    for (let i = 0; i < pocketPts.length; i += stride) q0.push(pocketPts[i]);
    let a2 = 0;
    for (let i = 0; i < q0.length; i++) {
      const j = (i + 1) % q0.length;
      a2 += q0[i][0] * q0[j][1] - q0[i][1] * q0[j][0];
    }
    const sgn = a2 >= 0 ? 1 : -1; // outward flips with winding, as above
    const t = wrapTangents(q0);
    const nrm = t.map(([tx, ty]) => [ty * sgn, -tx * sgn]);
    mkWire = (off, z) => {
      if (off === 0) return profileWire(oc, segs, periodic, z);
      const q = q0.map((p, i) => [p[0] + nrm[i][0] * off, p[1] + nrm[i][1] * off]);
      const tck = periodicFit(q, 1e-9, 2.0);
      const mw = new oc.BRepBuilderAPI_MakeWire_1();
      mw.Add_1(profileEdge(oc, tck, z, true));
      const w = mw.Wire();
      mw.delete();
      return w;
    };
  }
  const wires = [mkWire(0, H - size)];
  if (style === "fillet") {
    for (let i = 1; i <= 6; i++) {
      const ang = (Math.PI / 2) * (i / 6);
      wires.push(mkWire((1 - Math.cos(ang)) * size, H - size + Math.sin(ang) * size));
    }
  } else {
    wires.push(mkWire(size, H));
  }
  wires.push(mkWire(size, H + 0.5));
  const s = thruSections(oc, wires, true, style !== "fillet");
  log(`pocket entry: ${style} ${size} mm (lofted cutter)`);
  return s;
}

/** the cradle's meridian as lines + arcs (`fitProfile`; owner, Onshape
 *  2026-10-21: straight runs came in as a stack of split faces).
 *  Elements run up the +x side from the bottom tip to the top tip, both
 *  exactly ON the axis. Cached per meridian. */
const profileCache = new WeakMap();
function cradleProfile(mer) {
  let els = profileCache.get(mer);
  if (!els) {
    els = fitProfile(mer);
    profileCache.set(mer, els);
  }
  return els;
}

/** the cradle's plan outline at the axis (= the straight walls above it):
 *  the profile up the +x side, mirrored back down the -x side (CCW) */
export function cradlePlan(mer) {
  const right = cradleProfile(mer);
  return [...right, ...mirrorChain(right)];
}

// ---- the round pocket's plan (owner, 2026-10-21; built 2026-10-23) ----
// The axis is never above the top (Axis flush / Tool flush), so the rim
// opening is the plan outline U = the cradle's plan P + the finger slots'
// stadiums, every junction filleted in 2D (scoop_blend, as flat mode
// does), G1 everywhere. The pocket itself is ONE surface below the axis
// with walls of U above it (roundsurf.js); ONE rim flare is lofted from
// U (per-slot flares crossed and left spikes, owner screenshot).
const v2 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  mul: (a, k) => [a[0] * k, a[1] * k],
  len: (a) => Math.hypot(a[0], a[1]),
  unit: (a) => { const l = Math.hypot(a[0], a[1]) || 1e-12; return [a[0] / l, a[1] / l]; },
  mx: (p) => [-p[0], p[1]],
};

/** signed distance from p to the closed polygon (+ outside), nearest
 *  point q on edge i (poly[i] -> poly[i + 1]) at parameter t */
function polyDist(p, poly) {
  let best = Infinity, q = null, bi = -1, bt = 0, inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
    const ab = v2.sub(b, a), L2 = ab[0] * ab[0] + ab[1] * ab[1] || 1e-24;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2));
    const c = v2.add(a, v2.mul(ab, t));
    const d = v2.len(v2.sub(p, c));
    if (d < best) { best = d; q = c; bi = j; bt = t; }
  }
  return { d: inside ? -best : best, q, i: bi, t: bt };
}

/** The fillet circle at one right-hand corner (sy = +1 top, -1 bottom)
 *  of the slot (stadium: arc centre (hs, cy), radius R): its centre runs
 *  along the stadium offset by rb (round the arc, then along the straight
 *  side) until it sits exactly rb outside the plan P. Returns {c, T (on
 *  P, edge i at t), A (on the stadium), arc: A on the arc, th}, or null. */
function slotFillet(P, Ppoly, hs, cy, R, rb, sy) {
  const L = R + rb, tMax = hs > 1e-6 ? 2 : 1;
  const at = (t) => {
    if (t <= 1) {
      const th = (t * Math.PI) / 2;
      return { c: [hs + L * Math.cos(th), cy + sy * L * Math.sin(th)], arc: true, th };
    }
    return { c: [hs * (2 - t), cy + sy * L], arc: false, th: Math.PI / 2 };
  };
  const g = (t) => chainDist(at(t).c, P, Ppoly).d - rb;
  if (g(0) <= 0) return null;
  const N = 600;
  let t0 = 0, t1 = -1;
  for (let k = 1; k <= N; k++) {
    const t = (k / N) * tMax;
    if (g(t) <= 0) { t1 = t; break; }
    t0 = t;
  }
  if (t1 < 0) return null;
  for (let i = 0; i < 60; i++) {
    const m = (t0 + t1) / 2;
    if (g(m) > 0) t0 = m; else t1 = m;
  }
  const s = at(t1), near = chainDist(s.c, P, Ppoly);
  const A = s.arc ? v2.add([hs, cy], v2.mul(v2.unit(v2.sub(s.c, [hs, cy])), R))
    : [s.c[0], cy + sy * R];
  return { c: s.c, T: near.q, i: near.i, t: near.t, A, arc: s.arc, th: s.th };
}

/** element helpers: a CCW closed chain of {line|arc, a, b} (arc: c, r,
 *  convex = region inside its circle, md = unit dir centre -> midpoint) */
const lineEl = (a, b) => ({ type: "line", a, b });
const TAU = 2 * Math.PI;
const normAng = (t) => ((t % TAU) + TAU) % TAU;
/** an arc a -> b about c, the side through direction md; a0 = start
 *  angle, sw = signed sweep (+ CCW) */
function arcEl(a, b, c, convex, md) {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let sw = normAng(Math.atan2(b[1] - c[1], b[0] - c[0]) - a0);
  if (normAng(Math.atan2(md[1], md[0]) - a0) > sw) sw -= TAU; // the other way round
  return { type: "arc", a, b, c, r: v2.len(v2.sub(a, c)), convex, md, a0, sw };
}
function mirrorChain(chain) {
  return chain.slice().reverse().map((e) => e.type === "line"
    ? lineEl(v2.mx(e.b), v2.mx(e.a))
    : arcEl(v2.mx(e.b), v2.mx(e.a), v2.mx(e.c), e.convex, v2.mx(e.md)));
}
/** the point at parameter t (0 = a, 1 = b) */
function elAt(e, t) {
  if (e.type === "line") return v2.add(e.a, v2.mul(v2.sub(e.b, e.a), t));
  const th = e.a0 + e.sw * t;
  return [e.c[0] + e.r * Math.cos(th), e.c[1] + e.r * Math.sin(th)];
}
/** the part of e between parameters t0 < t1 (ends exactly e.a / e.b) */
function elPart(e, t0, t1) {
  const a = t0 <= 0 ? e.a : elAt(e, t0), b = t1 >= 1 ? e.b : elAt(e, t1);
  if (e.type === "line") return lineEl(a, b);
  const th = e.a0 + e.sw * (t0 + t1) / 2;
  return arcEl(a, b, e.c, e.convex, [Math.cos(th), Math.sin(th)]);
}
/** nearest point on e to p: {d, q, t} */
function elNear(p, e) {
  if (e.type === "line") {
    const ab = v2.sub(e.b, e.a), L2 = ab[0] * ab[0] + ab[1] * ab[1] || 1e-24;
    const t = Math.max(0, Math.min(1, ((p[0] - e.a[0]) * ab[0] + (p[1] - e.a[1]) * ab[1]) / L2));
    const q = v2.add(e.a, v2.mul(ab, t));
    return { d: v2.len(v2.sub(p, q)), q, t };
  }
  const rel = e.sw > 0
    ? normAng(Math.atan2(p[1] - e.c[1], p[0] - e.c[0]) - e.a0)
    : normAng(e.a0 - Math.atan2(p[1] - e.c[1], p[0] - e.c[0]));
  if (rel <= Math.abs(e.sw)) {
    const t = rel / Math.abs(e.sw), q = elAt(e, t);
    return { d: v2.len(v2.sub(p, q)), q, t };
  }
  const da = v2.len(v2.sub(p, e.a)), db = v2.len(v2.sub(p, e.b));
  return da < db ? { d: da, q: e.a, t: 0 } : { d: db, q: e.b, t: 1 };
}
/** signed distance from p to the closed chain (+ outside, sign from the
 *  sampled outline `poly`), nearest point q on element i at t */
function chainDist(p, chain, poly) {
  let best = { d: Infinity }, bi = -1;
  chain.forEach((e, i) => {
    const n = elNear(p, e);
    if (n.d < best.d) { best = n; bi = i; }
  });
  return { d: polyDist(p, poly).d < 0 ? -best.d : best.d, q: best.q, i: bi, t: best.t };
}

/** Lines + arcs through the meridian samples within `tol` (greedy: each
 *  element as long as it can be). A line if it fits, else the arc
 *  through the span's ends and middle sample. Arcs never reach past the
 *  measured radius (the cradle depth stays the measured one) or across
 *  the axis (OCCT revolves each arc into a surface of revolution of
 *  just that arc, so a far-off centre is harmless), and concave ones
 *  keep a radius >= CONCAVE_MIN so the rim flare's outward offset can't
 *  fold them. */
const CONCAVE_MIN = 3; // mm
export function fitProfile(mer, tol = 0.03) {
  const p = mer.map(([x, y]) => [Math.max(0, x), y]);
  p[0] = [0, p[0][1]];
  p[p.length - 1] = [0, p[p.length - 1][1]];
  const rMax = p.reduce((m, q) => Math.max(m, q[0]), 0);
  const segD = (q, a, b) => elNear(q, lineEl(a, b)).d;
  const span = (i, j) => {
    const a = p[i], b = p[j];
    let line = true;
    for (let k = i + 1; k < j && line; k++) line = segD(p[k], a, b) <= tol;
    if (line) return lineEl(a, b);
    if (j - i < 3) return null;
    const m = p[(i + j) >> 1];
    const D = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(D) < 1e-12) return null;
    const sq = (q) => q[0] * q[0] + q[1] * q[1];
    const c = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / D,
      (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / D];
    const r = v2.len(v2.sub(a, c));
    if (r > 5000) return null;
    // left turn (a -> m -> b) = centre on the pocket side = convex
    const turn = (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]);
    if (turn < 0 && r < CONCAVE_MIN) return null;
    const e = arcEl(a, b, c, turn > 0, v2.unit(v2.sub(m, c)));
    for (let k = i + 1; k < j; k++) {
      const n = elNear(p[k], e);
      if (n.d > tol || n.t <= 0 || n.t >= 1) return null;
    }
    const inSweep = (th) => {
      const rel = e.sw > 0 ? normAng(th - e.a0) : normAng(e.a0 - th);
      return rel > 1e-9 && rel < Math.abs(e.sw) - 1e-9;
    };
    if (inSweep(0) && c[0] + r > rMax + 1e-9) return null;
    if (inSweep(Math.PI) && c[0] - r < -1e-9) return null;
    return e;
  };
  const els = [];
  for (let i = 0; i < p.length - 1;) {
    let best = { j: i + 1, e: lineEl(p[i], p[i + 1]) };
    for (let j = i + 2, miss = 0; j < p.length && miss < 8; j++) {
      const e = span(i, j);
      if (e) { best = { j, e }; miss = 0; } else miss++;
    }
    els.push(best.e);
    i = best.j;
  }
  centreEnds(els);
  return els;
}

/** An outline symmetric about x = 0 must cross it square, so an END arc
 *  gets its centre on the axis (2026-10-23: a fitted end arc 0.76 mm off
 *  ran 0.11 mm back below its tip, and the round pocket's surface folded
 *  there). Keep the joint (and its tangent) if that moves the tip OUTWARD;
 *  else keep the tip and make the arc tangent to its neighbour, whose end
 *  moves to the new tangent point. Pointed (line) ends stay. In place. */
function centreEnds(els) {
  const keepJoint = (e, top) => {
    const J = top ? e.a : e.b, n = v2.mul(v2.sub(e.c, J), 1 / e.r);
    if (Math.abs(n[0]) < 1e-12) return null;
    const t = -J[0] / n[0];
    if (!(t > 0)) return null;
    const c = [0, J[1] + t * n[1]], tip = [0, c[1] + (top ? t : -t)], old = top ? e.b : e.a;
    if (top ? tip[1] < old[1] : tip[1] > old[1]) return null; // would move inward
    return top ? endArc(J, tip, c) : endArc(tip, J, c);
  };
  const keepTip = (e, nb, top) => {
    const T = top ? e.b : e.a, sg = top ? 1 : -1;
    const cOf = (r) => [0, T[1] - sg * r];
    // the tangent point on the neighbour (arc: same-side tangency
    // |c - P| = |R - r|; line: the foot of the perpendicular)
    const touch = (r) => {
      const c = cOf(r);
      if (nb.type === "line") {
        const d = v2.unit(v2.sub(nb.b, nb.a)), q = v2.sub(c, nb.a);
        const foot = v2.add(nb.a, v2.mul(d, q[0] * d[0] + q[1] * d[1]));
        return { f: v2.len(v2.sub(c, foot)) - r, J: foot };
      }
      const dc = v2.sub(c, nb.c), L = v2.len(dc);
      return { f: L - Math.abs(nb.r - r), J: v2.add(nb.c, v2.mul(dc, (r > nb.r ? -nb.r : nb.r) / L)) };
    };
    const old = top ? e.a : e.b, rMax = 20 * Math.max(e.r, nb.type === "arc" ? nb.r : e.r);
    let best = null;
    for (let k = 1, N = 4000; k < N; k++) {
      let lo = (rMax * k) / N, hi = (rMax * (k + 1)) / N;
      if (touch(lo).f * touch(hi).f > 0) continue;
      for (let it = 0; it < 100; it++) {
        const m = (lo + hi) / 2;
        if (touch(m).f * touch(lo).f > 0) lo = m; else hi = m;
      }
      const r = (lo + hi) / 2, { f, J } = touch(r), d = v2.len(v2.sub(J, old));
      if (Math.abs(f) < 1e-6 && (!best || d < best.d)) best = { r, J, d };
    }
    if (!best) return null;
    // on the neighbour's own circle / line, near the old joint (the
    // neighbour may get a little shorter OR longer)
    const nbLen = nb.type === "line" ? v2.len(v2.sub(nb.b, nb.a)) : Math.abs(nb.sw) * nb.r;
    if (best.d > 0.3 * nbLen) return null;
    const c = cOf(best.r);
    return top
      ? { end: endArc(best.J, T, c), nb: elTo(nb, nb.a, best.J) }
      : { end: endArc(T, best.J, c), nb: elTo(nb, best.J, nb.b) };
  };
  for (const top of [false, true]) {
    const i = top ? els.length - 1 : 0, j = top ? i - 1 : 1;
    const e = els[i];
    if (e.type !== "arc" || Math.abs(e.c[0]) < 1e-9 || j < 0 || j >= els.length) continue;
    const kj = keepJoint(e, top);
    if (kj) { els[i] = kj; continue; }
    const kt = keepTip(e, els[j], top);
    if (kt) { els[i] = kt.end; els[j] = kt.nb; }
  }
}

/** e's own line / circle, from exactly a to exactly b (both on it) */
function elTo(e, a, b) {
  if (e.type === "line") return lineEl(a, b);
  const ta = elNear(a, e).t, tb = elNear(b, e).t;
  const th = e.a0 + e.sw * (ta + tb) / 2;
  return arcEl(a, b, e.c, e.convex, [Math.cos(th), Math.sin(th)]);
}

/** an arc a -> b about c (sweep < 180 deg), convex (end arcs are) */
function endArc(a, b, c) {
  return arcEl(a, b, c, true, v2.unit(v2.add(v2.unit(v2.sub(a, c)), v2.unit(v2.sub(b, c)))));
}

/** the elements replacing P between one slot's two fillet contacts on
 *  the right side (bottom to top): fillet, stadium arc (+ straight parts
 *  when a fillet lands on a straight side), fillet */
function slotRun(bot, top, hs, cy, R) {
  const Cs = [hs, cy];
  const fil = (f, from, to) => arcEl(from, to, f.c, false,
    v2.unit(v2.add(v2.unit(v2.sub(from, f.c)), v2.unit(v2.sub(to, f.c)))));
  const run = [fil(bot, bot.T, bot.A)];
  if (!bot.arc) run.push(lineEl(bot.A, [hs, cy - R]));
  const th0 = bot.arc ? -bot.th : -Math.PI / 2, th1 = top.arc ? top.th : Math.PI / 2;
  const pa = bot.arc ? bot.A : [hs, cy - R], pb = top.arc ? top.A : [hs, cy + R];
  if (th1 - th0 > 1e-6) {
    const mth = (th0 + th1) / 2;
    run.push(arcEl(pa, pb, Cs, true, [Math.cos(mth), Math.sin(mth)]));
  }
  if (!top.arc) run.push(lineEl([hs, cy + R], top.A));
  run.push(fil(top, top.A, top.T));
  return run;
}

/** the chain sampled to a polygon (arcs every ~0.25 mm) */
export function chainPoly(chain) {
  const out = [];
  for (const e of chain) {
    if (e.type === "line") { out.push(e.a); continue; }
    const n = Math.max(2, Math.ceil(Math.abs(e.sw) * e.r / 0.25));
    for (let k = 0; k < n; k++) out.push(elAt(e, k / n));
  }
  return out;
}

export const planPoly = chainPoly; // tests: the plan outline U as points

/** CCW and no self-crossings */
function chainSimple(chain) {
  const p = chainPoly(chain), n = p.length;
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a2 += p[i][0] * p[j][1] - p[i][1] * p[j][0];
  }
  if (!(a2 > 0)) return false;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = p[j], d = p[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
          Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return false;
    }
  }
  return true;
}

/** U's right half, from the profile's bottom tip up to its top tip,
 *  each run replacing the profile between its contacts (element i at t;
 *  runs sorted, disjoint) */
function rightHalf(els, runs) {
  const out = [];
  let k = 0, t = 0;
  const part = (e, t0, t1) => {
    if (t1 - t0 > 1e-9 && v2.len(v2.sub(elAt(e, t0), elAt(e, t1))) > 1e-7) {
      out.push(elPart(e, t0, t1));
    }
  };
  for (const r of runs) {
    for (; k < r.bot.i; k++, t = 0) part(els[k], t, 1);
    part(els[k], t, r.bot.t);
    out.push(...r.els);
    k = r.top.i; t = r.top.t;
  }
  for (; k < els.length; k++, t = 0) part(els[k], t, 1);
  return out;
}

/** unit tangent of e at parameter t, in its direction of travel */
function elTan(e, t) {
  if (e.type === "line") return v2.unit(v2.sub(e.b, e.a));
  const th = e.a0 + e.sw * t, s = Math.sign(e.sw);
  return [-s * Math.sin(th), s * Math.cos(th)];
}

/** the arc from p leaving along unit tangent t, through q (a line when
 *  it is straight); CCW chain: centre on the left = convex */
function tanArc(p, t, q) {
  const n = [-t[1], t[0]], w = v2.sub(p, q), nw = n[0] * w[0] + n[1] * w[1];
  const s = Math.abs(nw) < 1e-12 ? Infinity : -(w[0] * w[0] + w[1] * w[1]) / (2 * nw);
  if (!(Math.abs(s) < 1e5)) return lineEl(p, q);
  const c = v2.add(p, v2.mul(n, s));
  return arcEl(p, q, c, s > 0, v2.unit(v2.add(v2.unit(v2.sub(p, c)), v2.unit(v2.sub(q, c)))));
}

/** G1 everywhere (2026-10-23): the line/arc fit and the slot fillets
 *  meet at kinks of up to ~5 deg. A round pocket's walls are extruded from
 *  this outline, and Onshape has to split a wall that isn't smooth (the
 *  owner's v6 tear sat on a 2.35 deg kink). At every kinked joint both
 *  elements are trimmed back BRIDGE mm and joined by a biarc (two tangent
 *  arcs, equal tangent lengths): lines + arcs still, so the flare offsets
 *  work; the outline moves ~BRIDGE * kink / 4 (< 0.01 mm). */
const BRIDGE = 0.5; // mm
const BRIDGE_IN = 0.005; // mm: the most a convex corner's bridge cuts in
const CONCAVE_R = 2.0; // mm: smallest concave bridge (the rim flare is 1 mm)
function g1Chain(right) {
  const len = (e) => e.type === "line" ? v2.len(v2.sub(e.b, e.a)) : Math.abs(e.sw) * e.r;
  const out = [right[0]];
  const turn = (a, b) => { const t0 = elTan(a, 1), t2 = elTan(b, 0); return t0[0] * t2[1] - t0[1] * t2[0]; };
  for (let i = 1; i < right.length; i++) {
    const p = out[out.length - 1];
    let q = right[i];
    // a concave corner the fit split into two kinks with a short element
    // between: bridge straight across that element (the bridge lies
    // outside the outline there, so the pocket only grows)
    while (turn(p, q) < 0 && i + 1 < right.length && turn(q, right[i + 1]) <= 0 &&
      len(q) < 1.0) {
      q = right[++i];
    }
    const t0 = elTan(p, 1), t2 = elTan(q, 0);
    const kink = Math.acos(Math.max(-1, Math.min(1, t0[0] * t2[0] + t0[1] * t2[1])));
    if (kink < 0.01 * Math.PI / 180) {
      out.push(q);
      continue;
    }
    // a convex corner (left turn, CCW) is bridged INSIDE it, towards the
    // tool: trim only so far that it moves <= BRIDGE_IN; a concave one
    // only ever makes the pocket bigger
    const convex = t0[0] * t2[1] - t0[1] * t2[0] > 0;
    const dMax = Math.min(0.3 * len(p), 0.3 * len(q));
    // the rim flare is offset OUTWARD from this outline: a concave arc
    // tighter than the flare turns inside out (a real corner, e.g. a
    // ferrule step, bridged at 0.5 mm gave r 0.53 and an invalid bin), so
    // concave bridges grow until r >= CONCAVE_R
    let d = Math.min(convex ? (4 * BRIDGE_IN) / kink : BRIDGE, BRIDGE, dMax);
    let br = biarc(p, q, d);
    for (let it = 0; !convex && br.rMin < CONCAVE_R && d < dMax && it < 8; it++) {
      d = Math.min(dMax, d * (CONCAVE_R / br.rMin) * 1.02);
      br = biarc(p, q, d);
    }
    out[out.length - 1] = br.p;
    out.push(...br.mid, br.q);
  }
  return out;
}

/** p's end and q's start trimmed back d mm, joined by a biarc:
 *  Q0 = P0 + k u0, Q1 = P2 - k u2, |Q1 - Q0| = 2k, the joint J at the
 *  middle of Q0-Q1 (tangent there along Q1 - Q0) */
function biarc(p, q, d) {
  const len = (e) => e.type === "line" ? v2.len(v2.sub(e.b, e.a)) : Math.abs(e.sw) * e.r;
  const P0 = elAt(p, 1 - d / len(p)), P2 = elAt(q, d / len(q));
  const u0 = elTan(p, 1 - d / len(p)), u2 = elTan(q, d / len(q));
  const v = v2.sub(P2, P0), ts = v2.add(u0, u2);
  const a = ts[0] * ts[0] + ts[1] * ts[1] - 4, b = v[0] * ts[0] + v[1] * ts[1], c = v[0] * v[0] + v[1] * v[1];
  const k = Math.abs(a) < 1e-12 ? c / (2 * b) : (b - Math.sqrt(b * b - a * c)) / a;
  const Q0 = v2.add(P0, v2.mul(u0, k)), Q1 = v2.sub(P2, v2.mul(u2, k));
  const J = v2.mul(v2.add(Q0, Q1), 0.5);
  const mid = [tanArc(P0, u0, J), tanArc(J, v2.unit(v2.sub(Q1, Q0)), P2)];
  const rMin = Math.min(...mid.map((e) => (e.type === "arc" ? e.r : Infinity)));
  return { p: elTo(p, p.a, P0), mid, q: elTo(q, P2, q.b), rMin };
}

/** The plan of a round pocket above the axis. `round` = profilestage's
 *  {mer, scoops, scoopR, blend}; `flare` = the rim flare size. Returns
 *  { chain: U (CCW, closed), slots: [{y, hs, mode}] } where mode is
 *  "plan" (in U, filleted), "inside" (inside P: nothing above the axis)
 *  or "full" (no clean fillet: the old full-height plain slot, logged). */
export function roundPlan(round, flare = 0) {
  const { mer, scoops = [], scoopR: R = 0 } = round;
  const q = cradleProfile(mer);
  const P = cradlePlan(mer), Ppoly = chainPoly(P);
  // scoops within 1 mm of the same height share one slot (a mirrored
  // pair's spots differ by a hair: two near-identical slots would be
  // near-coincident faces), as wide as the wider of them
  const slots = [];
  if (R > 0) {
    for (const [sx, sy] of scoops) {
      const s = slots.find((t) => Math.abs(t.y - sy) < 1);
      if (s) s.hs = Math.max(s.hs, Math.abs(sx));
      else slots.push({ y: sy, hs: Math.abs(sx) });
    }
  }
  slots.sort((a, b) => a.y - b.y);
  // the fillet stays bigger than the flare so the flare's inward offset
  // of a fillet arc can't fold; never under 1.5 mm, so the negative body
  // (no flare) gets the same fillet as the bin's 1 mm edge
  const rb = Math.max(+round.blend || 0, 1.5, flare + 0.5);
  for (const s of slots) {
    // a slot whose end stays (nearly) inside the plan only matters under
    // the axis; 0.2 mm would be a near-coincident sliver above it
    if (chainDist([s.hs + R, s.y], P, Ppoly).d < 0.2) { s.mode = "inside"; continue; }
    const bot = slotFillet(P, Ppoly, s.hs, s.y, R, rb, -1);
    const top = slotFillet(P, Ppoly, s.hs, s.y, R, rb, 1);
    const ok = bot && top && bot.T[0] > 0.5 && top.T[0] > 0.5 &&
      bot.i < q.length && top.i < q.length && // on the +x side
      (bot.i < top.i || (bot.i === top.i && bot.t < top.t));
    s.mode = ok ? "plan" : "full";
    if (ok) s.run = { bot, top, els: slotRun(bot, top, s.hs, s.y, R) };
  }
  // assemble; a run that crosses another, or leaves part of P outside U,
  // falls back to "full" and the plan is rebuilt without it
  for (;;) {
    const runs = slots.filter((s) => s.mode === "plan").map((s) => s.run);
    let clash = runs.findIndex((r, j) => j > 0 &&
      (runs[j - 1].top.i > r.bot.i ||
       (runs[j - 1].top.i === r.bot.i && runs[j - 1].top.t >= r.bot.t)));
    let chain = null;
    let right = null;
    if (clash < 0) {
      right = g1Chain(rightHalf(q, runs));
      chain = [...right, ...mirrorChain(right)];
      if (!chainSimple(chain)) clash = 0;
      else {
        const poly = chainPoly(chain);
        if (Ppoly.some((v) => polyDist(v, poly).d > 0.01)) clash = 0;
      }
    }
    if (clash < 0) {
      // a slot that can't widen the plan is left out of the pocket and
      // reported (owner, 2026-10-23: skip it, with a notice)
      const skipped = slots.filter((s) => s.mode !== "plan").map((s) => ({
        y: s.y, why: s.mode === "inside" ? "inside" : "nofillet" }));
      return { chain, right, slots, rb, skipped };
    }
    const bad = slots.filter((s) => s.mode === "plan")[clash];
    bad.mode = "full";
  }
}

const elNormal = (e, p) => e.type === "line"
  ? (() => { const d = v2.unit(v2.sub(e.b, e.a)); return [d[1], -d[0]]; })()
  : e.convex ? v2.unit(v2.sub(p, e.c)) : v2.unit(v2.sub(e.c, p));

/** intersections of two offset elements (line/arc), nearest to `near` */
function elMeet(e1, e2, off, near) {
  const geo = (e) => e.type === "line"
    ? { line: true, p: v2.add(e.a, v2.mul(elNormal(e, e.a), off)), d: v2.unit(v2.sub(e.b, e.a)) }
    : { line: false, c: e.c, r: e.r + (e.convex ? off : -off) };
  const g1 = geo(e1), g2 = geo(e2);
  if (g1.line && g2.line) return near; // line/line: capped miter (below)
  if (!g1.line && !g2.line) {
    const dc = v2.sub(g2.c, g1.c), L = v2.len(dc);
    if (L < 1e-9) return near;
    const x = (L * L + g1.r * g1.r - g2.r * g2.r) / (2 * L), h2 = g1.r * g1.r - x * x;
    if (h2 < 0) return near;
    const u = v2.mul(dc, 1 / L), base = v2.add(g1.c, v2.mul(u, x)), h = Math.sqrt(h2);
    return [v2.add(base, [-u[1] * h, u[0] * h]), v2.add(base, [u[1] * h, -u[0] * h])]
      .reduce((m, p) => v2.len(v2.sub(p, near)) < v2.len(v2.sub(m, near)) ? p : m);
  }
  const L = g1.line ? g1 : g2, C = g1.line ? g2 : g1;
  const f = v2.sub(L.p, C.c);
  const b = f[0] * L.d[0] + f[1] * L.d[1], cc = f[0] * f[0] + f[1] * f[1] - C.r * C.r;
  const disc = b * b - cc;
  if (disc < 0) return near;
  const s = Math.sqrt(disc);
  return [-b - s, -b + s].map((t) => v2.add(L.p, v2.mul(L.d, t)))
    .reduce((m, p) => v2.len(v2.sub(p, near)) < v2.len(v2.sub(m, near)) ? p : m);
}

/** the chain offset outward by `off` as a closed wire at height z. Line
 *  corners use the capped vertex-bisector miter the cradle flare always
 *  used (an exact miter at a tool's pointed end would shoot far out). */
function chainWire(oc, chain, off, z) {
  const n = chain.length;
  const pts = chain.map((e, i) => {
    const prev = chain[(i - 1 + n) % n], p = e.a;
    if (off === 0) return p;
    const n1 = elNormal(prev, p), n2 = elNormal(e, p);
    if (v2.len(v2.sub(n1, n2)) < 1e-6) return v2.add(p, v2.mul(n1, off));
    const m = v2.unit(v2.add(n1, n2));
    if (prev.type === "line" && e.type === "line") {
      const k = 1 / Math.max(0.5, m[0] * n1[0] + m[1] * n1[1]); // miter, capped 2×
      return v2.add(p, v2.mul(m, off * k));
    }
    return elMeet(prev, e, off, v2.add(p, v2.mul(m, off)));
  });
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < n; i++) {
    const e = chain[i], a = pts[i], b = pts[(i + 1) % n];
    if (e.type === "line") {
      const me = new oc.BRepBuilderAPI_MakeEdge_3(new oc.gp_Pnt_3(a[0], a[1], z),
        new oc.gp_Pnt_3(b[0], b[1], z));
      mw.Add_1(me.Edge());
      me.delete();
    } else {
      const r = e.r + (e.convex ? off : -off), m = v2.add(e.c, v2.mul(e.md, r));
      mw.Add_1(arcEdge(oc, [a[0], a[1], z], [m[0], m[1], z], [b[0], b[1], z]));
    }
  }
  if (!mw.IsDone()) throw new Error("round tool: pocket outline wire not closed");
  const w = mw.Wire();
  mw.delete();
  return w;
}

/** The round pocket's rim flare, ONE ruled loft from U (concentric arc
 *  offsets: exact cones; a smooth loft took ~10 s and once came out
 *  invalid). Fillet style = a 6-facet round-over. */
function roundEntryCutter(oc, chain, size, H, style, log) {
  const wires = [chainWire(oc, chain, 0, H - size)];
  if (style === "fillet") {
    for (let i = 1; i <= 6; i++) {
      const ang = (Math.PI / 2) * (i / 6);
      wires.push(chainWire(oc, chain, (1 - Math.cos(ang)) * size, H - size + Math.sin(ang) * size));
    }
  } else {
    wires.push(chainWire(oc, chain, size, H));
  }
  wires.push(chainWire(oc, chain, size, H + 0.5));
  const s = thruSections(oc, wires, true, true);
  log(`pocket entry: ${style} ${size} mm (round tool, lofted cutter)`);
  return s;
}

/** The round-tool pocket as cutters: ONE solid (roundsurf.js) — the one
 *  surface below the axis, walls from the axis up to `top`, finger slots
 *  part of the surface. `plan` = roundPlan(). A slot that can't widen the
 *  plan is left out (plan.skipped; the app shows a notice). */
export function roundCutters(oc, round, floor, top, plan, log = () => {}) {
  for (const s of plan.slots) {
    if (s.mode === "plan") {
      log(`round tool: finger slot at y ${s.y.toFixed(1)}, ${plan.rb.toFixed(1)} mm fillet at the walls`);
    }
  }
  for (const k of plan.skipped) {
    log(`round tool: finger slot at y ${k.y.toFixed(1)} skipped (${k.why === "inside"
      ? "inside the tool's outline" : "no clean junction with the walls"})`);
  }
  return [roundPocket(oc, plan, round, top)];
}

/** The negative body: the pocket cutout as its own solid — the same
 *  clamped outline prism the bin is cut with (scoops included), from the
 *  floor up to the rim, flush (no +1 overshoot, no entry chamfer, no
 *  magnets). Same coordinates as the bin. */
export function pocketBody(oc, segs, periodic, floor, H, round = null) {
  if (!round) {
    return prism(oc, faceFromWire(oc, profileWire(oc, segs, periodic, floor)),
      H - floor);
  }
  // round tool: the same one-surface pocket, its cap at the rim
  return roundPocket(oc, roundPlan(round), round, H);
}

/** Puzzle-piece body outline at height z: the kept cells' loop
 *  (puzzleOutline vertices, CCW, inset GAP/2) with every corner rounded:
 *  outside corners R_TOP like a full bin, inside corners R_TOP − GAP so a
 *  neighbour bin's R_TOP corner still nests with ≥ GAP to spare. Lines +
 *  three-point arcs, the same primitives as rrectWire. */
export function puzzleWire(oc, verts, z) {
  const n = verts.length;
  const unit = (a, b) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };
  const arcs = verts.map(({ p, convex }, k) => {
    const din = unit(verts[(k - 1 + n) % n].p, p);
    const dout = unit(p, verts[(k + 1) % n].p);
    const r = convex ? R_TOP : R_TOP - GAP;
    const a = [p[0] - r * din[0], p[1] - r * din[1]];
    const b = [p[0] + r * dout[0], p[1] + r * dout[1]];
    // centre: inward (left of travel) for an outside corner, outward for
    // an inside one; the arc's midpoint lies toward the corner point
    const s = convex ? 1 : -1;
    const c = [a[0] - s * r * din[1], a[1] + s * r * din[0]];
    const v = unit(c, p);
    return { a, m: [c[0] + r * v[0], c[1] + r * v[1]], b };
  });
  const mw = new oc.BRepBuilderAPI_MakeWire_1();
  for (let k = 0; k < n; k++) {
    const { a, m, b } = arcs[k];
    mw.Add_1(arcEdge(oc, [a[0], a[1], z], [m[0], m[1], z], [b[0], b[1], z]));
    const na = arcs[(k + 1) % n].a;
    mw.Add_1(segmentEdge(oc, [b[0], b[1], z], [na[0], na[1], z]));
  }
  if (!mw.IsDone()) throw new Error("puzzle-piece outline wire failed");
  const w = mw.Wire();
  mw.delete();
  return w;
}

export function cellCenters(nx, ny) {
  const out = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      out.push([(i - (nx - 1) / 2) * GRID, (j - (ny - 1) / 2) * GRID]);
    }
  }
  return out;
}

/** Port of bin3d.build_bin. Returns { shape, depth, H }. */
export function buildBin(oc, segs, periodic, nx, ny, nz, thickness, {
  magnets = null, edgeStyle = null, edgeSize = 1.0,
  center = [0, 0], pocketPts = null, keepCells = null, footClearance = 0,
  round = null,
  log = () => {},
} = {}) {
  const H = nz * 7.0;
  let depth = thickness;
  if (H - depth < MIN_FLOOR) {
    depth = H - MIN_FLOOR;
    log(`pocket depth clamped to ${depth} mm (floor >= ${MIN_FLOOR} mm); ` +
        `tool sits ${(thickness - depth).toFixed(1)} mm proud`);
  }
  const W = nx * GRID - GAP, D = ny * GRID - GAP;
  const [bx, by] = center;
  log(`bin ${nx}x${ny}x${nz} (${W} x ${D} x ${H} mm), pocket depth ${depth}`);

  // puzzle-piece bin: only the kept cells (keepCells = [[i, j], ...])
  const kept = keepCells && keepCells.length < nx * ny ? keepCells : null;
  let outer;
  if (kept) {
    const grid = Array.from({ length: nx }, () => new Array(ny).fill(false));
    for (const [i, j] of kept) grid[i][j] = true;
    outer = puzzleWire(oc, puzzleOutline(grid, nx, ny, center), FOOT_H);
    log(`puzzle-piece bin: ${kept.length} of ${nx * ny} cells`);
  } else {
    outer = rrectWire(oc, bx, by, W, D, R_TOP, FOOT_H);
  }
  let shape = prism(oc, faceFromWire(oc, outer), H - FOOT_H);
  // cellCenters runs i-major, j-minor: index i * ny + j
  const cells = cellCenters(nx, ny).map(([cx, cy]) => [cx + bx, cy + by])
    .filter((_, k) => !kept ||
      kept.some(([i, j]) => i * ny + j === k));
  const fc = Math.max(0, +footClearance || 0);
  if (fc > 0) log(`feet: looser fit, profile ${fc} mm smaller per side`);
  for (const [cx, cy] of cells) shape = fuse(oc, shape, foot(oc, cx, cy, fc));

  if ((edgeStyle === "fillet" || edgeStyle === "chamfer") && edgeSize > 0) {
    shape = treatEdges(oc, shape, topEdges(oc, shape, H), edgeStyle, edgeSize,
      "rim", log);
  }

  const floor = H - depth;
  const flare = (edgeStyle === "fillet" || edgeStyle === "chamfer") && edgeSize > 0
    ? edgeSize : 0;
  const plan = round ? roundPlan(round, flare) : null;
  const cutters = round
    ? roundCutters(oc, round, floor, H + 1, plan, log)
    : [prism(oc, faceFromWire(oc, profileWire(oc, segs, periodic, floor)),
      depth + 1)];
  if (round) {
    log(`round tool: cradle r ${meridianR(round.mer).toFixed(2)} mm, axis ` +
      `${round.a > 0 ? `${round.a.toFixed(1)} mm below` : "at"} the top`);
  }
  const entry = (edgeStyle === "fillet" || edgeStyle === "chamfer") && edgeSize > 0;
  // Closed outlines: the pocket wall is CLAMPED (see profileWire), so a
  // ThruSections flare (periodic sections; clamped ones abort the wasm)
  // would meet it in a different knot basis — Onshape rejected every
  // such bin (owner, 2026-10-08). Treat the rim edge itself instead,
  // after the cut. Segmented outlines keep the reference cutter.
  if (entry && round) {
    cutters.push(roundEntryCutter(oc, plan.chain, edgeSize, H, edgeStyle, log));
  } else if (entry && pocketPts) {
    cutters.push(pocketEntryCutter(oc, segs, periodic, pocketPts, edgeSize, H,
      edgeStyle, log));
  }
  if (magnets) {
    const { r, depth: md, chamfer: mc } = magnets;
    for (const [cx, cy] of cells) {
      for (const dx of [-MAG_OFF, MAG_OFF]) {
        for (const dy of [-MAG_OFF, MAG_OFF]) {
          cutters.push(cylinder(oc, cx + dx, cy + dy, 0, r, md));
          if (mc > 0) cutters.push(cone(oc, cx + dx, cy + dy, 0, r + mc, r, mc));
        }
      }
    }
  }
  shape = cutAll(oc, shape, cutters);
  if (!isValid(oc, shape)) throw new Error("bin solid is not valid");
  log(`bin solid valid, ${cutters.length} cutters applied`);
  // user-facing: finger scoops the round pocket had to leave out
  const notices = (plan?.skipped ?? []).map((k) => k.why === "inside"
    ? "A finger scoop sits inside the tool's outline, so it can't make room for a finger. It was left out: move it out past the tool's edge, or make it bigger."
    : "A finger scoop couldn't be blended into the pocket walls, so it was left out. Try moving it along the tool or changing its size.");
  return { shape, depth, H, notices: [...new Set(notices)] };
}

/** solid.tessellate port: preview mesh { positions, indices }. */
export function tessellate(oc, shape, linDefl = 0.2, angDefl = 0.3) {
  new oc.BRepMesh_IncrementalMesh_2(shape, linDefl, false, angDefl, true);
  const positions = [], indices = [];
  const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  while (exp.More()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const loc = new oc.TopLoc_Location_1();
    const triH = oc.BRep_Tool.Triangulation(face, loc, 0);
    if (!triH.IsNull()) {
      const tri = triH.get();
      const trsf = loc.Transformation();
      const base = positions.length / 3;
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = tri.Node(i).Transformed(trsf);
        positions.push(Math.round(p.X() * 100) / 100,
          Math.round(p.Y() * 100) / 100, Math.round(p.Z() * 100) / 100);
      }
      const rev = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let i = 1; i <= tri.NbTriangles(); i++) {
        const t = tri.Triangle(i);
        let [a, b, c] = [t.Value(1), t.Value(2), t.Value(3)];
        if (rev) [b, c] = [c, b];
        indices.push(base + a - 1, base + b - 1, base + c - 1);
      }
    }
    loc.delete();
    exp.Next();
  }
  exp.delete();
  return { positions, indices };
}

/** solid.write_step + embed_design: returns the STEP file TEXT. */
export function writeStepText(oc, shape, { name = null, design = null } = {}) {
  const filename = "out.step";
  oc.Interface_Static.SetCVal("write.step.unit", "MM");
  let status;
  let named = false;
  if (name) {
    try {
      const doc = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2("doc", true));
      const docH = new oc.Handle_TDocStd_Document_2(doc);
      const st = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main()).get();
      const label = st.AddShape(shape, false, false);
      oc.TDataStd_Name.Set_1(label, new oc.TCollection_ExtendedString_2(name, true));
      const wr = new oc.STEPCAFControl_Writer_1();
      // multi MUST be null: any string (even "") flips OCCT into external-
      // reference mode and out.step becomes a 45-entity stub
      if (!wr.Transfer_1(docH, oc.STEPControl_StepModelType.STEPControl_AsIs,
          null, new oc.Message_ProgressRange_1())) {
        throw new Error("CAF transfer failed");
      }
      status = wr.Write(filename);
      wr.delete();
      named = true;
    } catch (err) {
      named = false;
    }
  }
  if (!named) {
    const wr = new oc.STEPControl_Writer_1();
    wr.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true,
      new oc.Message_ProgressRange_1());
    status = wr.Write(filename);
    wr.delete();
  }
  if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
    throw new Error(`STEP write failed: ${status}`);
  }
  const bytes = oc.FS.readFile("/" + filename);
  oc.FS.unlink("/" + filename);
  let text = new TextDecoder().decode(bytes);
  if (name) text = nameBodies(text, name);
  if (design !== null) text = embedDesign(text, design);
  return text;
}

/** OCCT only names the PRODUCT (which Bambu reads); Onshape takes part
 *  names from the SOLID/representation entities, which OCCT leaves ''.
 *  Commercial CAD fills those — so we do too, textually. */
export function nameBodies(text, name) {
  const esc = name.replace(/'/g, "''");
  return text
    .replace(/MANIFOLD_SOLID_BREP\('',/g, `MANIFOLD_SOLID_BREP('${esc}',`)
    .replace(/ADVANCED_BREP_SHAPE_REPRESENTATION\('',/g,
      `ADVANCED_BREP_SHAPE_REPRESENTATION('${esc}',`);
}

/** solid.embed_design: S2S| comment chunks just inside DATA; */
export function embedDesign(text, design) {
  const payload = JSON.stringify(design);
  if (payload.includes("*/")) throw new Error("design JSON cannot contain '*/'");
  const chunks = [];
  for (let i = 0; i < payload.length; i += 900) chunks.push(payload.slice(i, i + 900));
  const block = chunks.map((c) => `/* S2S| ${c} */`).join("\n");
  const i = text.indexOf("\nDATA;");
  if (i < 0) throw new Error("DATA section not found in STEP file");
  const at = i + "\nDATA;".length;
  return text.slice(0, at) + "\n" + block + text.slice(at);
}

/** solid.extract_design */
export function extractDesign(text) {
  const chunks = [...text.matchAll(/\/\* S2S\| (.*?) \*\//gs)].map((m) => m[1]);
  if (chunks.length) return JSON.parse(chunks.join(""));
  const m = text.match(/\/\* S2S-DESIGN (.*?) \*\//s);
  return m ? JSON.parse(m[1]) : null;
}

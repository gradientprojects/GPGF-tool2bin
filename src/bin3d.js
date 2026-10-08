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

function foot(oc, cx, cy) {
  return thruSections(oc, [
    rrectWire(oc, cx, cy, FOOT_BOT, FOOT_BOT, R_BOT, 0.0),
    rrectWire(oc, cx, cy, FOOT_BOT + 2 * CH1, FOOT_BOT + 2 * CH1, R_BOT + CH1, CH1),
    rrectWire(oc, cx, cy, FOOT_BOT + 2 * CH1, FOOT_BOT + 2 * CH1, R_BOT + CH1,
      CH1 + STRAIGHT),
    rrectWire(oc, cx, cy, FOOT_TOP, FOOT_TOP, R_TOP, FOOT_H),
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

/** The negative body: the pocket cutout as its own solid — the same
 *  clamped outline prism the bin is cut with (scoops included), from the
 *  floor up to the rim, flush (no +1 overshoot, no entry chamfer, no
 *  magnets). Same coordinates as the bin. */
export function pocketBody(oc, segs, periodic, floor, H) {
  return prism(oc, faceFromWire(oc, profileWire(oc, segs, periodic, floor)),
    H - floor);
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
  center = [0, 0], pocketPts = null, log = () => {},
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

  let shape = prism(oc, faceFromWire(oc, rrectWire(oc, bx, by, W, D, R_TOP, FOOT_H)),
    H - FOOT_H);
  const cells = cellCenters(nx, ny).map(([cx, cy]) => [cx + bx, cy + by]);
  for (const [cx, cy] of cells) shape = fuse(oc, shape, foot(oc, cx, cy));

  if ((edgeStyle === "fillet" || edgeStyle === "chamfer") && edgeSize > 0) {
    shape = treatEdges(oc, shape, topEdges(oc, shape, H), edgeStyle, edgeSize,
      "rim", log);
  }

  const floor = H - depth;
  const pocket = prism(oc, faceFromWire(oc, profileWire(oc, segs, periodic, floor)),
    depth + 1);
  const cutters = [pocket];
  const entry = (edgeStyle === "fillet" || edgeStyle === "chamfer") && edgeSize > 0;
  // Closed outlines: the pocket wall is CLAMPED (see profileWire), so a
  // ThruSections flare (periodic sections; clamped ones abort the wasm)
  // would meet it in a different knot basis — Onshape rejected every
  // such bin (owner, 2026-10-08). Treat the rim edge itself instead,
  // after the cut. Segmented outlines keep the reference cutter.
  if (entry && pocketPts) {
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
  return { shape, depth, H };
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

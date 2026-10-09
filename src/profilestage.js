// Stage 4-5 driver: mirror of server.compute_profile / layout /
// auto_scoops / profile_response (the profile-side subset; bin
// construction is C5). Adds two app-side features the reference does
// not have, both OFF by default so parity against the oracle holds:
//   maxContour     — pocket derives from the convex hull of the tool
//                    contour (never hugs into concavities).
//   strictContain  — after everything, the pocket is unioned with the
//                    tool+clearance outline, guaranteeing containment
//                    even where the reference accepts a non-converged
//                    smooth fit.
//   flatFaithful   — extra smooth-fit acceptance gate: along straight
//                    stretches of the outline the curve must stay
//                    within 0.3 mm (corners exempt — the containment
//                    inflation overshoots there by design), so flat
//                    tool edges stay flat on a lower smoothing rung.
import {
  symmetrizeContour, offsetContour, smoothProfile, addScoops, closedOutline,
  periodicFit, rasterize, sdf, fillMask, bbox, ccw, PX, LAM_BASE, refitMask,
  opening, closing,
} from "./smoothprof.js";
import {
  chordReplace, mirrorSpans, mirrorDrags, dragContour, nearestIndex, DRAG_R,
  shorterArc, tangentLine,
} from "./outlineedit.js";
import { evalPeriodic } from "./bspline.js";
import { resample, detectCorners, fitProfile, sampleSegs } from "./profilefit.js";
import { roundHalfEven, GridNN } from "./nummath.js";
import { findContours } from "./marching.js";
import { puzzleCells, puzzleOutline } from "./puzzle.js";

export const GRID = 42.0;
export const GAP = 0.5;
export const MIN_FLOOR = 7.0; // mm under the pocket; feet are 4.75 mm tall
export const MIN_ENGAGE = 0.75; // shorter bin must hold >= this much of the tool

/** Andrew monotone chain, CCW hull of mm points. */
export function convexHull(pts) {
  const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

export function computeProfile(c, cMm, clearance, smoothR, log = () => {},
                               flatCap = Infinity) {
  if (smoothR > 0) {
    const r = smoothProfile(c, cMm, clearance, smoothR, log, flatCap);
    return { segs: [r.tck], periodic: true, fit: r.fit,
             extra: { minClearance: r.minClearance } };
  }
  let src = cMm;
  if (clearance > 0) src = offsetContour(c, cMm, clearance);
  const p = resample(src);
  const { corners, refined } = detectCorners(p, log);
  const { segs } = fitProfile(p, corners, refined, log);
  const { pts } = sampleSegs(segs);
  return { segs, periodic: false, fit: pts.flat(), extra: {} };
}

/** mode "flush" | "proud" picks one of depthOptions(); "proud" falls
 *  back to flush when no shorter bin is allowed. */
export function layout(fitPts, thickness, minWall, mode = "flush") {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of fitPts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  const nx = Math.ceil((x1 - x0 + 2 * minWall + GAP) / GRID);
  const ny = Math.ceil((y1 - y0 + 2 * minWall + GAP) / GRID);
  const options = depthOptions(thickness);
  const pick = mode === "proud" && options.proud.ok ? options.proud : options.flush;
  return { nx, ny, nz: pick.nz, H: pick.H, depth: pick.depth,
           proud: pick.stickout, mode: pick.mode, options,
           bboxC: [(x1 + x0) / 2, (y1 + y0) / 2] };
}

/** The two pocket choices. flush: full-depth pocket, bin rounded UP to
 *  whole 7 mm units so the floor is never < MIN_FLOOR. proud: one unit
 *  shorter, pocket = exactly MIN_FLOOR of floor, tool stands `stickout`
 *  above the rim (always <= 7 mm, since flush only rounds up by < one
 *  unit) — ok only when the shorter bin still has room for a pocket AND
 *  that pocket holds >= MIN_ENGAGE of the tool (owner, 2026-10-08: a
 *  thin tool half out of its pocket isn't worth 7 mm). `why` says which
 *  rule refused it. */
export function depthOptions(thickness) {
  const nzF = Math.max(1, Math.ceil((thickness + MIN_FLOOR) / 7.0 - 1e-9));
  const flush = { mode: "flush", ok: true, nz: nzF, H: nzF * 7.0,
                  depth: thickness, stickout: 0, saveMm: 0 };
  const nz = nzF - 1, H = nz * 7.0, depth = H - MIN_FLOOR;
  const why = depth <= 0 ? "shortest"
    : depth < MIN_ENGAGE * thickness - 1e-9 ? "engage" : null;
  const proud = { mode: "proud", nz, H, depth, stickout: thickness - depth,
                  saveMm: 7.0, ok: why === null, why };
  return { flush, proud };
}

export function snap(fitPts, pt) {
  let best = Infinity, bi = 0;
  fitPts.forEach(([x, y], i) => {
    const d = Math.hypot(x - pt[0], y - pt[1]);
    if (d < best) { best = d; bi = i; }
  });
  return [fitPts[bi][0], fitPts[bi][1]];
}

/** The mirrored partner of scoop spot p: the far end of the outline's
 *  horizontal chord through p, so the pair sits at the SAME height even
 *  on a curved tool (snapping p's x-mirror to the nearest outline point
 *  drifted up or down the far edge). Snapped to a fit point — on a
 *  symmetric outline that's the x-mirror, as before. */
export function chordPartner(fitPts, p) {
  let far = null;
  for (let i = 0; i < fitPts.length; i++) {
    const [x0, y0] = fitPts[i], [x1, y1] = fitPts[(i + 1) % fitPts.length];
    if ((y0 - p[1]) * (y1 - p[1]) > 0 || y0 === y1) continue;
    const x = x0 + (x1 - x0) * (p[1] - y0) / (y1 - y0);
    if (!far || Math.abs(x - p[0]) > Math.abs(far[0] - p[0])) far = [x, p[1]];
  }
  return snap(fitPts, far || [-p[0], p[1]]);
}

/** Scoop modes: "mirror" (pair, same height, dragged together), "free"
 *  (pair, dragged independently), "left" / "right" (one scoop). */
export const SCOOP_MODES = ["mirror", "free", "left", "right"];

export function autoScoops(fitPts, mode = "mirror") {
  let cy = 0, minX = Infinity;
  for (const [x, y] of fitPts) { cy += y; if (x < minX) minX = x; }
  cy /= fitPts.length;
  const left = snap(fitPts, [minX - 5, cy]);
  const right = chordPartner(fitPts, left);
  if (mode === "left") return [left];
  if (mode === "right") return [right];
  return [left, right];
}

/** Re-shape the spots on screen for a new mode: a lone spot gains its
 *  mirrored partner, mirror re-pairs on the left spot, left/right keep
 *  that side's spot. */
export function scoopsForMode(fitPts, spots, mode) {
  if (!spots || !spots.length) return null;
  const pair = spots.length > 1 ? spots.map((p) => p.slice())
    : [spots[0], chordPartner(fitPts, spots[0])];
  // side = which end of its own horizontal chord a spot is on (plain x
  // misorders them on a slanted tool)
  const side = (p) => p[0] - chordPartner(fitPts, p)[0];
  pair.sort((a, b) => side(a) - side(b));
  if (mode === "left") return [pair[0]];
  if (mode === "right") return [pair[1]];
  if (mode === "mirror") return [pair[0], chordPartner(fitPts, pair[0])];
  return pair;
}

/** Signed distance (mm) from the tool outline, on a raster covering the
 *  tool and `pocketPts` with `margin` to spare: probe(x, y) is bilinear,
 *  positive outside the tool. */
function toolField(c, toolMm, pocketPts, margin) {
  // the canvas must cover the pocket as well as the tool: scoop lobes
  // reach well past the tool bbox, and a pocket clipped at the canvas
  // edge shatters the union contour into open border fragments that the
  // periodic refit then closes into garbage
  const b = bbox([...toolMm, ...pocketPts]);
  const origin = [b.x0 - margin, b.y0 - margin];
  const W = Math.trunc((b.x1 - b.x0 + 2 * margin) * PX) + 2;
  const H = Math.trunc((b.y1 - b.y0 + 2 * margin) * PX) + 2;
  const mask = fillMask(c, H, W, [toolMm], origin);
  const sdTool = sdf(c, mask);
  mask.delete();
  const probe = (x, y) => {
    const r = (y - origin[1]) * PX, cc = (x - origin[0]) * PX;
    const r0 = Math.max(0, Math.min(H - 2, Math.floor(r)));
    const c0 = Math.max(0, Math.min(W - 2, Math.floor(cc)));
    const fr = r - r0, fc = cc - c0;
    const i00 = r0 * W + c0;
    return (sdTool[i00] * (1 - fr) * (1 - fc) + sdTool[i00 + 1] * (1 - fr) * fc +
            sdTool[i00 + W] * fr * (1 - fc) + sdTool[i00 + W + 1] * fr * fc) / PX;
  };
  return { sdTool, origin, H, W, probe };
}

/** Straighten post-pass: each span (two mm points on the pocket) turns
 *  the shorter stretch of pocket between them into a straight line, for
 *  where smoothing bows the pocket off a straight tool edge (it flares
 *  out ~2 mm toward rounded corners). The line keeps the chord's
 *  direction and slides, parallel, to sit exactly `clearance` from the
 *  tool at its closest: in where the pocket bowed out, out where the
 *  chord would cut across the tool (the user is told how far). Only a
 *  line that would have to move out more than MAX_SHIFT isn't built.
 *  `info[i]` reports span i: { built, shift } (shift > 0 = moved out). */
const MAX_SHIFT = 15.0;
const END_REACH = 25.0; // mm of pocket searched past each end of a line
const STRAIGHT_BLEND = 4.0; // mm: default fillet where a line meets the pocket

/** First crossing of the line through a->b by the open path `pts`
 *  (walked from pts[0], up to `reach` mm): { k, x } where x lies on
 *  segment pts[k-1] -> pts[k]. The path starts at b's end of the line. */
function meetLine(pts, a, b, reach) {
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const side = (p) => ux * (p[1] - a[1]) - uy * (p[0] - a[0]);
  let s = 0;
  for (let k = 1; k < pts.length; k++) {
    const p = pts[k - 1], q = pts[k];
    s += Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (s > reach) return null;
    const dp = side(p), dq = side(q);
    if (dp === 0) return { k, x: p };
    if (dp * dq < 0) {
      const t = dp / (dp - dq);
      return { k, x: [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])] };
    }
  }
  return null;
}

export function straightenPocket(c, pocketPts, spans, toolMm, clearance, log,
                                 blend = STRAIGHT_BLEND) {
  // the margin covers lines slid out (<= MAX_SHIFT) past the pocket
  const { sdTool, origin, H, W, probe } =
    toolField(c, toolMm, pocketPts, clearance + MAX_SHIFT + 5.0);
  let poly = pocketPts;
  let done = 0;
  const lines = []; // the lines as built, for the preview
  const info = spans.map(() => ({ built: false, shift: 0, minOff: 0 }));
  spans.forEach(([a, b, dir, off], si) => {
    const next = chordReplace(poly, a, b);
    if (next === poly || next.length < 3) return;
    // the stretch being straightened, p0 -> p1 (next runs p1 .. p0 the
    // long way round, and the line closes p0 -> p1)
    const N = poly.length;
    const { from, to } = shorterArc(poly, nearestIndex(poly, a), nearestIndex(poly, b));
    const arc = [];
    for (let k = from; ; k = (k + 1) % N) { arc.push(poly[k]); if (k === to) break; }
    const p0 = arc[0], p1 = arc[arc.length - 1];
    // the line's direction: the chord, or (shift-click) the set angle
    let ux = p1[0] - p0[0], uy = p1[1] - p0[1];
    if (dir != null) {
      const vx = Math.cos(dir * Math.PI / 180), vy = Math.sin(dir * Math.PI / 180);
      const s = Math.sign(ux * vx + uy * vy) || 1;
      ux = s * vx; uy = s * vy;
    } else {
      const L = Math.hypot(ux, uy) || 1;
      ux /= L; uy /= L;
    }
    const len = (p1[0] - p0[0]) * ux + (p1[1] - p0[1]) * uy;
    if (len < 2.0) return;
    let nx = -uy, ny = ux;
    // outward = away from the bulk of the rest of the pocket (a chord
    // across the tool can't ask the tool's distance field which way)
    let bulk = 0;
    for (let i = 1; i < next.length - 1; i++) {
      bulk += (next[i][0] - p0[0]) * nx + (next[i][1] - p0[1]) * ny;
    }
    if (bulk > 0) { nx = -nx; ny = -ny; }
    // where it sits (offsets from p0 along the outward normal):
    // tangent = resting on the stretch's outermost points (owner: bridge
    // the little bow-in, don't cut into the lobes); never closer to the
    // tool than the clearance (+ a hair, so the refit's wiggle stays out)
    const tg = tangentLine(arc, [ux, uy], [nx, ny]);
    let worst = Infinity;
    const m = Math.ceil(len / 0.25);
    for (let i = 0; i <= m; i++) {
      const t = (i / m) * len;
      worst = Math.min(worst, probe(p0[0] + t * ux, p0[1] + t * uy));
    }
    const clr = clearance - worst + 0.02;
    info[si].shift = clr - tg.sup;   // > 0: the tool pushed it past the tangent
    info[si].minOff = clr - tg.sup;  // how far in a drag may take it
    if (clr - tg.sup > MAX_SHIFT) return;
    // a dragged line: `off` mm out from the tangent (in: down to snug)
    const at = Math.max(clr, tg.sup + (+off || 0));
    const d = arc.map((p) => (p[0] - p0[0]) * nx + (p[1] - p0[1]) * ny);
    const onLine = (p) => {
      const dp = (p[0] - p0[0]) * nx + (p[1] - p0[1]) * ny;
      return [p[0] + (at - dp) * nx, p[1] + (at - dp) * ny];
    };
    let ia = d.findIndex((v) => v >= at - 0.03);
    let ib = d.length - 1;
    while (ib > ia && d[ib] < at - 0.03) ib--;
    const reach = ia >= 0 ? Math.hypot(arc[ib][0] - arc[ia][0], arc[ib][1] - arc[ia][1]) : 0;
    if (ia >= 0 && reach >= 2.0) {
      // the line touches (or cuts) the stretch: replace just the part
      // between its first and last contact; the curve on either side
      // stays and meets it at its own tangent — no jog, no foot
      const cross = (j, k) => { // where segment arc[j] -> arc[k] meets the line
        const t = Math.max(0, Math.min(1, (at - d[j]) / ((d[k] - d[j]) || 1)));
        return onLine([arc[j][0] + t * (arc[k][0] - arc[j][0]),
                       arc[j][1] + t * (arc[k][1] - arc[j][1])]);
      };
      const ea = ia > 0 ? cross(ia - 1, ia) : onLine(arc[0]);
      const eb = ib < arc.length - 1 ? cross(ib + 1, ib) : onLine(arc[arc.length - 1]);
      poly = [...next, ...arc.slice(1, ia), ea, eb, ...arc.slice(ib + 1, -1)];
      lines.push([ea, eb, si]);
    } else {
      // out past the whole stretch (the clearance, or a drag): the chord
      // slid out, each end running on to where it meets the pocket
      const q0 = [p0[0] + nx * at, p0[1] + ny * at];
      const q1 = [p0[0] + ux * len + nx * at, p0[1] + uy * len + ny * at];
      const n = next.length;
      const head = meetLine(next.slice(0, -1), q0, q1, END_REACH);
      const tail = meetLine(next.slice(1).reverse(), q1, q0, END_REACH);
      let i1 = 1, i0 = n - 1; // body = next[i1 .. i0)
      let e1 = q1, e0 = q0;
      if (head) { e1 = head.x; i1 = head.k; }
      if (tail) { e0 = tail.x; i0 = n - tail.k; }
      if (i0 - i1 < 2) { // the two ends met each other: keep them short
        e1 = q1; e0 = q0; i1 = 1; i0 = n - 1;
      }
      poly = [e1, ...next.slice(i1, i0), e0];
      lines.push([e0, e1, si]);
    }
    info[si].built = true;
    done++;
  });
  const skipped = info.filter((s) => !s.built && s.shift > MAX_SHIFT).length;
  const warnings = skipped
    ? [`${skipped} straight line(s) would cut through the tool -- not added`]
    : [];
  if (!done) return { warnings, lines, info };
  // fillet where each line meets the rest of the pocket (owner: it met
  // it at an angle, ~1 mm round): open + close with `blend` (the owner's slider), only
  // in a zone around the line's ends, so the line itself stays straight
  const base = fillMask(c, H, W, [poly], origin);
  {
    const rPx = Math.max(0.5, blend) * PX;
    const op = opening(c, base, rPx);
    const sm = closing(c, op, rPx);
    op.delete();
    const zone = c.Mat.zeros(H, W, c.CV_8UC1);
    const zr = Math.trunc(roundHalfEven(3 * rPx));
    for (const [e0, e1] of lines) for (const e of [e0, e1]) {
      c.circle(zone, new c.Point(Math.trunc(roundHalfEven((e[0] - origin[0]) * PX)),
        Math.trunc(roundHalfEven((e[1] - origin[1]) * PX))), zr, new c.Scalar(1), -1);
    }
    const bd = base.data, sd = sm.data, zd = zone.data;
    for (let i = 0; i < bd.length; i++) if (zd[i]) bd[i] = sd[i];
    sm.delete(); zone.delete();
  }
  // OR the tool+clearance zone back in: where a line's end turns into
  // the rest of the pocket near a tool corner, the corner it makes would
  // otherwise shave the clearance there. The refit rounds that corner a
  // little further in, so grow the zone by whatever it shaved and redo.
  let extra = 0.02, fit = null, minSd = -Infinity;
  for (let round = 0; round < 4; round++) {
    const mask = base.clone();
    const md = mask.data, lim = (clearance + extra) * PX;
    for (let i = 0; i < md.length; i++) if (sdTool[i] <= lim) md[i] = 1;
    fit = refitMask(c, mask, origin);
    mask.delete();
    minSd = Infinity;
    for (const [x, y] of fit.pts) minSd = Math.min(minSd, probe(x, y));
    if (minSd >= clearance - 0.03) break;
    extra += clearance - minSd + 0.02;
  }
  base.delete();
  log(`straightened ${done} stretch(es) of pocket, refit dev ` +
      `${fit.dev.toFixed(3)} mm, min clearance ${minSd.toFixed(2)} mm`);
  return { tck: fit.tck, pts: fit.pts, warnings, lines, info };
}

/** Hand drags of the pocket itself ([[at, d], ...] in mm: the pocket
 *  point nearest `at` moves by d, DRAG_R of outline each side follows),
 *  then a tight refit. Strict containment (after this) still holds the
 *  clearance if a drag pulls the pocket into it. */
export function dragPocket(c, pocketPts, drags, log) {
  let poly = pocketPts;
  for (const [at, d] of drags) {
    poly = dragContour(poly, nearestIndex(poly, at), d, DRAG_R, false);
  }
  const margin = 3.0;
  const bb = bbox(poly);
  const origin = [bb.x0 - margin, bb.y0 - margin];
  const H = Math.trunc((bb.y1 - bb.y0 + 2 * margin) * PX) + 2;
  const W = Math.trunc((bb.x1 - bb.x0 + 2 * margin) * PX) + 2;
  const mask = fillMask(c, H, W, [poly], origin);
  const fit = refitMask(c, mask, origin);
  mask.delete();
  log(`pocket hand-edited (${drags.length} drag(s)), refit dev ${fit.dev.toFixed(3)} mm`);
  return { tck: fit.tck, pts: fit.pts };
}

/** strictContain post-pass: union the pocket with tool+clearance, refit. */
function containmentUnion(c, pocketPts, toolMm, clearance, log) {
  const { sdTool, origin, H, W, probe } =
    toolField(c, toolMm, pocketPts, clearance + 8.0);
  // worst intrusion of the pocket into the clearance zone
  let worst = Infinity;
  for (const [x, y] of pocketPts) {
    const v = probe(x, y);
    if (v < worst) worst = v;
  }
  if (worst >= clearance - 0.05) return null; // already contained
  // union raster: pocket polygon OR sd <= clearance
  const { mask: pm } = (() => {
    const m = c.Mat.zeros(H, W, c.CV_8UC1);
    const flat = new Int32Array(pocketPts.length * 2);
    pocketPts.forEach((p, i) => {
      flat[2 * i] = roundHalfEven((p[0] - origin[0]) * PX);
      flat[2 * i + 1] = roundHalfEven((p[1] - origin[1]) * PX);
    });
    const mat = c.matFromArray(pocketPts.length, 1, c.CV_32SC2, flat);
    const vec = new c.MatVector();
    vec.push_back(mat);
    c.fillPoly(m, vec, new c.Scalar(1));
    mat.delete(); vec.delete();
    return { mask: m };
  })();
  const u = new c.Mat(H, W, c.CV_8UC1);
  {
    const pd = pm.data, ud = u.data;
    for (let i = 0; i < ud.length; i++) {
      ud[i] = pd[i] || sdTool[i] <= clearance * PX ? 1 : 0;
    }
  }
  pm.delete();
  const sdU = sdf(c, u);
  u.delete();
  const cs = findContours(sdU, H, W, 0.0);
  let bestC = cs[0];
  for (const cc of cs) if (cc.length > bestC.length) bestC = cc;
  // marching squares emits either winding; every other path normalizes
  // to CCW and downstream normal-offset code (pocket entry flare)
  // depends on it — a CW refit here shipped bins with no pocket chamfer
  let poly = ccw(
    bestC.map(([r, col]) => [col / PX + origin[0], r / PX + origin[1]]));
  // light refit so the result is a spline again (tight cap, like scoops)
  const step = 0.2;
  const q = [];
  {
    const qq = [...poly, poly[0]];
    let s = 0;
    const svals = [0];
    for (let i = 1; i < qq.length; i++) {
      s += Math.hypot(qq[i][0] - qq[i - 1][0], qq[i][1] - qq[i - 1][1]);
      svals.push(s);
    }
    const m = Math.ceil(s / step);
    for (let i = 0; i < m; i++) {
      const t = i * step;
      let lo = 0, hi = svals.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (svals[mid] <= t) lo = mid; else hi = mid; }
      const f = (t - svals[lo]) / (svals[hi] - svals[lo] || 1);
      q.push([qq[lo][0] + f * (qq[hi][0] - qq[lo][0]),
              qq[lo][1] + f * (qq[hi][1] - qq[lo][1])]);
    }
  }
  const tree = new GridNN(q, 1.0);
  let tck = null, pts = null, dev = Infinity, minSd = -Infinity;
  for (const mult of [1, 0.3, 0.1, 0.03, 0.01, 0.003, 0.001, 0.0003, 0.0001]) {
    tck = periodicFit(q, LAM_BASE * mult, 1.25);
    pts = evalPeriodic(tck.tExt, tck.C, tck.k, 8000);
    dev = 0; minSd = Infinity;
    for (const [x, y] of pts) {
      const dd = tree.query(x, y).dist;
      if (dd > dev) dev = dd;
      const sv = probe(x, y);
      if (sv < minSd) minSd = sv;
    }
    // the refit itself must not reintroduce intrusion
    if (dev <= 0.15 && minSd >= clearance - 0.05) break;
  }
  // never hand back something worse than the pocket we were given
  if (minSd < worst) {
    log(`WARNING: strict containment refit went wrong (min clearance ` +
        `${minSd.toFixed(2)} mm vs ${worst.toFixed(2)} mm before); ` +
        `keeping the unfixed pocket`);
    return { failed: true };
  }
  log(`strict containment: pocket unioned with tool+clearance ` +
      `(was ${(clearance - worst).toFixed(2)} mm short), refit dev ` +
      `${dev.toFixed(3)} mm, min clearance ${minSd.toFixed(3)} mm`);
  return { tck, pts, minSd };
}

/** cheap content hash of a contour, so an injected (re-sent) contour
 *  hits the stage cache as well as the worker's own last contour */
function contourKey(cMm) {
  let h = 2166136261 >>> 0;
  const f = new Float64Array(1), u = new Uint32Array(f.buffer);
  for (const [x, y] of cMm) {
    for (const v of [x, y]) {
      f[0] = v;
      h = Math.imul(h ^ u[0], 16777619) >>> 0;
      h = Math.imul(h ^ u[1], 16777619) >>> 0;
    }
  }
  return `${cMm.length}:${h}`;
}

// Stage cache, last result per stage. A tweak re-runs only the stages
// whose inputs changed: thickness / depth / wall touch layout alone,
// scoop moves skip the smooth fit (the expensive part). Every stage
// is deterministic, so a hit returns exactly what a re-run would.
const stageCache = { src: null, base: null, cut: [] }; // cut: LRU, newest last
const CUT_KEEP = 4; // scoop suggestions probe a few variants per fit
export function clearProfileCache() {
  stageCache.src = null; stageCache.base = null; stageCache.cut = [];
}

/** hull / mirror the tool contour per params (cached: the quick preview
 *  and the full fit both start here) */
function sourceContour(c, cMm, params, log, timed) {
  const key = JSON.stringify([contourKey(cMm), !!params.max_contour,
    params.symmetric ?? true]);
  if (stageCache.src && stageCache.src.key === key) {
    for (const l of stageCache.src.logs) log(l);
    return stageCache.src.cSrc;
  }
  const logs = [];
  const slog = (l) => { logs.push(l); log(l); };
  let cSrc = cMm;
  if (params.max_contour) {
    cSrc = convexHull(cSrc);
    slog("max contour: convex hull of the tool outline");
  }
  if (params.symmetric ?? true) {
    cSrc = timed("symmetrize", () => symmetrizeContour(c, cSrc));
    slog("symmetric cutout: mirrored union across centerline");
  }
  stageCache.src = { key, cSrc, logs };
  return cSrc;
}

/** Fast approximate pocket (no spline fit, no scoops): the closed,
 *  clearance-grown outline the smooth fit approximates — shown while
 *  the real fit runs after a clearance / smoothness change. */
export function quickPocket(c, cMm, params) {
  const clearance = +(params.clearance ?? 1.0);
  const smoothR = +(params.smooth_r ?? 8.0);
  const t0 = performance.now();
  const cSrc = sourceContour(c, cMm, params, () => {}, (_, fn) => fn());
  const pts = smoothR > 0 ? closedOutline(c, cSrc, clearance, smoothR).cMm
    : clearance > 0 ? offsetContour(c, cSrc, clearance) : cSrc;
  const stride = Math.max(1, Math.ceil(pts.length / 2000));
  return { pocketPts: pts.filter((_, i) => i % stride === 0),
           ms: Math.round(performance.now() - t0) };
}

/** Finger scoops were "scallops" in the PoC (oracle params) and in STEP
 *  designs exported before 2026-10-08: map those keys to the scoop_*
 *  names, new names winning. */
const LEGACY_SCOOP_KEYS = { scallop_d: "scoop_d", scallop_blend: "scoop_blend",
                            scallop_mode: "scoop_mode", scallops: "scoops" };
export function legacyScoopParams(params) {
  const out = { ...params };
  for (const [o, n] of Object.entries(LEGACY_SCOOP_KEYS)) {
    if (o in out) {
      if (!(n in out)) out[n] = out[o];
      delete out[o];
    }
  }
  return out;
}

/** Port of server.profile_response (profile side only). */
export function profileResponse(c, cMm, params, log = () => {}) {
  params = legacyScoopParams(params);
  const clearance = +(params.clearance ?? 1.0);
  const smoothR = +(params.smooth_r ?? 8.0);
  const thickness = +(params.thickness ?? 25.0);
  const minWall = +(params.min_wall ?? 3.0);
  const scoopD = +(params.scoop_d ?? 25.0);
  const scoopBlend = +(params.scoop_blend ?? 4.0);
  const straightBlend = +(params.straight_blend ?? STRAIGHT_BLEND);
  const timings = {};
  const timed = (name, fn) => {
    const t0 = performance.now();
    const v = fn();
    timings[name] = Math.round(performance.now() - t0);
    return v;
  };

  const baseKey = JSON.stringify([contourKey(cMm), !!params.max_contour,
    params.symmetric ?? true, clearance, smoothR, !!params.flat_faithful]);
  let base = stageCache.base && stageCache.base.key === baseKey
    ? stageCache.base : null;
  const baseHit = !!base;
  if (base) {
    for (const l of base.logs) log(l);
  } else {
    const logs = [];
    const blog = (l) => { logs.push(l); log(l); };
    const cSrc = sourceContour(c, cMm, params, blog, timed);
    const prof = timed("fit", () => computeProfile(c, cSrc, clearance, smoothR,
      blog, params.flat_faithful ? 0.3 : Infinity));
    base = stageCache.base = { key: baseKey, prof, logs };
    stageCache.cut = [];
  }
  const prof = base.prof;
  // given spots (dragged, or saved in a STEP design from before modes)
  // are re-shaped to the mode, so a mirrored pair is always level
  const scoopMode = params.scoop_mode || "mirror";
  const scoops = params.scoops
    ? scoopsForMode(prof.fit, params.scoops, scoopMode) || []
    : autoScoops(prof.fit, scoopMode);

  // hand edits of the pocket (straight lines, drags); a symmetric pocket
  // mirrors them. straightSrc[k] = which of params.straights line k is.
  const sym = params.symmetric ?? true;
  const straights = [], straightSrc = [];
  (Array.isArray(params.straights) ? params.straights : []).forEach((s, i) => {
    for (const m of sym ? mirrorSpans([s]) : [s]) {
      straights.push(m); straightSrc.push(i);
    }
  });
  const drags = Array.isArray(params.pocket_drags) && params.pocket_drags.length
    ? (sym ? mirrorDrags(params.pocket_drags) : params.pocket_drags) : [];
  const cutKey = JSON.stringify([baseKey, scoops, scoopD, scoopBlend,
    !!params.strict_contain, straights, drags,
    straights.length ? straightBlend : null]);
  let cut = stageCache.cut.find((e) => e.key === cutKey) || null;
  const cutHit = !!cut;
  if (cut) { // refresh its LRU slot
    stageCache.cut.splice(stageCache.cut.indexOf(cut), 1);
    stageCache.cut.push(cut);
  }
  if (cut) {
    for (const l of cut.logs) log(l);
  } else {
    const logs = [];
    const clog = (l) => { logs.push(l); log(l); };
    let segs = prof.segs, periodic = prof.periodic, pts = prof.fit;
    const cutWarnings = [];
    let straightLines = [], straightInfo = [];
    if (straights.length) {
      const s = timed("straighten", () =>
        straightenPocket(c, pts, straights, cMm, clearance, clog,
          straightBlend));
      cutWarnings.push(...s.warnings);
      // tag each built line with the user's line it came from
      straightLines = s.lines.map(([e0, e1, k]) => [e0, e1, straightSrc[k]]);
      // per line the user drew: built (any copy), moved out how far
      straightInfo = params.straights.map(() =>
        ({ built: false, shift: -Infinity, minOff: -Infinity }));
      s.info.forEach((v, k) => {
        const u = straightInfo[straightSrc[k]];
        u.built = u.built || v.built;
        u.shift = Math.max(u.shift, v.shift);
        u.minOff = Math.max(u.minOff, v.minOff ?? -Infinity);
      });
      for (const u of straightInfo) { // no copy reached the build: plain 0
        if (!Number.isFinite(u.shift)) u.shift = 0;
        if (!Number.isFinite(u.minOff)) u.minOff = 0;
      }
      if (s.tck) { segs = [s.tck]; periodic = true; pts = s.pts; }
    }
    if (drags.length) {
      const s = timed("drag", () => dragPocket(c, pts, drags, clog));
      segs = [s.tck]; periodic = true; pts = s.pts;
    }
    if (scoopD > 0 && scoops.length) {
      const s = timed("scoops", () =>
        addScoops(c, pts, scoops, scoopD, scoopBlend, clog));
      segs = [s.tck]; periodic = true; pts = s.pts;
    }
    if (params.strict_contain) {
      const fixed = timed("contain", () =>
        containmentUnion(c, pts, cMm, clearance, clog));
      if (fixed && fixed.failed) {
        cutWarnings.push("containment fix-up failed -- lower scoop/clearance or re-scan");
      } else if (fixed) {
        segs = [fixed.tck]; periodic = true; pts = fixed.pts;
      }
    }
    cut = { key: cutKey, segs, periodic, pts, cutWarnings, straightLines,
            straightInfo, logs };
    stageCache.cut.push(cut);
    if (stageCache.cut.length > CUT_KEEP) stageCache.cut.shift();
  }
  let cutSegs = cut.segs, cutPeriodic = cut.periodic, pocketPts = cut.pts;
  const warnings = [...cut.cutWarnings];

  const L = layout(pocketPts, thickness, minWall, params.depth_mode || "flush");
  if ((prof.extra.minClearance ?? clearance) < clearance - 0.05 && !params.strict_contain) {
    warnings.push("containment not met -- lower smoothness or clearance");
  }
  // puzzle-piece bin: which cells the pocket doesn't need (offered only
  // when that's at least one; `on` = asked for AND it saves cells)
  const pz = puzzleCells(pocketPts, L.nx, L.ny, L.bboxC, minWall);
  const puzzle = { keep: pz.keep, drop: pz.drop, total: L.nx * L.ny,
    on: !!params.puzzle && pz.drop > 0,
    outline: pz.drop > 0 ? puzzleOutline(pz.kept, L.nx, L.ny, L.bboxC) : null };
  return {
    segs: cutSegs, periodic: cutPeriodic, fit: prof.fit, pocketPts,
    layout: { nx: L.nx, ny: L.ny, nz: L.nz, H: L.H, depth: L.depth },
    center: L.bboxC, scoops, warnings, straightLines: cut.straightLines,
    straightInfo: cut.straightInfo, puzzle,
    depthChoice: { mode: L.mode, options: L.options },
    timings, cached: { base: baseHit, cut: cutHit },
  };
}

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
  periodicFit, rasterize, sdf, fillMask, bbox, ccw, PX, LAM_BASE,
} from "./smoothprof.js";
import { evalPeriodic } from "./bspline.js";
import { resample, detectCorners, fitProfile, sampleSegs } from "./profilefit.js";
import { roundHalfEven, GridNN } from "./nummath.js";
import { findContours } from "./marching.js";

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

/** strictContain post-pass: union the pocket with tool+clearance, refit. */
function containmentUnion(c, pocketPts, toolMm, clearance, log) {
  const margin = clearance + 8.0;
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
  // worst intrusion of the pocket into the clearance zone
  let worst = Infinity;
  const probe = (x, y) => {
    const r = (y - origin[1]) * PX, cc = (x - origin[0]) * PX;
    const r0 = Math.max(0, Math.min(H - 2, Math.floor(r)));
    const c0 = Math.max(0, Math.min(W - 2, Math.floor(cc)));
    const fr = r - r0, fc = cc - c0;
    const i00 = r0 * W + c0;
    return (sdTool[i00] * (1 - fr) * (1 - fc) + sdTool[i00 + 1] * (1 - fr) * fc +
            sdTool[i00 + W] * fr * (1 - fc) + sdTool[i00 + W + 1] * fr * fc) / PX;
  };
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

  const cutKey = JSON.stringify([baseKey, scoops, scoopD, scoopBlend,
    !!params.strict_contain]);
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
    if (scoopD > 0 && scoops.length) {
      const s = timed("scoops", () =>
        addScoops(c, prof.fit, scoops, scoopD, scoopBlend, clog));
      segs = [s.tck]; periodic = true; pts = s.pts;
    }
    const cutWarnings = [];
    if (params.strict_contain) {
      const fixed = timed("contain", () =>
        containmentUnion(c, pts, cMm, clearance, clog));
      if (fixed && fixed.failed) {
        cutWarnings.push("containment fix-up failed -- lower scoop/clearance or re-scan");
      } else if (fixed) {
        segs = [fixed.tck]; periodic = true; pts = fixed.pts;
      }
    }
    cut = { key: cutKey, segs, periodic, pts, cutWarnings, logs };
    stageCache.cut.push(cut);
    if (stageCache.cut.length > CUT_KEEP) stageCache.cut.shift();
  }
  let cutSegs = cut.segs, cutPeriodic = cut.periodic, pocketPts = cut.pts;
  const warnings = [...cut.cutWarnings];

  const L = layout(pocketPts, thickness, minWall, params.depth_mode || "flush");
  if ((prof.extra.minClearance ?? clearance) < clearance - 0.05 && !params.strict_contain) {
    warnings.push("containment not met -- lower smoothness or clearance");
  }
  return {
    segs: cutSegs, periodic: cutPeriodic, fit: prof.fit, pocketPts,
    layout: { nx: L.nx, ny: L.ny, nz: L.nz, H: L.H, depth: L.depth },
    center: L.bboxC, scoops, warnings,
    depthChoice: { mode: L.mode, options: L.options },
    timings, cached: { base: baseHit, cut: cutHit },
  };
}

// Hand edits of the outline: dragging the tool outline (cosine falloff,
// mirrored when symmetric), straightened stretches of pocket (worker
// post-pass), and the UI flow incl. undo and the STEP round trip.
import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  DRAG_R, dragContour, nearestIndex, mirrorSpans, shorterArc, chordReplace,
  snapAngle, rayHit, mirrorDrags, applyToolDrags, segDist, bowSpan, hullBridge,
} from "../src/outlineedit.js";

/** w x h rectangle centred on the origin, ~0.1 mm spacing, CCW */
function rect(w, h, step = 0.1) {
  const c = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const pts = [];
  for (let e = 0; e < 4; e++) {
    const [a, b] = [c[e], c[(e + 1) % 4]];
    const n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let i = 0; i < n; i++) {
      pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    }
  }
  return pts;
}
const moved = (a, b) => a.filter((p, i) =>
  Math.hypot(p[0] - b[i][0], p[1] - b[i][1]) > 1e-9).length;

test("drag: grabbed point moves fully, falloff ends at DRAG_R, wraps index 0", () => {
  const pts = rect(100, 40);
  const out = dragContour(pts, 0, [0, -3]); // corner at index 0
  expect(out[0]).toEqual([pts[0][0], pts[0][1] - 3]);
  // ~DRAG_R of outline each side follows (0.1 mm spacing), across the wrap
  const n = moved(out, pts);
  expect(n).toBeGreaterThan(2 * (DRAG_R / 0.1) - 4);
  expect(n).toBeLessThan(2 * (DRAG_R / 0.1) + 2);
  expect(out[pts.length - 1][1]).toBeLessThan(pts[pts.length - 1][1]); // wrapped
  expect(out[pts.length / 2]).toEqual(pts[pts.length / 2]); // far side untouched
  expect(pts[0]).toEqual([-50, -20]); // input not mutated
});

test("drag: mirrored edit moves the x-mirror spot by (-dx, dy); not on the axis", () => {
  const pts = rect(100, 40);
  const i = nearestIndex(pts, [-30, -20]);
  const out = dragContour(pts, i, [-1, -2], DRAG_R, true);
  const j = nearestIndex(pts, [30, -20]);
  expect(out[j][0]).toBeCloseTo(pts[j][0] + 1, 9);
  expect(out[j][1]).toBeCloseTo(pts[j][1] - 2, 9);
  // a grab on the axis is its own mirror: moved once, not twice
  const k = nearestIndex(pts, [0, -20]);
  const once = dragContour(pts, k, [0, -2], DRAG_R, true);
  expect(once[k][1]).toBeCloseTo(-22, 9);
});

test("spans: mirrored unless self-mirrored or crossing the axis; arcs", () => {
  expect(mirrorSpans([[[-40, -21], [-10, -21]]])).toEqual([
    [[-40, -21], [-10, -21]], [[40, -21], [10, -21]]]);
  expect(mirrorSpans([[[-40, -21], [10, -21]]]).length).toBe(1); // crosses
  expect(mirrorSpans([[[-0.5, -21], [0.5, -25]]]).length).toBe(1);
  const pts = rect(100, 40);
  const a = nearestIndex(pts, [-40, -20]), b = nearestIndex(pts, [40, -20]);
  expect(shorterArc(pts, a, b).len).toBeCloseTo(80, 6);
  expect(shorterArc(pts, b, a).len).toBeCloseTo(80, 6);
  const cut = chordReplace(pts, [-40, -20], [40, -20]);
  expect(cut.length).toBe(pts.length - 799);
});

test("shift snap: nearest 45° ray, dir folded to [0, 180), mirrored dirs", () => {
  const near = (s, t) => { expect(s.target[0]).toBeCloseTo(t[0], 9);
                           expect(s.target[1]).toBeCloseTo(t[1], 9); };
  let s = snapAngle([0, 0], [10, 1.5]);     // ~8.5° -> horizontal
  expect(s.dir).toBe(0); near(s, [10, 0]);
  s = snapAngle([0, 0], [-10, -1]);         // ~186° -> horizontal, folded
  expect(s.dir).toBe(0); near(s, [-10, 0]);
  s = snapAngle([0, 0], [1, 9]);            // ~84° -> vertical
  expect(s.dir).toBe(90); near(s, [0, 9]);
  s = snapAngle([0, 0], [6, 5]);            // ~40° -> 45
  expect(s.dir).toBe(45); near(s, [5.5, 5.5]);
  s = snapAngle([0, 0], [6, -5]);           // ~-40° -> 135 folded
  expect(s.dir).toBe(135);
  // mirroring flips the angle: 45 <-> 135, 0 and 90 stay
  expect(mirrorSpans([[[-40, -21], [-10, -5], 45]])[1][2]).toBe(135);
  expect(mirrorSpans([[[-40, -21], [-10, -21], 0]])[1][2]).toBe(0);
  expect(mirrorSpans([[[-40, -21], [-40, 5], 90]])[1][2]).toBe(90);
});

test("rayHit puts a held-angle end ON the outline; mirrorDrags", () => {
  const pts = rect(100, 40);
  // from the bottom edge, straight up: meets the top edge
  const hit = rayHit(pts, [-30, -20], 90, [-28, 22]);
  expect(hit[0]).toBeCloseTo(-30, 6);
  expect(hit[1]).toBeCloseTo(20, 6);
  // horizontal from the bottom edge runs along it: the side walls are
  // the crossings; the one nearest the pointer wins
  const h = rayHit(pts, [-30, -20], 0, [45, -18]);
  expect(h[0]).toBeCloseTo(50, 6);
  expect(mirrorDrags([[[-30, -21], [1, -5]]])).toEqual([
    [[-30, -21], [1, -5]], [[30, -21], [-1, -5]]]);
  expect(mirrorDrags([[[2, -21], [1, -5]]]).length).toBe(1); // on the axis
});

test("bowSpan: one click finds the whole bow between two corners", () => {
  // the owner's case: a bottom that sags up between two corners
  const pts = rect(100, 40).map(([x, y]) =>
    [x, y < -19.99 ? y + 3 * (1 - (x / 50) ** 2) : y]);
  const [a, b] = bowSpan(pts, nearestIndex(pts, [0, -17]));
  const [l, r] = a[0] < b[0] ? [a, b] : [b, a];
  // reaches (almost) both corners, never up the side walls
  expect(l[0]).toBeLessThan(-46);
  expect(r[0]).toBeGreaterThan(46);
  expect(Math.max(l[1], r[1])).toBeLessThan(-18);
  // clicked off-centre: the same bow
  const [c, d] = bowSpan(pts, nearestIndex(pts, [30, -18]));
  expect(Math.min(c[0], d[0])).toBeLessThan(-46);
  expect(Math.max(c[0], d[0])).toBeGreaterThan(46);
  // a side wall is its own straight stretch: it stops at the corners
  const [e, f] = bowSpan(pts, nearestIndex(pts, [50, 0]));
  expect(Math.abs(e[0] - 50)).toBeLessThan(0.01);
  expect(Math.abs(f[0] - 50)).toBeLessThan(0.01);
  expect(Math.abs(e[1] - f[1])).toBeGreaterThan(34);
});

test("tool drags re-apply from the detected outline; any one can come out", () => {
  const pts = rect(100, 40);
  const a = { at: [-30, -20], d: [0, -3], mirror: false };
  const b = { at: [20, 20], d: [0, 2], mirror: true };
  const both = applyToolDrags(pts, [a, b]);
  // the same as dragging one after the other
  const seq = dragContour(dragContour(pts, nearestIndex(pts, a.at), a.d),
    nearestIndex(dragContour(pts, nearestIndex(pts, a.at), a.d), b.at), b.d,
    DRAG_R, true);
  expect(both).toEqual(seq);
  // taking out the first leaves exactly the second's effect
  const onlyB = applyToolDrags(pts, [b]);
  expect(onlyB[nearestIndex(pts, [-30, -20])]).toEqual([-30, -20]);
  expect(onlyB[nearestIndex(pts, [-20, 20])][1]).toBeCloseTo(22, 9); // mirrored
  expect(applyToolDrags(pts, [])).toBe(pts);
  expect(segDist([0, 5], [-10, 0], [10, 0])).toBeCloseTo(5, 12);
  expect(segDist([15, 0], [-10, 0], [10, 0])).toBeCloseTo(5, 12);
  // a moved line keeps its offset through mirroring
  expect(mirrorSpans([[[-40, -21], [-10, -21], null, 2.5]])[1]).toEqual(
    [[40, -21], [10, -21], null, 2.5]);
});

// ---- worker + UI ------------------------------------------------------------
const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "snips-closed.jpg");

/** straightness of pocket points in a window: max distance from their
 *  least-squares line */
const lineDev = (pts) => {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my);
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // principal direction
  const nx = -Math.sin(th), ny = Math.cos(th);
  return Math.max(...pts.map(([x, y]) => Math.abs((x - mx) * nx + (y - my) * ny)));
};

test("straighten: a bowed stretch of pocket turns into a straight line, clear of the tool", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__selftest.cv &&
    window.__selftest.cv.ok), { timeout: 120000 }).toBe(true);
  // a straight-sided tool: the smoothed pocket still flares out toward
  // the rounded corners (the owner's "bowed" pocket)
  const tool = rect(100, 40, 0.25);
  const base = { clearance: 1, smooth_r: 8, scoop_d: 0, symmetric: false,
                 strict_contain: true, thickness: 20 };
  const bowed = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, base]);
  const bottom = (r) => r.pocketPts.filter(([x, y]) => y < -15 && Math.abs(x) < 38);
  expect(lineDev(bottom(bowed))).toBeGreaterThan(0.4);
  // straighten from near one end of the bottom to the other
  const pick = (x) => bowed.pocketPts[nearestIndex(bowed.pocketPts, [x, -30])];
  const r = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[pick(-42), pick(42)]] }]);
  expect(r.ok).toBe(true);
  expect(r.logs.some((l) => l.startsWith("straightened 1"))).toBe(true);
  expect(lineDev(bottom(r))).toBeLessThan(0.2);
  // tangent (owner): it rests on the stretch's outermost points (here the
  // flared ends at x = ±42) — the dip in between is bridged, not cut
  const tangentY = Math.min(...bowed.pocketPts
    .filter(([x, y]) => y < -15 && Math.abs(x) <= 42.5).map((p) => p[1]));
  for (const [, y] of bottom(r)) expect(Math.abs(y - tangentY)).toBeLessThan(0.2);
  expect(r.warnings).toEqual([]);
  // a dragged line (offset 2 mm out): still straight, 2 mm further out
  const moved = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[pick(-42), pick(42), null, 2]] }]);
  expect(lineDev(bottom(moved))).toBeLessThan(0.2);
  for (const [, y] of bottom(moved)) expect(Math.abs(y - (tangentY - 2))).toBeLessThan(0.2);
  // dragged IN as far as it goes: it stops snug at the clearance (1 mm
  // below the tool's -20 edge); the limit is reported for the UI clamp
  expect(r.straightInfo[0].minOff).toBeLessThan(-1);
  const snug = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[pick(-42), pick(42), null, -10]] }]);
  expect(lineDev(bottom(snug))).toBeLessThan(0.2);
  for (const [, y] of bottom(snug)) expect(Math.abs(y + 21)).toBeLessThan(0.2);
  expect(snug.warnings).toEqual([]);
  expect(moved.straightLines[0][2]).toBe(0); // tagged with its user line
  // where it meets the rest of the pocket it's filleted, not kinked:
  // sharpest turn per 0.5 mm near the line's ends: dragged 3 mm out past the
  // tangent it's 32° with no fillet, 8.6° with the 4 mm one (measured)
  const turn = (res) => {
    const q = [res.pocketPts[0]];
    for (const p of res.pocketPts) {
      const l = q[q.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) >= 0.5) q.push(p);
    }
    const ends = res.straightLines.flatMap((s) => [s[0], s[1]]);
    let worst = 0;
    q.forEach((b, i) => {
      if (!ends.some((e) => Math.hypot(e[0] - b[0], e[1] - b[1]) < 8)) return;
      const a = q[(i - 1 + q.length) % q.length], c = q[(i + 1) % q.length];
      let d = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) -
                       Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI;
      if (d > 180) d = 360 - d;
      worst = Math.max(worst, d);
    });
    return worst;
  };
  const moved3 = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[pick(-42), pick(42), null, 3]] }]);
  expect(turn(moved3)).toBeLessThan(12);
  // the owner's slider (straight_blend): a bigger blend, a gentler corner
  const blendAt = (mm) => page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straight_blend: mm, straights: [[pick(-42), pick(42), null, 3]] }]);
  const sharp = turn(await blendAt(1)), soft = turn(await blendAt(8));
  expect(soft).toBeLessThan(sharp);
  expect(moved3.logs.join(" ")).toMatch(/min clearance (0\.9[7-9]|[1-9]\.\d\d) mm/);
  // no foot: past the line's ends nothing pokes out beyond it
  const ends = r.pocketPts.filter(([x, y]) => y < -15 && Math.abs(x) >= 38 &&
    Math.abs(x) < 46);
  for (const [, y] of ends) expect(y).toBeGreaterThan(tangentY - 0.2);
  // the preview draws the line as built: level, on the tangent
  expect(r.straightLines.length).toBe(1);
  const [[lx0, ly0], [lx1, ly1]] = r.straightLines[0];
  expect(Math.abs(ly0 - tangentY)).toBeLessThan(0.1);
  expect(Math.abs(ly1 - tangentY)).toBeLessThan(0.1);
  expect(Math.abs(lx1 - lx0)).toBeGreaterThan(80);
  // shift-snapped: two ends at different heights, held horizontal anyway
  const tilted = [pick(-42), bowed.pocketPts[nearestIndex(bowed.pocketPts, [30, -30])]];
  expect(Math.abs(tilted[0][1] - tilted[1][1])).toBeGreaterThan(0.5);
  const free = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [tilted] }]);
  const held = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[...tilted, 0]] }]);
  const mid = (r) => r.pocketPts.filter(([x, y]) => y < -15 && Math.abs(x + 6) < 30);
  const slope = (pts) => {
    const a = pts.reduce((m, p) => (p[0] < m[0] ? p : m));
    const b = pts.reduce((m, p) => (p[0] > m[0] ? p : m));
    return (b[1] - a[1]) / (b[0] - a[0]);
  };
  expect(Math.abs(slope(mid(free)))).toBeGreaterThan(0.01);
  expect(Math.abs(slope(mid(held)))).toBeLessThan(0.003);
  // level, resting on the lower (outer) end: the tangent at that angle
  for (const [, y] of mid(held)) expect(Math.abs(y - tilted[0][1])).toBeLessThan(0.25);
  // a convex side: the tangent rests on the bulge's tip (outside the
  // tool + clearance), flat across; measured away from the ends' fillets
  const convex = tool.map(([x, y]) => [x, y < 0 ? y - 3 * (1 - (x / 50) ** 2) : y]);
  const rc = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [convex, { ...base, straights: [[pick(-40), pick(40)]] }]);
  const middle = (res) => res.pocketPts.filter(([x, y]) => y < -15 && Math.abs(x) < 25);
  expect(lineDev(middle(rc))).toBeLessThan(0.2);
  for (const [, y] of bottom(rc)) expect(y).toBeLessThan(-23 - 0.9 + 0.2);
  // a stretch around the tool's corner: the tangent rests OUTSIDE it
  // (its chord would cut the corner; the tangent never does), built,
  // nothing pushed it, and the clearance holds
  const cut = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[[-52, -10], [-40, -24]]] }]);
  expect(cut.warnings).toEqual([]);
  expect(cut.straightInfo[0].built).toBe(true);
  expect(cut.straightInfo[0].shift).toBeLessThan(0.3);
  expect(cut.logs.join(" ")).toMatch(/min clearance (0\.9[7-9]|[1-9]\.\d\d) mm/);
  // ends across the middle of the tool: the stretch between them is half
  // the pocket, and its tangent is that side's outermost edge — outside
  // the tool, so it's built (no "cut through the tool" case any more)
  const thru = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, straights: [[[-51, 0], [51, 0]]] }]);
  expect(thru.straightInfo[0].built).toBe(true);
  expect(thru.warnings).toEqual([]);
  // symmetric: one span straightens both sides
  const sym = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, symmetric: true, straights: [[pick(-45), pick(-5)]] }]);
  expect(sym.logs.some((l) => l.startsWith("straightened 2"))).toBe(true);
  expect(sym.straightInfo.length).toBe(1); // one line drawn, two built
  expect(sym.straightLines.length).toBe(2);
});

/** outline of two overlapping discs (the owner's snips handles: two
 *  lobes, the pocket dipping in between them) */
function lobes(c1, r1, c2, r2, n = 1440) {
  const mid = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
  const pts = [];
  for (const [c, r, o] of [[c1, r1, [c2, r2]], [c2, r2, [c1, r1]]]) {
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / n, p = [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)];
      if (Math.hypot(p[0] - o[0][0], p[1] - o[0][1]) > o[1]) pts.push(p);
    }
  }
  return pts.sort((p, q) => Math.atan2(p[1] - mid[1], p[0] - mid[0]) -
                            Math.atan2(q[1] - mid[1], q[0] - mid[0]));
}

test("straighten = the tangent across a dip: rests on both lobes, no foot, symmetric", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__selftest.cv &&
    window.__selftest.cv.ok), { timeout: 120000 }).toBe(true);
  const base = { clearance: 1, smooth_r: 8, scoop_d: 0, symmetric: false,
                 strict_contain: true, thickness: 20 };
  for (const [name, tool] of [
    ["equal lobes", lobes([-22, 0], 24, [22, 0], 24)],
    ["unequal lobes", lobes([-22, 2], 22, [24, 0], 26)],
  ]) {
    const plain = await page.evaluate(([c, p]) => window.__profileRun(c, p), [tool, base]);
    const P = plain.pocketPts;
    // one click on the dip (its highest bottom point near x = 0), level
    const dip = P.filter(([x, y]) => Math.abs(x) < 3 && y < 0)
      .reduce((m, p) => (p[1] > m[1] ? p : m));
    const [a, b] = hullBridge(P, nearestIndex(P, dip)); // as a click does
    const r = await page.evaluate(([c, p]) => window.__profileRun(c, p),
      [tool, { ...base, straights: [[a, b, 0]] }]);
    expect(r.straightInfo[0].built, name).toBe(true);
    const [e0, e1] = r.straightLines[0];
    const lineY = (e0[1] + e1[1]) / 2;
    expect(Math.abs(e0[1] - e1[1]), name).toBeLessThan(0.05); // level
    // tangent: it rests on the lobes' lowest points (no cut into them)
    const low = Math.min(...P.map((p) => p[1]));
    expect(Math.abs(lineY - low), name).toBeLessThan(0.2);
    // no foot: nothing in the new pocket pokes out past the line (0.3 =
    // the refit's own wiggle, dev <= ~0.19)
    expect(Math.min(...r.pocketPts.map((p) => p[1])), name).toBeGreaterThan(lineY - 0.3);
    // and the dip is bridged: the bottom at x = 0 is on the line now
    const at0 = r.pocketPts.filter(([x, y]) => Math.abs(x) < 1 && y < 0)
      .reduce((m, p) => (p[1] < m[1] ? p : m));
    expect(Math.abs(at0[1] - lineY), name).toBeLessThan(0.25);
    if (name === "equal lobes") { // symmetric tool, symmetric line
      expect(Math.abs(e0[0] + e1[0]), name).toBeLessThan(0.6);
    }
  }
});

test("pocket drags: the pocket moves on its own, mirrored when symmetric", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__selftest.cv &&
    window.__selftest.cv.ok), { timeout: 120000 }).toBe(true);
  const tool = rect(100, 40, 0.25);
  const base = { clearance: 1, smooth_r: 8, scoop_d: 0, symmetric: false,
                 strict_contain: true, thickness: 20 };
  const plain = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, base]);
  const yAt = (r, x) => r.pocketPts.filter(([, y]) => y < 0)
    .reduce((m, p) => (Math.abs(p[0] - x) < Math.abs(m[0] - x) ? p : m))[1];
  const at = (x) => plain.pocketPts[nearestIndex(plain.pocketPts, [x, -30])];
  // pull the bottom out 5 mm at x = -30
  const one = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, pocket_drags: [[at(-30), [0, -5]]] }]);
  expect(yAt(one, -30) - yAt(plain, -30)).toBeLessThan(-4.5);
  expect(Math.abs(yAt(one, 0) - yAt(plain, 0))).toBeLessThan(0.2); // > DRAG_R away
  expect(Math.abs(yAt(one, 30) - yAt(plain, 30))).toBeLessThan(0.2);
  expect(one.logs.join(" ")).toContain("pocket hand-edited");
  // the tool outline is untouched by a pocket edit
  expect(one.fit).toEqual(plain.fit);
  // symmetric: the x-mirror spot moves too
  const sym = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, symmetric: true, pocket_drags: [[at(-30), [0, -5]]] }]);
  expect(yAt(sym, 30) - yAt(plain, 30)).toBeLessThan(-4.5);
  // pulled INTO the clearance: guarantee clearance pushes it back out
  const inward = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, pocket_drags: [[at(-30), [0, 3]]] }]);
  expect(yAt(inward, -30)).toBeLessThan(-20.9);
});

test("UI: drag the outline on the photo (mirrored), undo, straighten the pocket, STEP round trip", async ({ page }, info) => {
  test.setTimeout(600000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "25");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  const orig = await page.evaluate(() => window.__contour.contourMm);
  // a fit newer than the one on screen at mark() time
  const mark = () => page.evaluate(() => { window.__prev = window.__profile; });
  const refit = () => expect.poll(() => page.evaluate(() =>
    window.__profile !== window.__prev && !!window.__profile.ok),
    { timeout: 120000 }).toBe(true);
  const width = (c) => Math.max(...c.map((p) => p[0])) - Math.min(...c.map((p) => p[0]));

  // the photo <-> mm transform inverts the pipeline's own: every mm
  // outline point maps back onto a detected-outline pixel, and back again
  const frame = await page.evaluate(() => {
    const fr = window.__warpFrame(), c = window.__contour;
    let worstPx = 0, worstMm = 0;
    for (let i = 0; i < c.contourMm.length; i += 7) {
      const p = c.contourMm[i], q = fr.toPx(p);
      let best = Infinity;
      for (const r of c.contourPx) best = Math.min(best, Math.hypot(r[0] - q[0], r[1] - q[1]));
      worstPx = Math.max(worstPx, best);
      const b = fr.toMm(q);
      worstMm = Math.max(worstMm, Math.hypot(b[0] - p[0], b[1] - p[1]));
    }
    return { worstPx, worstMm };
  });
  expect(frame.worstPx).toBeLessThan(1e-6);
  expect(frame.worstMm).toBeLessThan(1e-9);

  // the pocket preview has no outline editing; the photo pane does
  await expect(page.locator("#pane-profile #ed-drag")).toHaveCount(0);
  await expect(page.locator("#pane-warp #ed-drag")).toBeEnabled();

  // mm -> page coordinates on the photo / on the pocket preview
  const onPhoto = async (mm) => page.evaluate((p) => {
    const fr = window.__warpFrame(), b = window.__photoBox();
    const [u, v] = fr.toPx(p);
    return [b.left + u * fr.s / b.k, b.top + v * fr.s / b.k];
  }, mm);
  const onPocket = async (mm) => page.evaluate(([x, y]) => {
    const v = window.__profView, cnv = document.getElementById("profile-view");
    const r = cnv.getBoundingClientRect(), k = v.Wc / r.width;
    return [r.left + ((x - v.cx) * v.s + v.Wc / 2) / k,
            r.top + (v.Hc / 2 - (y - v.cy) * v.s) / k];
  }, mm);

  await page.click("#ed-drag");
  await expect(page.locator("#ed-hint-photo")).toBeVisible();
  // mouse events only land on the part of the canvas inside the viewport
  await page.locator("#warp-preview").scrollIntoViewIfNeeded();
  // grab the leftmost outline point, pull it 4 mm further left (in mm:
  // on the photo that's whatever direction the tool lies)
  const left = orig.reduce((m, p) => (p[0] < m[0] ? p : m));
  const [sx, sy] = await onPhoto(left);
  const [ex, ey] = await onPhoto([left[0] - 4, left[1]]);
  const drag = async () => {
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 3 });
    await page.mouse.move(ex, ey, { steps: 3 });
    await page.mouse.up();
  };
  await mark();
  await drag();
  await expect.poll(() => page.evaluate(() => !!window.__contour.edited)).toBe(true);
  await refit();
  // "mirror edits" is off by default (asymmetric tools): one side, ~4 mm
  const oneSide = await page.evaluate(() => window.__contour.contourMm);
  expect(width(oneSide) - width(orig)).toBeGreaterThan(3);
  expect(width(oneSide) - width(orig)).toBeLessThan(5);
  await expect(page.locator("#bin-stale")).toBeVisible();
  await expect(page.locator("#ed-undo-photo")).toBeEnabled();
  await expect(page.locator("#ed-undo")).toBeEnabled(); // one shared history

  await mark();
  await page.click("#ed-undo-photo");
  await refit();
  expect(await page.evaluate(() => window.__contour.contourMm)).toEqual(orig);

  // with "mirror edits" on, the other side follows: both out ~4 mm
  await page.check("#ed-mirror");
  await mark();
  await drag();
  await refit();
  const mirrored = await page.evaluate(() => window.__contour.contourMm);
  expect(width(mirrored) - width(orig)).toBeGreaterThan(7);
  expect(width(mirrored) - width(orig)).toBeLessThan(9);

  // a second drag (the top, up 3 mm), then take out ONLY the first: the
  // width goes back, the top stays raised
  const top = orig.reduce((m, p) => (p[1] > m[1] ? p : m));
  const [tx0, ty0] = await onPhoto(top);
  const [tx1, ty1] = await onPhoto([top[0], top[1] + 3]);
  await mark();
  await page.mouse.move(tx0, ty0);
  await page.mouse.down();
  await page.mouse.move(tx1, ty1, { steps: 4 });
  await page.mouse.up();
  await refit();
  expect((await page.evaluate(() => window.__edits().toolDrags)).length).toBe(2);
  const first = (await page.evaluate(() => window.__edits().toolDrags))[0];
  const [hx, hy] = await onPhoto([first.at[0] + first.d[0], first.at[1] + first.d[1]]);
  await page.mouse.click(hx, hy); // select its handle
  await expect(page.locator("#ed-del-photo")).toBeEnabled();
  await mark();
  await page.keyboard.press("Delete");
  await refit();
  expect((await page.evaluate(() => window.__edits().toolDrags)).length).toBe(1);
  const edited = await page.evaluate(() => window.__contour.contourMm);
  expect(Math.abs(width(edited) - width(orig))).toBeLessThan(0.3);
  const topY = (c) => Math.max(...c.map((p) => p[1]));
  expect(topY(edited) - topY(orig)).toBeGreaterThan(2.5);
  // then straighten a stretch of pocket with two clicks
  await page.click("#ed-straight");
  await page.locator("#profile-view").scrollIntoViewIfNeeded();
  const pocket = await page.evaluate(() => window.__profile.pocketPts);
  // two points on the pocket's lower-left, 15 mm apart vertically
  const ys = pocket.map((p) => p[1]);
  const y0 = Math.min(...ys) + 0.3 * (Math.max(...ys) - Math.min(...ys));
  const onLeft = (y) => pocket.filter((p) => p[0] < 0)
    .reduce((m, p) => (Math.abs(p[1] - y) < Math.abs(m[1] - y) ? p : m));
  const straightsLen = () => expect.poll(() => page.evaluate(() =>
    window.__profile && window.__profile.ok && window.__profile.params &&
    (window.__profile.params.straights || []).length), { timeout: 120000 });
  // ONE click on the pocket's bottom straightens the curve around it,
  // held level with Shift (here the pocket dips between the handles, so
  // it's the short arch; the bridged-bow case is the bowSpan unit test)
  const bottomMid = pocket.filter((p) => Math.abs(p[0]) < 3)
    .reduce((m, p) => (p[1] < m[1] ? p : m));
  const [cx0, cy0] = await onPocket(bottomMid);
  await page.mouse.move(cx0 + 2, cy0 + 2); // hover: a dashed preview
  await page.mouse.move(cx0, cy0);
  await page.keyboard.down("Shift");
  await page.mouse.click(cx0, cy0);
  await page.keyboard.up("Shift");
  await straightsLen().toBe(1);
  const auto = await page.evaluate(() => window.__profile.params.straights[0]);
  expect(auto[2]).toBe(0); // level
  expect(Math.hypot(auto[1][0] - auto[0][0], auto[1][1] - auto[0][1]))
    .toBeGreaterThan(5); // a real span, found from one click
  await mark();
  await page.keyboard.press("ControlOrMeta+z");
  await refit();
  await straightsLen().toBe(0);
  expect(await page.evaluate(() => !!window.__contour.edited)).toBe(true);

  // a plain click (no Shift) on the left side: its bow, free angle, kept
  // for the STEP round trip
  const pa = onLeft(y0);
  const [ax, ay] = await onPocket(pa);
  await expect(page.locator("#blend-row")).toBeHidden(); // no line yet
  await page.mouse.click(ax, ay);
  await straightsLen().toBe(1);
  expect(await page.evaluate(() => window.__profile.params.straights[0].length))
    .toBe(2);
  // with a line, the straight edge blend slider shows; it drives the fit
  await expect(page.locator("#blend-row")).toBeVisible();
  await mark();
  await page.locator("#sl-blend").fill("7");
  await refit();
  expect(await page.evaluate(() => window.__profile.params.straight_blend)).toBe(7);
  // the slider row appearing shifted the layout: bring the preview back
  await page.locator("#profile-view").scrollIntoViewIfNeeded();

  // drag the yellow line 3 mm outward: it moves parallel, stored as an
  // offset on that line
  const { line, n } = await page.evaluate(() => {
    const r = window.__profile;
    const l = r.straightLines.find((s) => s[2] === 0 && s[0][0] + s[1][0] < 0);
    const [a, b] = l, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L, bulk = 0;
    for (const p of r.pocketPts) bulk += (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
    return { line: l, n: bulk > 0 ? [-nx, -ny] : [nx, ny] };
  });
  const lm = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  const [lx0, ly0] = await onPocket(lm);
  const [lx1, ly1] = await onPocket([lm[0] + 3 * n[0], lm[1] + 3 * n[1]]);
  await mark();
  await page.mouse.move(lx0, ly0);
  await page.mouse.down();
  await page.mouse.move(lx1, ly1, { steps: 4 });
  await page.mouse.up();
  await refit();
  const off = await page.evaluate(() => window.__profile.params.straights[0][3]);
  expect(off).toBeGreaterThan(2.5);
  expect(off).toBeLessThan(3.5);

  // Edit pocket: drag the pocket itself (Straighten switches off); the
  // tool outline stays as it was
  await page.click("#ed-pocket");
  await expect(page.locator("#ed-straight")).toHaveAttribute("aria-pressed", "false");
  const pocket2 = await page.evaluate(() => window.__profile.pocketPts);
  const onRight = pocket2.filter((p) => p[0] > 0)
    .reduce((m, p) => (Math.abs(p[1] - (y0 + 30)) < Math.abs(m[1] - (y0 + 30)) ? p : m)); // clear of the (mirrored) line
  const [rx, ry] = await onPocket(onRight);
  const [rx2] = await onPocket([onRight[0] + 3, onRight[1]]);
  const toolBefore = await page.evaluate(() => window.__contour.contourMm);
  await mark();
  await page.mouse.move(rx, ry);
  await page.mouse.down();
  await page.mouse.move(rx2, ry, { steps: 4 });
  await page.mouse.up();
  await refit();
  expect(await page.evaluate(() => window.__profile.params.pocket_drags.length))
    .toBe(1);
  expect(await page.evaluate(() => window.__contour.contourMm)).toEqual(toolBefore);
  // a second pocket drag higher up, then delete ONLY the first
  const pocket3 = await page.evaluate(() => window.__profile.pocketPts);
  const up = pocket3.filter((p) => p[0] > 0)
    .reduce((m, p) => (Math.abs(p[1] - (y0 + 55)) < Math.abs(m[1] - (y0 + 55)) ? p : m));
  const [ux0, uy0] = await onPocket(up);
  const [ux1] = await onPocket([up[0] + 3, up[1]]);
  await mark();
  await page.mouse.move(ux0, uy0);
  await page.mouse.down();
  await page.mouse.move(ux1, uy0, { steps: 4 });
  await page.mouse.up();
  await refit();
  const pd = await page.evaluate(() => window.__edits().pocketDrags);
  expect(pd.length).toBe(2);
  const [px0, py0] = await onPocket([pd[0][0][0] + pd[0][1][0], pd[0][0][1] + pd[0][1][1]]);
  await page.mouse.click(px0, py0); // select the first one's handle
  await expect(page.locator("#ed-del")).toBeEnabled();
  await mark();
  await page.click("#ed-del");
  await refit();
  expect(await page.evaluate(() => window.__profile.params.pocket_drags))
    .toEqual([pd[1]]);

  // export (rebuilds the stale model first), then revise the STEP
  const dl = page.waitForEvent("download", { timeout: 300000 });
  await page.click("#export-step");
  const saved = info.outputPath("edited.step");
  await (await dl).saveAs(saved);
  await page.reload();
  await page.setInputFiles("#photo", saved);
  await expect.poll(() => page.evaluate(() => window.__profile &&
    window.__profile.ok), { timeout: 240000 }).toBe(true);
  const back = await page.evaluate(() => ({
    contour: window.__contour.contourMm, params: window.__profile.params }));
  expect(Math.abs(width(back.contour) - width(edited))).toBeLessThan(0.2);
  expect(back.params.straights.length).toBe(1);
  expect(back.params.pocket_drags.length).toBe(1);
  expect(back.params.straights[0][3]).toBeCloseTo(off, 6); // the moved line
  // no photo with a STEP: no outline editing, but pocket edits clear
  await expect(page.locator("#pane-warp")).toBeHidden();
  await expect(page.locator("#ed-clear")).toBeEnabled();
  await page.click("#ed-clear");
  await expect.poll(() => page.evaluate(() => window.__profile &&
    window.__profile.ok && !window.__profile.params.straights &&
    !window.__profile.params.pocket_drags),
    { timeout: 120000 }).toBe(true);
});

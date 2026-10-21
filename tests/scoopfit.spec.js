// Scoop suggestions (pure geometry): the bbox prediction rounds like
// layout(), and size / position suggestions only appear when they save
// a grid unit. (The UI additionally verifies each with a real fit.)
import { test, expect } from "@playwright/test";
import {
  layout, autoScoops, chordPartner, scoopsForMode, SCOOP_MODES, legacyScoopParams,
} from "../src/profilestage.js";
import {
  pocketExtent, binUnits, suggestSize, suggestPosition, D_MIN,
} from "../src/scoopfit.js";

/** stadium (capsule) outline centred on the origin, w x h mm */
function capsule(w, h, n = 2000) {
  const r = h / 2, a = w / 2 - r, pts = [];
  const per = 2 * (2 * a) + 2 * Math.PI * r;
  for (let i = 0; i < n; i++) {
    let s = (i / n) * per;
    if (s < 2 * a) { pts.push([-a + s, -r]); continue; }
    s -= 2 * a;
    if (s < Math.PI * r) {
      const t = -Math.PI / 2 + s / r; pts.push([a + r * Math.cos(t), r * Math.sin(t)]); continue;
    }
    s -= Math.PI * r;
    if (s < 2 * a) { pts.push([a - s, r]); continue; }
    s -= 2 * a;
    const t = Math.PI / 2 + s / r; pts.push([-a + r * Math.cos(t), r * Math.sin(t)]);
  }
  return pts;
}
const unitsOf = (fit, sc, d, wall) => binUnits(pocketExtent(fit, sc, d), wall);

test("binUnits(pocketExtent) rounds exactly like layout()", () => {
  for (const [w, h] of [[60, 20], [79.5, 36], [120, 41], [33, 33]]) {
    const fit = capsule(w, h);
    for (const wall of [1.8, 3, 5]) {
      const L = layout(fit, 25, wall);
      expect(unitsOf(fit, [], 0, wall)).toEqual({ nx: L.nx, ny: L.ny });
    }
  }
});

test("end scoops that cost a unit: smaller size and new spot found", () => {
  const fit = capsule(60, 20);
  const sc = [[-30, 0], [30, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 3, ny: 1 }); // bare tool is 2x1
  const s = suggestSize(fit, sc, 25, 3, cur);
  expect(s).toMatchObject({ d: 17, nx: 2, ny: 1 });
  expect(s.d).toBeGreaterThanOrEqual(D_MIN);
  expect(unitsOf(fit, sc, s.d, 3)).toEqual({ nx: 2, ny: 1 });
  // a same-height pair on a wide tool sits on its short ends — never
  // suggested there (owner, 2026-10-21)
  expect(suggestPosition(fit, sc, 25, 3, cur)).toBeNull();
});

/** dense polygon through the given corners */
function poly(corners, step = 0.25) {
  const pts = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % corners.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++)
      pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  });
  return pts;
}

test("move suggestion never puts finger scoops on a short edge", () => {
  // a tall bar (owner's screenshot, 2026-10-21): side scoops cost a unit
  // and only the bottom end would save it, so nothing is suggested
  const bar = poly([[-10, -60], [10, -60], [10, 60], [-10, 60]]);
  const sc = [[-10, 0], [10, 0]];
  const cur = unitsOf(bar, sc, 25, 3);
  expect(cur).toEqual({ nx: 2, ny: 4 });
  expect(unitsOf(bar, [[0, -60]], 25, 3)).toMatchObject({ nx: 1 }); // the end would
  expect(suggestPosition(bar, sc, 25, 3, cur, "mirror")).toBeNull();
  // free: one scoop may join the other on the same long side, but clear
  // of it and of both ends (it once landed right on top of the other)
  const f = suggestPosition(bar, sc, 25, 3, cur, "free");
  if (f) {
    const [p, q] = f.scoops;
    expect(Math.hypot(p[0] - q[0], p[1] - q[1])).toBeGreaterThanOrEqual(25);
    for (const s of f.scoops) {
      expect(Math.abs(s[0])).toBeCloseTo(10, 0);
      expect(Math.abs(s[1]) + 12.5).toBeLessThanOrEqual(60);
    }
  }
  // one scoop on the side already fits 1 unit wide: nothing to save
  expect(unitsOf(bar, [sc[1]], 25, 3)).toEqual({ nx: 1, ny: 4 });
});

test("mirrored pair moves down a long side to where the tool narrows", () => {
  // 30 mm head over an 8 mm shaft: scoops at the head cost a unit
  const fit = poly([[-4, -60], [4, -60], [4, 20], [15, 20], [15, 60],
                    [-15, 60], [-15, 20], [-4, 20]]);
  const sc = [[-15, 40], [15, 40]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 2, ny: 4 });
  const m = suggestPosition(fit, sc, 25, 3, cur);
  expect(m).toMatchObject({ nx: 1, ny: 4 });
  const [p, q] = m.scoops;
  expect(p[1]).toBeCloseTo(q[1], 1);              // same height
  expect(Math.abs(p[0])).toBeCloseTo(4, 0);       // on the shaft's sides
  expect(Math.abs(q[0])).toBeCloseTo(4, 0);
  expect(p[1]).toBeLessThan(20);
  expect(p[1] - 12.5).toBeGreaterThanOrEqual(-60); // clear of the end
  expect(unitsOf(fit, m.scoops, 25, 3)).toEqual({ nx: 1, ny: 4 });
});

test("no suggestion when the scoops don't cost a unit", () => {
  const fit = capsule(80, 20); // bare tool already 3 units wide
  const sc = [[-40, 0], [40, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 3, ny: 1 });
  expect(suggestSize(fit, sc, 25, 3, cur)).toBeNull();
  expect(suggestPosition(fit, sc, 25, 3, cur)).toBeNull();
});

test("no size suggestion below the finger-size floor; none with scoops off", () => {
  const fit = capsule(70, 20); // would need d <= 7 to drop a unit
  const sc = [[-35, 0], [35, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(suggestSize(fit, sc, 25, 3, cur)).toBeNull();
  expect(suggestSize(fit, sc, 0, 3, cur)).toBeNull();
  expect(suggestPosition(fit, sc, 0, 3, cur)).toBeNull();
});

/** a slanted band (like a curved tool): x from -15 + k·y to 15 + k·y,
 *  y in [-60, 60], CCW, dense */
function slanted(k = 0.5, n = 600) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([-15 + 30 * i / n + k * -60, -60]);
  for (let i = 0; i < n; i++) { const y = -60 + 120 * i / n; pts.push([15 + k * y, y]); }
  for (let i = 0; i < n; i++) pts.push([15 - 30 * i / n + k * 60, 60]);
  for (let i = 0; i < n; i++) { const y = 60 - 120 * i / n; pts.push([-15 + k * y, y]); }
  return pts;
}

test("mirrored scoops sit at the same height on a slanted tool", () => {
  const fit = slanted();
  const [l, r] = autoScoops(fit);
  expect(Math.abs(l[1] - r[1])).toBeLessThan(0.25); // fit-point spacing
  expect(r[0] - l[0]).toBeCloseTo(30, 0);            // across the chord
  // old rule (snap the x-mirror) drifted ~10 mm up the far edge
  const p = chordPartner(fit, [-15 + 0.5 * -20, -20]);
  expect(p[1]).toBeCloseTo(-20, 0);
  expect(p[0]).toBeCloseTo(15 + 0.5 * -20, 0);
  // symmetric outline: same spot as the x-mirror (oracle parity)
  const cap = capsule(60, 20);
  const cp = chordPartner(cap, [-30, 0]);
  expect(cp[0]).toBeCloseTo(30, 1);
  expect(cp[1]).toBeCloseTo(0, 1);
});

test("scoop modes: auto spots and re-shaping the spots on screen", () => {
  const fit = slanted();
  const pair = autoScoops(fit, "mirror");
  expect(autoScoops(fit, "free")).toEqual(pair);
  expect(autoScoops(fit, "left")).toEqual([pair[0]]);
  expect(autoScoops(fit, "right")).toEqual([pair[1]]);
  expect(SCOOP_MODES).toEqual(["mirror", "free", "left", "right"]);
  // an independently dragged pair keeps both spots...
  const dragged = [[-15 + 0.5 * 30, 30], [15 + 0.5 * -40, -40]];
  expect(scoopsForMode(fit, dragged, "free")).toEqual(dragged);
  // ...picks a side for left/right, re-pairs on the left spot for mirror
  expect(scoopsForMode(fit, dragged, "left")).toEqual([dragged[0]]);
  expect(scoopsForMode(fit, dragged, "right")).toEqual([dragged[1]]);
  const m = scoopsForMode(fit, dragged, "mirror");
  expect(m[0]).toEqual(dragged[0]);
  expect(m[1][1]).toBeCloseTo(30, 0);
  // a lone scoop gains its mirrored partner
  const two = scoopsForMode(fit, [pair[1]], "free");
  expect(two.length).toBe(2);
  expect(Math.abs(two[0][1] - two[1][1])).toBeLessThan(0.25);
  expect(scoopsForMode(fit, null, "mirror")).toBeNull();
});

test("move suggestion: independent / single scoops move alone", () => {
  const fit = capsule(60, 20);
  const sc = [[-30, 0], [30, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 3, ny: 1 });
  // single scoop: the one spot moves
  const one = suggestPosition(fit, [[30, 0]], 25, 3, cur, "right");
  expect(one.scoops.length).toBe(1);
  expect(unitsOf(fit, one.scoops, 25, 3)).toEqual({ nx: 2, ny: 1 });
  // independent pair: one end moves, the other stays put — and that is
  // already enough here (one 12.5 mm overhang fits the 2-unit slack)
  const f = suggestPosition(fit, sc, 25, 3, cur, "free");
  expect(unitsOf(fit, f.scoops, 25, 3)).toEqual({ nx: 2, ny: 1 });
  const kept = f.scoops.filter((p) => sc.some((q) => q[0] === p[0] && q[1] === p[1]));
  expect(kept.length).toBe(1);
  // mirrored pair: a same-height pair here sits on the short ends
  expect(suggestPosition(fit, sc, 25, 3, cur, "mirror")).toBeNull();
});

test("legacy 'scallop' params (PoC oracle, old STEP designs) still load", () => {
  expect(legacyScoopParams({ scallop_d: 20, scallop_blend: 4, scallops: [[1, 2]],
                             clearance: 1 }))
    .toEqual({ scoop_d: 20, scoop_blend: 4, scoops: [[1, 2]], clearance: 1 });
  // new names win over old ones
  expect(legacyScoopParams({ scallop_d: 20, scoop_d: 12 })).toEqual({ scoop_d: 12 });
  expect(legacyScoopParams({ scoop_mode: "left" })).toEqual({ scoop_mode: "left" });
});

// Scallop suggestions (pure geometry): the bbox prediction rounds like
// layout(), and size / position suggestions only appear when they save
// a grid unit. (The UI additionally verifies each with a real fit.)
import { test, expect } from "@playwright/test";
import { layout } from "../src/profilestage.js";
import {
  pocketExtent, binUnits, suggestSize, suggestPosition, D_MIN,
} from "../src/scallopfit.js";

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

test("end scallops that cost a unit: smaller size and new spot found", () => {
  const fit = capsule(60, 20);
  const sc = [[-30, 0], [30, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 3, ny: 1 }); // bare tool is 2x1
  const s = suggestSize(fit, sc, 25, 3, cur);
  expect(s).toMatchObject({ d: 17, nx: 2, ny: 1 });
  expect(s.d).toBeGreaterThanOrEqual(D_MIN);
  expect(unitsOf(fit, sc, s.d, 3)).toEqual({ nx: 2, ny: 1 });
  const m = suggestPosition(fit, sc, 25, 3, cur);
  expect(m).toMatchObject({ nx: 2, ny: 1 });
  // a mirrored pair moved off the ends toward one long side (the nearest
  // valid spots sit where the end caps turn into the side)
  const [p, q] = m.scallops;
  expect(p[0]).toBeCloseTo(-q[0], 0);
  expect(Math.abs(p[1])).toBeGreaterThan(5);
  expect(Math.abs(p[0])).toBeLessThan(30);
  expect(Math.sign(p[1])).toBe(Math.sign(q[1]));
  expect(unitsOf(fit, m.scallops, 25, 3)).toEqual({ nx: 2, ny: 1 });
});

test("no suggestion when the scallops don't cost a unit", () => {
  const fit = capsule(80, 20); // bare tool already 3 units wide
  const sc = [[-40, 0], [40, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(cur).toEqual({ nx: 3, ny: 1 });
  expect(suggestSize(fit, sc, 25, 3, cur)).toBeNull();
  expect(suggestPosition(fit, sc, 25, 3, cur)).toBeNull();
});

test("no size suggestion below the finger-size floor; none with scallops off", () => {
  const fit = capsule(70, 20); // would need d <= 7 to drop a unit
  const sc = [[-35, 0], [35, 0]];
  const cur = unitsOf(fit, sc, 25, 3);
  expect(suggestSize(fit, sc, 25, 3, cur)).toBeNull();
  expect(suggestSize(fit, sc, 0, 3, cur)).toBeNull();
  expect(suggestPosition(fit, sc, 0, 3, cur)).toBeNull();
});

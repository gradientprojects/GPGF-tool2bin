// Bin height rule: the pocket never leaves less than MIN_FLOOR (7 mm)
// under it, flush bins round up to whole 7 mm units, and the "proud"
// choice is exactly one unit shorter with the tool standing above the
// rim (never more than half the tool). Plain Node.
import { test, expect } from "@playwright/test";
import { layout, depthOptions, MIN_FLOOR } from "../src/profilestage.js";

const RECT = [[0, 0], [100, 0], [100, 30], [0, 30]];

test("flush: full-depth pocket, >= 7 mm floor, minimal bin", () => {
  expect(MIN_FLOOR).toBe(7);
  for (let t = 1; t <= 60; t += 0.5) {
    const L = layout(RECT, t, 3);
    expect(L.mode).toBe("flush");
    expect(L.depth).toBe(t);
    expect(L.H - L.depth).toBeGreaterThanOrEqual(MIN_FLOOR);
    if (L.nz > 1) expect(L.H - 7 - L.depth).toBeLessThan(MIN_FLOOR);
  }
});

test("proud: one unit shorter, floor exactly 7 mm, gives/gets reported", () => {
  const o = depthOptions(16.5);
  expect([o.flush.nz, o.flush.H]).toEqual([4, 28]);
  expect(o.proud).toMatchObject({ ok: true, nz: 3, H: 21, depth: 14,
                                  stickout: 2.5, saveMm: 7 });
  const L = layout(RECT, 16.5, 3, "proud");
  expect([L.mode, L.nz, L.depth, L.H - L.depth]).toEqual(["proud", 3, 14, MIN_FLOOR]);
});

test("proud is refused only when there is no shorter bin with pocket room", () => {
  for (let t = 1; t <= 60; t += 0.5) {
    const o = depthOptions(t);
    if (o.proud.ok) {
      expect(o.proud.H - o.proud.depth).toBe(MIN_FLOOR);
      expect(o.proud.depth).toBeGreaterThanOrEqual(t / 2);
    } else {
      const L = layout(RECT, t, 3, "proud");
      expect(L.mode).toBe("flush"); // falls back
    }
  }
  expect(depthOptions(3).proud.ok).toBe(false);  // 2u -> 1u has no pocket room
  expect(depthOptions(7).proud.ok).toBe(false);  // 2u is already the shortest
  expect(depthOptions(14).proud).toMatchObject({ ok: true, stickout: 7 }); // worst case: half
});

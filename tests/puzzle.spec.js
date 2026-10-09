// Puzzle-piece bin (owner idea, 2026-10-09): drop whole grid cells the
// pocket doesn't need (min wall kept), so the bin becomes an L / T shape.
// Offered only when it saves cells; off by default.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { puzzleCells, puzzleOutline } from "../src/puzzle.js";

/** closed polygon through `corners`, sampled every `step` mm */
function poly(corners, step = 0.25) {
  const pts = [];
  for (let e = 0; e < corners.length; e++) {
    const a = corners[e], b = corners[(e + 1) % corners.length];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < n; i++) {
      pts.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
    }
  }
  return pts;
}
/** a T: crossbar x ±hw, y y0..y1; stem x ±sw, down to yb */
const tee = (hw = 53, y0 = 21, y1 = 39, sw = 9, yb = -59) => poly([
  [-sw, yb], [sw, yb], [sw, y0], [hw, y0], [hw, y1], [-hw, y1], [-hw, y0], [-sw, y0],
]);
const keySet = (keep) => new Set(keep.map(([i, j]) => `${i},${j}`));

test("cells: a T drops its four empty side cells", () => {
  // 3×3 grid, centre (0, -10): columns at x -63/-21/21/63, rows -73/-31/11/53
  const r = puzzleCells(tee(), 3, 3, [0, -10], 3);
  expect(r.drop).toBe(4);
  const k = keySet(r.keep);
  for (const c of ["0,2", "1,2", "2,2", "1,1", "1,0"]) expect(k.has(c)).toBe(true);
});

test("cells: the min wall keeps a cell the pocket comes too close to", () => {
  // stem's right side 2.5 mm from the right column (wall 3 + gap/2 > 2.5)
  const r = puzzleCells(tee(53, 21, 39, 9, -59).map(([x, y]) =>
    [x > 8.9 && y < 21 ? 18.5 : x, y]), 3, 3, [0, -10], 3);
  const k = keySet(r.keep);
  expect(k.has("2,1")).toBe(true);
  expect(k.has("2,0")).toBe(true);
  expect(k.has("0,1")).toBe(false);
});

test("cells: an unused cell walled in by the pocket stays (no hole)", () => {
  // a square ring (as one loop with a 1 mm slit) around the centre cell
  const ring = poly([
    [-0.5, 60], [-60, 60], [-60, -60], [60, -60], [60, 60], [0.5, 60],
    [0.5, 50], [50, 50], [50, -50], [-50, -50], [-50, 50], [-0.5, 50],
  ]);
  const r = puzzleCells(ring, 3, 3, [0, 0], 3);
  expect(keySet(r.keep).has("1,1")).toBe(true);
  expect(r.drop).toBe(0);
});

test("outline: an L of three cells is one loop, 5 outside + 1 inside corner", () => {
  const kept = [[true, true], [true, false]]; // (0,0) (0,1) (1,0)
  const v = puzzleOutline(kept, 2, 2, [0, 0]);
  expect(v.length).toBe(6);
  expect(v.filter((c) => c.convex).length).toBe(5);
  const inner = v.find((c) => !c.convex);
  // the inside corner: grid point (0, 0), its edges moved GAP/2 into the
  // bin, i.e. away from the notch (a neighbour there keeps the 0.5 gap)
  expect(inner.p[0]).toBeCloseTo(-0.25, 9);
  expect(inner.p[1]).toBeCloseTo(-0.25, 9);
  // an outside corner: inset GAP/2 like a full bin (W = 2·42 − 0.5)
  const ll = v.find((c) => c.p[0] < -41 && c.p[1] < -41);
  expect(ll.p).toEqual([-41.75, -41.75]);
});

test("worker: the layout offers the drop; params.puzzle turns it on", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.evaluate(() => window.__selftest.cv &&
    window.__selftest.cv.ok), { timeout: 120000 }).toBe(true);
  const tool = tee(52, 22, 38, 8, -58);
  const base = { clearance: 1, smooth_r: 4, scoop_d: 0, symmetric: true,
                 strict_contain: true, thickness: 10, min_wall: 3 };
  const off = await page.evaluate(([c, p]) => window.__profileRun(c, p), [tool, base]);
  expect(off.layout.nx).toBe(3);
  expect(off.layout.ny).toBe(3);
  expect(off.puzzle.drop).toBe(4);
  expect(off.puzzle.on).toBe(false);
  expect(off.puzzle.outline.length).toBe(8); // a T: 6 outside + 2 inside
  const on = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [tool, { ...base, puzzle: true }]);
  expect(on.puzzle.on).toBe(true);
  // a plain rectangle saves nothing: nothing offered
  const rect = poly([[-40, -15], [40, -15], [40, 15], [-40, 15]]);
  const none = await page.evaluate(([c, p]) => window.__profileRun(c, p),
    [rect, { ...base, puzzle: true }]);
  expect(none.puzzle.drop).toBe(0);
  expect(none.puzzle.on).toBe(false);
});

test("UI: offered for a T, builds a valid T-shaped bin, round-trips the STEP", async ({ page }, info) => {
  test.setTimeout(400000);
  // a STEP-like file carrying just the embedded design (the revise path)
  const design = { name: "tee", rev: 1, source: "gpgf-tool2bin",
    params: { thickness: 10, clearance: 1, smooth_r: 4, scoop_d: 0,
              symmetric: true, strict_contain: true, min_wall: 3 },
    contour: tee(52, 22, 38, 8, -58).filter((_, i) => i % 4 === 0) };
  const fake = info.outputPath("tee.step");
  fs.writeFileSync(fake, `ISO-10303-21;\n/* S2S| ${JSON.stringify(design)} */\n`);
  await page.goto("/");
  await page.setInputFiles("#photo", fake);
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  const full = await page.evaluate(() => window.__bin);

  // offered (4 cells to drop), Full selected by default
  await expect(page.locator("#shape-row")).toBeVisible();
  await expect(page.locator("#shape-full")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#shape-puzzle")).toContainText("drops 4");

  // choose it: 3D goes stale; the rebuilt body is the T (5 of 9 cells),
  // valid, same overall bbox
  await page.evaluate(() => { window.__prev = window.__profile; });
  await page.click("#shape-puzzle");
  await expect.poll(() => page.evaluate(() => window.__profile !== window.__prev &&
    window.__profile.ok && window.__profile.puzzle.on), { timeout: 120000 }).toBe(true);
  await expect(page.locator("#bin-stale")).toBeVisible();
  await page.evaluate(() => { window.__bin = null; });
  await page.click("#rebuild-3d");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  const bin = await page.evaluate(() => window.__bin);
  expect(bin.logs.join("\n")).toContain("puzzle-piece bin: 5 of 9 cells");
  expect(bin.logs.join("\n")).toContain("bin solid valid");
  expect(bin.logs.join("\n")).not.toContain("WARNING");
  for (let k = 0; k < 3; k++) expect(bin.bbox.dims[k]).toBeCloseTo(full.bbox.dims[k], 1);

  // export: the design says puzzle; revising brings it back
  const dl = page.waitForEvent("download", { timeout: 240000 });
  await page.click("#export-step");
  const saved = info.outputPath("tee-puzzle.step");
  await (await dl).saveAs(saved);
  const text = fs.readFileSync(saved, "utf8");
  expect(text).toContain('"puzzle":true');
  await page.reload();
  await page.setInputFiles("#photo", saved);
  await expect.poll(() => page.evaluate(() => window.__profile &&
    window.__profile.ok && window.__profile.puzzle.on), { timeout: 240000 }).toBe(true);
  await expect(page.locator("#shape-puzzle")).toHaveAttribute("aria-checked", "true");
});

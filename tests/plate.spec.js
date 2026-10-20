// Two-sided printed scan plate (owner, 2026-10-19): both faces carry the
// paper letter template's exact layout + marker ids, so they read as page
// 'letter'. Synthetic colour photos (private tools/make_plate_fixture.py):
// - magenta side, two-tone tool: black 26 mm grip + mid-gray 8 mm metal
//   shaft, 190 mm long — a black field loses the grip, a white or gray one
//   the shaft; magenta must find both;
// - black side, white 30 x 80 mm plastic part.
import { test, expect } from "@playwright/test";
import path from "node:path";

const PHOTOS = path.join(import.meta.dirname, "fixtures", "photos");

async function scan(page, photo) {
  await page.goto("/");
  await page.setInputFiles("#photo", path.join(PHOTOS, photo));
  await page.fill("#bin-thickness", "26");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() => window.__profile && window.__profile.ok),
    { timeout: 240000 }).toBe(true);
  return page.evaluate(() => {
    const c = window.__contour.contourMm;
    const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
    return { mode: window.__warp.mode, page: window.__warp.page,
      nMarkers: window.__warp.nMarkers, area: window.__contour.areaMm2,
      bbox: [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
        .sort((a, b) => a - b) };
  });
}

test("plate, magenta side: two-tone black grip + metal shaft", async ({ page }) => {
  test.setTimeout(300000);
  const r = await scan(page, "plate-magenta-twotone.jpg");
  console.log(`PLATE magenta: ${r.page} ${r.nMarkers} markers, tool ` +
    `${r.bbox.map((v) => v.toFixed(2)).join(" x ")} mm, ${r.area.toFixed(0)} mm²`);
  expect(r.mode).toBe("template");
  expect(r.page).toBe("letter");
  expect(Math.abs(r.bbox[0] - 26)).toBeLessThan(0.5);
  // full length = grip AND shaft both found
  expect(Math.abs(r.bbox[1] - 190)).toBeLessThan(0.5);
  // grip (~2525 mm²) + exposed shaft (~680 mm²): the shaft is not a sliver
  expect(r.area).toBeGreaterThan(3100);
});

test("plate, black side: white plastic part", async ({ page }) => {
  test.setTimeout(300000);
  const r = await scan(page, "plate-black-white.jpg");
  console.log(`PLATE black: ${r.page} ${r.nMarkers} markers, part ` +
    `${r.bbox.map((v) => v.toFixed(2)).join(" x ")} mm`);
  expect(r.mode).toBe("template");
  // white on black is the steepest edge: the 1.2x score crossing sits at
  // the dark foot of the blur, so the outline runs ~0.28 mm/side OUTWARD
  // (measured 2026-10-19; BACKLOG "edge bias"). Never inward, < 0.4/side.
  for (const [got, want] of [[r.bbox[0], 30], [r.bbox[1], 80]]) {
    expect(got - want).toBeGreaterThan(0);
    expect(got - want).toBeLessThan(0.8);
  }
});

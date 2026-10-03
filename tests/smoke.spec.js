import { test, expect } from "@playwright/test";
import path from "node:path";
import { layout, markerCornersMm } from "../src/template.js";

// C1 exit gate: both WASM engines prove themselves in a real browser.
test("CAD kernel exports a valid STEP", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => page.evaluate(() => window.__selftest.cad), { timeout: 150000 })
    .not.toBeNull();
  const cad = await page.evaluate(() => window.__selftest.cad);
  expect(cad.ok, JSON.stringify(cad)).toBe(true);
  expect(cad.bytes).toBeGreaterThan(1000);
});

test("OpenCV loads and reports capabilities; ArUco detects the template", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(async () => page.evaluate(() => window.__selftest.cv), { timeout: 150000 })
    .not.toBeNull();
  const cv = await page.evaluate(() => window.__selftest.cv);
  expect(cv.ok, JSON.stringify(cv).slice(0, 500)).toBe(true);
  // hard requirements for the port (verified present in opencv-js 4.11)
  for (const k of ["Mat", "cvtColor", "warpPerspective", "findHomography",
    "inpaint", "connectedComponentsWithStats", "aruco_ArucoDetector"]) {
    expect(cv.caps[k], `capability ${k}`).toBe(true);
  }
  // all 24 letter-template markers must decode from the synthetic fixture
  expect(cv.aruco.ids).toEqual([...Array(24).keys()]);
  console.log("CAPABILITIES:", JSON.stringify(cv.caps));
  console.log("ARUCO:", JSON.stringify(cv.aruco));
});

test("warps the synthetic template end-to-end (CI-safe)", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles("#photo",
    path.resolve(import.meta.dirname, "../public/fixtures/synthetic-letter.png"));
  await expect
    .poll(async () => page.evaluate(() => window.__warp), { timeout: 150000 })
    .not.toBeNull();
  const w = await page.evaluate(() => window.__warp);
  expect(w.ok, w.error || "").toBe(true);
  expect(w.mode).toBe("template");
  expect(w.page).toBe("letter");
  expect(w.nMarkers).toBe(24);
  // reprojection residuals vs the true printed layout (ground truth)
  const L = layout("letter");
  const r = [];
  w.markerIds.forEach((id, i) => {
    const want = markerCornersMm(...L.markers.get(id));
    for (let k = 0; k < 4; k++) {
      const got = w.cornersMm[4 * i + k];
      r.push(Math.hypot(got[0] - want[k][0], got[1] - want[k][1]));
    }
  });
  r.sort((a, b) => a - b);
  const median = r[Math.floor(r.length / 2)], max = r[r.length - 1];
  console.log(`SYNTHETIC WARP: median ${median.toFixed(4)} mm, max ${max.toFixed(4)} mm, ` +
    `inliers ${w.inliers}/${w.total}`);
  // fixture is 4 px/mm with noise: ~0.6 px corner jitter = ~0.16 mm. This
  // is a CI regression canary, not a precision gate (that's parity.spec.js).
  expect(median).toBeLessThan(0.25);
  expect(max).toBeLessThan(0.6);
});

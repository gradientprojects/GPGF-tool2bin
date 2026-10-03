import { test, expect } from "@playwright/test";

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

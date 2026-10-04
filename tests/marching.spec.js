// Golden-value test for the skimage find_contours port. The fixture is
// dumped by the reference environment's real skimage over adversarial
// arrays (saddles, exact-level values, plateaus) — the port must match
// every vertex exactly. Runs in CI (fixture is committed).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { findContours } from "../src/marching.js";

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, "fixtures", "marching.json"), "utf8"));

test.describe("marching squares vs skimage goldens", () => {
  for (const c of fixture.cases) {
    test(`find_contours: ${c.name}`, () => {
      const [rows, cols] = c.shape;
      const got = findContours(c.data, rows, cols, c.level);
      expect(got.length).toBe(c.contours.length);
      for (let i = 0; i < got.length; i++) {
        expect(got[i].length).toBe(c.contours[i].length);
        for (let j = 0; j < got[i].length; j++) {
          // vertices must agree to float64 round-trip precision
          expect(Math.abs(got[i][j][0] - c.contours[i][j][0])).toBeLessThan(1e-12);
          expect(Math.abs(got[i][j][1] - c.contours[i][j][1])).toBeLessThan(1e-12);
        }
      }
    });
  }
});

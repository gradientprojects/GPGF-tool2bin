// C5 exit gate: the JS-built bins (raw-kernel port of bin3d.py) are
// validated by the REFERENCE OCCT kernel: tools/step_check.py re-imports
// every exported STEP, checks B-rep validity and dims vs the oracle's
// bin bbox (< 0.05 mm), canonical (magnets+chamfer) and plain variants.
// Local-only (needs the reference repo + its venv); skips in CI.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");
const available = fs.existsSync(path.join(POC, "_ORACLE"));
const PYTHON = path.join(POC, ".venv", "bin", "python");
const APP = path.resolve(import.meta.dirname, "..");

test.describe("stage-6 CAD parity: STEP exports vs reference kernel", () => {
  test.skip(!available, "reference repo not present (local-only test)");

  test("build all corpus bins and verify with the reference kernel", () => {
    test.setTimeout(900000);
    const out = execFileSync("bash",
      [path.join(APP, "tests/run_cjs.sh"), path.join(APP, "tests/build_steps.cjs")],
      { encoding: "utf8", timeout: 880000 });
    const okLines = out.split("\n").filter((l) => l.startsWith("OK "));
    console.log(okLines.join("\n"));
    expect(out).toContain("12/12 built");

    const manifest = JSON.parse(fs.readFileSync(
      path.join(APP, "test-results/steps/manifest.json"), "utf8"));
    expect(manifest.length).toBe(12);
    for (const m of manifest) {
      expect(m.error, m.stem).toBeUndefined();
      const res = execFileSync(PYTHON,
        [path.join(POC, "tools/step_check.py"), m.file,
         "--expect", ...m.expect.map(String), "--tol", "0.05"],
        { encoding: "utf8", cwd: POC, timeout: 120000 });
      expect(res, `${m.stem}: ${res}`).toContain("1/1 passed");
      expect(res).toContain("valid=True");
      expect(res).toContain("embedded design");
      // z_top parity (pocket depth / height wiring)
      expect(Math.abs(m.gotZ - m.zTop)).toBeLessThan(0.05);
    }
  });

  test("browser end-to-end: photo to STEP download", async ({ page }) => {
    test.setTimeout(600000);
    await page.goto("/");
    await page.setInputFiles("#photo", path.join(POC, "snips-closed.JPG"));
    await expect
      .poll(async () => page.evaluate(() => window.__bin), { timeout: 580000 })
      .not.toBeNull();
    const bin = await page.evaluate(() => window.__bin);
    expect(bin.ok, bin.error || "").toBe(true);
    const oracle = JSON.parse(fs.readFileSync(
      path.join(POC, "_ORACLE", "snips-closed.json"), "utf8"));
    // stage-1/2 already differ RANSAC-level e2e; the bin dims are grid-
    // quantized so they must match the oracle exactly
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(bin.bbox.dims[i] - oracle.bin.bbox_mm[i])).toBeLessThan(0.05);
    }
    const dl = page.waitForEvent("download");
    await page.click("#export-step");
    const file = await (await dl).path();
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("ISO-10303-21")).toBe(true);
    expect(text).toContain("S2S|");
    expect((await dl).suggestedFilename())
      .toMatch(/^GPGF-t2b snips-closed - \dX\dY\dZ R01\.step$/);
  });
});

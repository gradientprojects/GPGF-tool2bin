// Round (revolved) tool mode (owner, 2026-10-13): the cradle geometry
// gate (tests/round.cjs, CI-safe) and the UI flow on a synthetic
// screwdriver photo (tools/make_round_fixture.py).
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");
const PHOTO = path.join(import.meta.dirname, "fixtures", "photos",
  "round-screwdriver.jpg");

for (const mode of ["sub", "flush"]) {
  test(`round tool cradle (${mode === "sub" ? "tool" : "axis"} flush): walls, scoops, fillets, rim, negative`, () => {
    // ~3 min a half locally; a shared 2-worker CI runner took > 9 min
    test.setTimeout(920000);
    const out = execFileSync("bash",
      [path.join(APP, "tests/run_cjs.sh"), path.join(APP, "tests/round.cjs"), mode],
      { encoding: "utf8", timeout: 900000 });
    console.log(out.split("\n").filter((l) => /^(ok|FAIL|ROUND)/.test(l)).join("\n"));
    expect(out).toContain("ROUND OK");
    // local-only: re-import the bins (written by the Tool flush half)
    // with the reference kernel
    if (mode === "sub" && fs.existsSync(path.join(POC, "_ORACLE"))) {
      for (const f of ["round.step", "round-scoops.step"]) {
        const res = execFileSync(path.join(POC, ".venv", "bin", "python"),
          [path.join(POC, "tools/step_check.py"), path.join(APP, "test-results", f),
           "--expect", "41.5", "167.5", "35", "--tol", "0.05"],
          { encoding: "utf8", cwd: POC, timeout: 120000 });
        console.log(res.trim());
        expect(res).toContain("1/1 passed");
        expect(res).toContain("valid=True");
      }
    }
  });
}

const settled = (page) => expect.poll(() => page.evaluate(() =>
  window.__profile && window.__profile.ok &&
  !document.getElementById("rebuild-3d").disabled), { timeout: 240000 }).toBe(true);
const rd = (page) => page.evaluate(() => window.__profile.round &&
  { mode: window.__profile.round.mode, a: window.__profile.round.a,
    r: window.__profile.round.r, nz: window.__profile.layout.nz,
    depth: window.__profile.layout.depth });

test("round tool UI: cradle cards, build, STEP round trip, negative", async ({ page }, info) => {
  test.setTimeout(500000);
  await page.goto("/");
  await page.setInputFiles("#photo", PHOTO);
  await page.fill("#bin-thickness", "26");
  await page.click("#start-scan");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok),
    { timeout: 240000 }).toBe(true);
  await settled(page);
  await expect(page.locator("#depth-choices")).toBeVisible();
  await expect(page.locator("#axis-choices")).toBeHidden();

  // round on: symmetric locked on, the two centre-line cards replace
  // Flush / Shorter, default Tool flush with the whole tool under the top
  await page.check("#opt-symmetric");
  await page.check("#opt-round");
  await expect(page.locator("#opt-symmetric")).toBeDisabled();
  await expect.poll(() => rd(page), { timeout: 120000 }).not.toBeNull();
  await settled(page);
  await expect(page.locator("#axis-choices")).toBeVisible();
  await expect(page.locator("#depth-choices")).toBeHidden();
  let s = await rd(page);
  expect(s.mode).toBe("sub");
  // the cradle is the pocket's half-width: the Ø26 handle + 1 mm
  // clearance, + what smoothing bows out (most at the ferrule step)
  const rTool = await page.evaluate(() => window.__profile.round.rTool);
  expect(Math.abs(rTool - 13)).toBeLessThan(0.3);
  expect(s.r).toBeGreaterThan(rTool + 0.9);
  expect(s.r).toBeLessThan(rTool + 2.5);
  expect(s.a).toBeCloseTo(s.r, 6);
  expect(s.nz).toBe(Math.ceil((2 * s.r + 7) / 7));
  await expect(page.locator("#axis-sub .give")).toHaveText("whole tool under the top, its top level with it");
  // never proud, no typed depth (owner, 2026-10-21)
  await expect(page.locator("#axis-proud")).toHaveCount(0);
  await expect(page.locator("#axis-mm")).toHaveCount(0);
  await expect(page.locator("#bin-stale")).toBeVisible(); // no auto regen
  await page.click("#rebuild-3d");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok &&
    (window.__bin.logs || []).some((l) => l.startsWith("round tool: cradle"))),
    { timeout: 240000 }).toBe(true);
  expect(await page.evaluate(() => window.__bin.H)).toBe(s.nz * 7);
  // a skipped finger scoop shows under the scoop controls; this tool's
  // scoops all fit, so the box stays hidden (round.cjs builds the skip)
  const notices = await page.evaluate(() => window.__bin.notices);
  expect(notices).toEqual([]);
  await expect(page.locator("#scoop-notice")).toBeHidden();

  // axis flush: half the tool in
  await page.click("#axis-flush");
  await expect.poll(async () => (await rd(page)).mode).toBe("flush");
  s = await rd(page);
  expect(s.a).toBe(0);
  expect(s.nz).toBe(Math.ceil((s.r + 7) / 7));
  await settled(page);

  // export (rebuilds first) + the negative; revise restores it all
  const dl = page.waitForEvent("download", { timeout: 300000 });
  await page.click("#export-step");
  const saved = info.outputPath("round.step");
  await (await dl).saveAs(saved);
  const dn = page.waitForEvent("download", { timeout: 300000 });
  await page.click("#export-neg");
  const neg = info.outputPath("round NEG.step");
  await (await dn).saveAs(neg);
  expect(fs.readFileSync(neg, "utf8")).toContain("ISO-10303-21");
  await page.reload();
  await page.setInputFiles("#photo", saved);
  await settled(page);
  await expect(page.locator("#opt-round")).toBeChecked();
  await expect(page.locator("#axis-flush")).toHaveAttribute("aria-checked", "true");
  expect((await rd(page)).a).toBe(0);
});

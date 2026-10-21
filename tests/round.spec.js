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

test("round tool cradle: sub-flush / flush / proud, walls, scoops, negative", () => {
  test.setTimeout(400000);
  const out = execFileSync("bash",
    [path.join(APP, "tests/run_cjs.sh"), path.join(APP, "tests/round.cjs")],
    { encoding: "utf8", timeout: 380000 });
  console.log(out.split("\n").filter((l) => /^(ok|FAIL|ROUND)/.test(l)).join("\n"));
  expect(out).toContain("ROUND OK");
  // local-only: re-import the cradle bin with the reference kernel
  if (fs.existsSync(path.join(POC, "_ORACLE"))) {
    const res = execFileSync(path.join(POC, ".venv", "bin", "python"),
      [path.join(POC, "tools/step_check.py"),
       path.join(APP, "test-results", "round.step"),
       "--expect", "41.5", "167.5", "35", "--tol", "0.05"],
      { encoding: "utf8", cwd: POC, timeout: 120000 });
    console.log(res.trim());
    expect(res).toContain("1/1 passed");
    expect(res).toContain("valid=True");
    // the filleted, chamfered finger slot bin too
    const res2 = execFileSync(path.join(POC, ".venv", "bin", "python"),
      [path.join(POC, "tools/step_check.py"),
       path.join(APP, "test-results", "round-scoops.step"),
       "--expect", "41.5", "167.5", "35", "--tol", "0.05"],
      { encoding: "utf8", cwd: POC, timeout: 120000 });
    console.log(res2.trim());
    expect(res2).toContain("1/1 passed");
    expect(res2).toContain("valid=True");
  }
});

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

  // round on: symmetric locked on, the three centre-line cards replace
  // Flush / Shorter, default sub-flush with the whole tool under the top
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
  await expect(page.locator("#axis-sub .give")).toHaveText("whole tool under the top");
  await expect(page.locator("#bin-stale")).toBeVisible(); // no auto regen
  await page.click("#rebuild-3d");
  await expect.poll(() => page.evaluate(() => window.__bin && window.__bin.ok &&
    (window.__bin.logs || []).some((l) => l.startsWith("round tool: cradle"))),
    { timeout: 240000 }).toBe(true);
  expect(await page.evaluate(() => window.__bin.H)).toBe(s.nz * 7);

  // axis flush: half the tool in
  await page.click("#axis-flush");
  await expect.poll(async () => (await rd(page)).mode).toBe("flush");
  s = await rd(page);
  expect(s.a).toBe(0);
  expect(s.nz).toBe(Math.ceil((s.r + 7) / 7));
  await expect(page.locator("#axis-mm-row")).toBeHidden();

  // proud, 4 mm above the top
  await page.click("#axis-proud");
  await expect.poll(async () => (await rd(page)).mode).toBe("proud");
  await expect(page.locator("#axis-mm-row")).toBeVisible();
  await page.fill("#axis-mm", "4");
  await page.locator("#axis-mm").dispatchEvent("change");
  await expect.poll(async () => (await rd(page)).a).toBe(-4);
  await expect(page.locator("#axis-proud .give")).toHaveText("centre line 4 mm above the top");
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
  await expect(page.locator("#axis-proud")).toHaveAttribute("aria-checked", "true");
  expect((await rd(page)).a).toBe(-4);
});

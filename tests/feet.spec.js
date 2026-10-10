// Foot fit (owner, 2026-10-09): standard Gridfinity feet, or the whole
// foot profile 0.25 mm smaller per side (matches generators that add that
// clearance: band 36.7, bottom 35.1). tests/feet.cjs measures the solid;
// this runs it (CI too) and, locally, re-imports the looser bin with the
// reference kernel.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");

test("foot fit: standard and looser feet measure right, solids valid", () => {
  test.setTimeout(300000);
  const out = execFileSync("bash",
    [path.join(APP, "tests/run_cjs.sh"), path.join(APP, "tests/feet.cjs")],
    { encoding: "utf8", timeout: 280000 });
  console.log(out.split("\n").filter((l) => /^(ok|FAIL)/.test(l)).join("\n"));
  expect(out).toContain("FEET OK");

  if (fs.existsSync(path.join(POC, "_ORACLE"))) {
    const res = execFileSync(path.join(POC, ".venv", "bin", "python"),
      [path.join(POC, "tools/step_check.py"),
       path.join(APP, "test-results", "feet-loose.step"),
       "--expect", "41.5", "41.5", "21", "--tol", "0.05"],
      { encoding: "utf8", cwd: POC, timeout: 120000 });
    console.log(res.trim());
    expect(res).toContain("1/1 passed");
    expect(res).toContain("valid=True");
  }
});

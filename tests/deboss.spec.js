// Revision-deboss geometry gate: synthetic bin, no oracle needed, so
// this one runs in CI too (tests/deboss.cjs does the actual checks).
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");

test("revision deboss: placement, clearances, valid cut", () => {
  test.setTimeout(300000);
  const out = execFileSync("bash",
    [path.join(APP, "tests/run_cjs.sh"), path.join(APP, "tests/deboss.cjs")],
    { encoding: "utf8", timeout: 280000 });
  console.log(out.trim());
  expect(out).toContain("DEBOSS OK");

  // local-only: re-import the debossed STEP with the reference kernel
  if (fs.existsSync(path.join(POC, "_ORACLE"))) {
    const res = execFileSync(path.join(POC, ".venv", "bin", "python"),
      [path.join(POC, "tools/step_check.py"),
       path.join(APP, "test-results", "deboss.step"),
       "--expect", "83.5", "41.5", "21", "--tol", "0.05"],
      { encoding: "utf8", cwd: POC, timeout: 120000 });
    console.log(res.trim());
    expect(res).toContain("1/1 passed");
    expect(res).toContain("valid=True");
  }
});

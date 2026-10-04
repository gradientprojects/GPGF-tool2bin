// C4 exit gate: profile-stage parity vs the oracle dumps — canonical
// params plus the parameter-sweep variants (literal corner path,
// symmetrize-only, smooth-asym). Runs profileResponse directly in Node
// on the oracle's own contour, so this is pure-math parity (stage 1-3
// variance is gated separately). Local-only; skips in CI.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import cvPromise from "@techstark/opencv-js";
import { profileResponse } from "../src/profilestage.js";

const POC = process.env.TOOL2BIN_POC ||
  path.resolve(import.meta.dirname, "../../../GPGF - Tool Scan2Step");
const ORACLE = path.join(POC, "_ORACLE");
const available = fs.existsSync(ORACLE);
const dumps = available
  ? fs.readdirSync(ORACLE).filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(ORACLE, f), "utf8")))
      .filter((d) => d.profile)
  : [];

async function cvReady() {
  let c = cvPromise;
  if (c && typeof c.then === "function") c = await c;
  if (c && !c.Mat && "onRuntimeInitialized" in c) {
    await new Promise((res) => { c.onRuntimeInitialized = res; });
  }
  return c;
}

function rmsVs(A, ref, stride) {
  // canonical dumps are full resolution; variant dumps are 5x-decimated
  const n = ref.length;
  expect(Math.ceil(A.length / stride)).toBe(n);
  let ss = 0, mx = 0;
  for (let i = 0; i < n; i++) {
    const a = A[stride * i], r = ref[i];
    const d = Math.hypot(a[0] - r[0], a[1] - r[1]);
    ss += d * d;
    if (d > mx) mx = d;
  }
  return { rms: Math.sqrt(ss / n), max: mx };
}

const GATE_RMS = 0.02; // mm, plan C4 exit gate

function checkAgainst(r, ref, label, stride = 5) {
  const fit = rmsVs(r.fit, ref.fit_points_mm, stride);
  const pocket = rmsVs(r.pocketPts, ref.pocket_points_mm, stride);
  console.log(`${label}: fit rms ${fit.rms.toFixed(5)} / max ${fit.max.toFixed(5)} mm, ` +
    `pocket rms ${pocket.rms.toFixed(5)} / max ${pocket.max.toFixed(5)} mm, ` +
    `layout ${JSON.stringify(r.layout)}`);
  expect(r.layout).toEqual(ref.layout);
  expect(Math.abs(r.center[0] - ref.center_mm[0])).toBeLessThan(1e-3);
  expect(Math.abs(r.center[1] - ref.center_mm[1])).toBeLessThan(1e-3);
  expect(r.warnings).toEqual(ref.warnings);
  expect(fit.rms).toBeLessThan(GATE_RMS);
  expect(pocket.rms).toBeLessThan(GATE_RMS);
  expect(fit.max).toBeLessThan(0.1);
  expect(pocket.max).toBeLessThan(0.1);
}

test.describe("stage-4/5 profile parity vs oracle", () => {
  test.skip(!available, "reference repo not present (local-only test)");

  for (const d of dumps) {
    test(`canonical params: ${d.photo}`, async () => {
      test.setTimeout(600000);
      const c = await cvReady();
      const logs = [];
      const r = profileResponse(c, d.contour_mm, d.profile.params,
        (l) => logs.push(l));
      checkAgainst(r, d.profile, `P4 ${d.photo} canonical`, 1);
      // auto-scallop positions are part of the contract
      expect(r.scallops.length).toBe(d.profile.auto_scallops_mm.length);
      r.scallops.forEach((s, i) => {
        const ref = d.profile.auto_scallops_mm[i];
        expect(Math.hypot(s[0] - ref[0], s[1] - ref[1])).toBeLessThan(1e-3);
      });
    });

    for (const [vname, v] of Object.entries(d.profile_variants || {})) {
      test(`variant ${vname}: ${d.photo}`, async () => {
        test.setTimeout(600000);
        const c = await cvReady();
        const params = { ...d.profile.params, ...v.params_override };
        const logs = [];
        const r = profileResponse(c, d.contour_mm, params, (l) => logs.push(l));
        checkAgainst(r, v, `P4 ${d.photo} ${vname}`);
      });
    }
  }
});

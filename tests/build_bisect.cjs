// One-off import-bug bisect: builds snips-closed variants isolating each
// canonical-only feature, for a drag-into-Bambu/Onshape test. Writes to
// test-results/bisect/. Run via tests/run_cjs.sh. Delete when solved.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = process.cwd();
const ORACLE = process.env.TOOL2BIN_POC
  ? path.join(process.env.TOOL2BIN_POC, "_ORACLE")
  : path.resolve(APP, "../../GPGF - Tool Scan2Step/_ORACLE");
const OUT = path.join(APP, "test-results", "bisect");

async function main() {
  const base = path.join(APP, "node_modules/replicad-opencascadejs/src");
  const factory = require(path.join(base, "replicad_single.js"));
  const oc = await (typeof factory === "function" ? factory : factory.default)(
    { locateFile: () => path.join(base, "replicad_single.wasm") });
  const cvFactory = require(path.join(APP, "node_modules/@techstark/opencv-js/dist/opencv.js"));
  let cv = cvFactory;
  if (cv && typeof cv.then === "function") cv = await cv;
  if (cv && !cv.Mat && "onRuntimeInitialized" in cv) {
    await new Promise((res) => { cv.onRuntimeInitialized = res; });
  }
  const { profileResponse } =
    await import(pathToFileURL(path.join(APP, "src/profilestage.js")));
  const bin3d = await import(pathToFileURL(path.join(APP, "src/bin3d.js")));

  fs.mkdirSync(OUT, { recursive: true });
  const d = JSON.parse(fs.readFileSync(
    path.join(ORACLE, "snips-closed.json"), "utf8"));
  const p = d.profile.params;
  const mag = { r: p.magnets.r, depth: p.magnets.depth, chamfer: p.magnets.chamfer };

  // [filename, params override, buildBin opt override]
  const variants = [
    ["A-magnets-only", { magnets: mag, edgeStyle: null, edgeSize: 0 }, {}],
    ["B-rim-chamfer-only", { magnets: null, edgeStyle: "chamfer", edgeSize: 1,
      pocketPts: null }, {}],
    ["C-entry-chamfer", { magnets: null, edgeStyle: "chamfer", edgeSize: 1 },
      {}],
    // clamped variants dropped: ThruSections over clamped closed wires
    // aborts this OCCT 7.6 wasm build (see profileEdge note)
  ];
  for (const [name, ov, opt] of variants) {
    const logs = [];
    const prof = profileResponse(cv, d.contour_mm, p, (l) => logs.push(l));
    const opts = {
      magnets: null, edgeStyle: null, edgeSize: 0,
      center: prof.center, pocketPts: prof.pocketPts,
      log: (l) => logs.push(l), ...ov, ...opt,
    };
    const { shape } = bin3d.buildBin(oc, prof.segs, prof.periodic,
      prof.layout.nx, prof.layout.ny, prof.layout.nz, p.thickness, opts);
    const text = bin3d.writeStepText(oc, shape, {
      name: `t2b bisect ${name}`,
      design: { name, rev: 1, params: p, source: "bisect" },
    });
    fs.writeFileSync(path.join(OUT, `t2b-bisect-${name}.step`), text);
    console.log(`BUILT ${name} (${(text.length / 1024).toFixed(0)} KB)`);
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

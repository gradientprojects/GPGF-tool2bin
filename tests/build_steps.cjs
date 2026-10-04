// C5 harness: oracle contour -> C4 profile -> C5 bin build -> STEP files.
// Run from app/ via tests/run_cjs.sh (node -e, CJS). Args: photo stems to
// build, or none for the whole corpus. Writes test-results/steps/*.step
// plus a manifest JSON with expected bboxes for the Python checker.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = process.cwd();
const ORACLE = process.env.TOOL2BIN_POC
  ? path.join(process.env.TOOL2BIN_POC, "_ORACLE")
  : path.resolve(APP, "../../GPGF - Tool Scan2Step/_ORACLE");
const OUT = path.join(APP, "test-results", "steps");

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
  const stems = process.argv.slice(2).filter((a) => a !== "--");
  const dumps = fs.readdirSync(ORACLE).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ORACLE, f), "utf8")))
    .filter((d) => d.bin && (!stems.length ||
      stems.some((s) => d.photo.includes(s))));

  const manifest = [];
  for (const d of dumps) {
    const stem = path.basename(d.photo).replace(/\.[^.]+$/, "");
    // canonical (magnets + chamfer, what the oracle's bin block used) and
    // a plain variant (no magnets, square edges) for the C5 gate's
    // "variants" requirement — bbox expectation is identical.
    const variants = [
      ["", d.profile.params],
      ["-plain", { ...d.profile.params, magnets: { enabled: false }, edge: {} }],
    ];
    for (const [suffix, p] of variants) {
      const t0 = Date.now();
      const logs = [];
      const log = (l) => logs.push(l);
      try {
        const prof = profileResponse(cv, d.contour_mm, p, log);
        const { shape, depth, H } = bin3d.buildBin(oc, prof.segs, prof.periodic,
          prof.layout.nx, prof.layout.ny, prof.layout.nz, p.thickness, {
            magnets: p.magnets && p.magnets.enabled
              ? { r: p.magnets.r, depth: p.magnets.depth, chamfer: p.magnets.chamfer }
              : null,
            edgeStyle: p.edge && p.edge.style, edgeSize: (p.edge && p.edge.size) || 0,
            center: prof.center, pocketPts: prof.pocketPts, log,
          });
        const bb = bin3d.bbox(oc, shape);
        const text = bin3d.writeStepText(oc, shape, {
          name: `${stem} bin`,
          design: { name: stem, rev: 1, params: p, source: "web-port-c5" },
        });
        const file = path.join(OUT, `${stem}${suffix}.step`);
        fs.writeFileSync(file, text);
        console.log(`OK ${stem}${suffix}: bbox ` +
          `${bb.dims.map((v) => v.toFixed(3)).join(" x ")}` +
          ` (ref ${d.bin.bbox_mm.join(" x ")}), zTop ${bb.zTop.toFixed(3)}` +
          ` (ref ${d.bin.z_top}), depth ${depth}, H ${H}, ${(Date.now() - t0) / 1000}s`);
        manifest.push({ stem: stem + suffix, file, expect: d.bin.bbox_mm,
          zTop: d.bin.z_top, got: bb.dims, gotZ: bb.zTop, logs });
      } catch (err) {
        console.log(`FAIL ${stem}${suffix}: ` +
          `${err && err.stack ? err.stack.split("\n")[0] : err}`);
        console.log("  logs so far:", logs.join(" | "));
        manifest.push({ stem: stem + suffix, error: String(err), logs });
      }
    }
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
  const fails = manifest.filter((m) => m.error).length;
  console.log(`${manifest.length - fails}/${manifest.length} built`);
  process.exit(fails ? 1 : 0);
}
main();

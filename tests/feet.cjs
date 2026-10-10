// Foot-fit geometry gate (no oracle needed): build a synthetic 1x1 bin
// with the standard and the looser foot, and measure the feet in the
// solid itself — bottom face, the straight band, and validity. Run from
// app/ via tests/run_cjs.sh.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = process.cwd();

function assert(cond, msg) {
  if (!cond) {
    console.log("FAIL " + msg);
    process.exit(1);
  }
  console.log("ok   " + msg);
}

async function main() {
  const base = path.join(APP, "node_modules/replicad-opencascadejs/src");
  const factory = require(path.join(base, "replicad_single.js"));
  const oc = await (typeof factory === "function" ? factory : factory.default)(
    { locateFile: () => path.join(base, "replicad_single.wasm") });
  const bin3d = await import(pathToFileURL(path.join(APP, "src/bin3d.js")));

  // small round pocket, well inside the cell
  const C = [];
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * i) / 16;
    C.push([10 * Math.cos(a), 10 * Math.sin(a)]);
  }
  const segs = [{ C, k: 3 }];
  // width of the solid's cross-section at height z (vertices within
  // [z0, z1]; a 1x1 bin is symmetric, so x extent = width)
  const width = (shape, z0, z1) => {
    const m = bin3d.tessellate(oc, shape);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      const z = m.positions[i + 2];
      if (z >= z0 - 1e-6 && z <= z1 + 1e-6) {
        lo = Math.min(lo, m.positions[i]);
        hi = Math.max(hi, m.positions[i]);
      }
    }
    return hi - lo;
  };
  const { CH1, STRAIGHT, FOOT_BOT } = bin3d;
  for (const [fc, bottom, band] of [[0, FOOT_BOT, FOOT_BOT + 2 * CH1],
                                    [0.25, 35.1, 36.7]]) {
    const logs = [];
    const { shape } = bin3d.buildBin(oc, segs, true, 1, 1, 3, 10,
      { footClearance: fc, log: (l) => logs.push(l) });
    assert(bin3d.isValid(oc, shape), `fit ${fc}: solid is valid`);
    const b = width(shape, 0, 0);
    assert(Math.abs(b - bottom) < 0.01, `fit ${fc}: bottom face ${b.toFixed(3)} ~ ${bottom.toFixed(2)}`);
    const s = width(shape, CH1, CH1 + STRAIGHT); // its two edges (a flat wall has no inner vertices)
    assert(Math.abs(s - band) < 0.01, `fit ${fc}: straight band ${s.toFixed(3)} ~ ${band.toFixed(2)}`);
    const dims = bin3d.bbox(oc, shape).dims;
    assert(Math.abs(dims[0] - 41.5) < 1e-6 && Math.abs(dims[2] - 21) < 1e-6,
      `fit ${fc}: body unchanged (${dims[0].toFixed(2)} wide, ${dims[2].toFixed(2)} tall)`);
    assert((fc > 0) === logs.some((l) => l.startsWith("feet: looser fit")),
      `fit ${fc}: build log says so (or not)`);
    if (fc > 0) {
      fs.mkdirSync(path.join(APP, "test-results"), { recursive: true });
      fs.writeFileSync(path.join(APP, "test-results", "feet-loose.step"),
        bin3d.writeStepText(oc, shape, { name: "looser feet test bin" }));
    }
  }
  console.log("FEET OK");
}
main().catch((e) => { console.error(e); process.exit(1); });

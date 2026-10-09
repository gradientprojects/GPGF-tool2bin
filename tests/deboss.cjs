// Revision-deboss geometry gate (no oracle needed): build a synthetic
// 2x1 bin, cut the deboss, and assert placement, size, clearances and
// solid validity. Run from app/ via tests/run_cjs.sh.
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
  const replicad = await import("replicad");
  replicad.setOC(oc);
  const bin3d = await import(pathToFileURL(path.join(APP, "src/bin3d.js")));
  const deboss = await import(pathToFileURL(path.join(APP, "src/deboss.js")));

  const fbuf = fs.readFileSync(path.join(APP, "src/assets/t2b-rev-bold.ttf"));
  await deboss.ensureDebossFont(
    fbuf.buffer.slice(fbuf.byteOffset, fbuf.byteOffset + fbuf.byteLength));

  // synthetic pocket: a periodic B-spline ring, radius 12, centered
  const C = [];
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * i) / 16;
    C.push([12 * Math.cos(a), 12 * Math.sin(a)]);
  }
  const segs = [{ C, k: 3 }];
  const logs = [];
  const log = (l) => logs.push(l);
  const magnets = { r: 3.075, depth: 2.1, chamfer: 0.5 };
  const { shape } = bin3d.buildBin(oc, segs, true, 2, 1, 3, 10,
    { magnets, center: [0, 0], log });
  const before = bin3d.bbox(oc, shape);

  // which corner (owner, 2026-10-09): the cell that's bottom-left in the
  // pocket preview, min-x / min-y — a 2x1 bin can't tell, so check 2x2
  {
    const c2 = bin3d.bbox(oc, deboss.debossCutter("R07", 2, 2, [0, 0]).wrapped);
    const x2 = (c2.min[0] + c2.max[0]) / 2, y2 = (c2.min[1] + c2.max[1]) / 2;
    assert(Math.abs(x2 + 21) < 0.2 && Math.abs(y2 + 21) < 0.2,
      `2x2 bin: under the bottom-left cell (${x2.toFixed(2)}, ${y2.toFixed(2)}) ~ (-21, -21)`);
    // a puzzle-piece bin passes the cell to use: it goes there
    const c3 = bin3d.bbox(oc, deboss.debossCutter("R07", 2, 2, [0, 0], [1, 0]).wrapped);
    const x3 = (c3.min[0] + c3.max[0]) / 2, y3 = (c3.min[1] + c3.max[1]) / 2;
    assert(Math.abs(x3 - 21) < 0.2 && Math.abs(y3 + 21) < 0.2,
      `given cell [1, 0]: (${x3.toFixed(2)}, ${y3.toFixed(2)}) ~ (21, -21)`);
  }

  // the cutter itself: placed in the bottom-left cell, 9 mm tall, clear
  // of magnets and chamfer
  const cutter = deboss.debossCutter("R07", 2, 1, [0, 0]);
  const cb = bin3d.bbox(oc, cutter.wrapped);
  const tx = -21, ty = 0; // 2x1 bin: left cell center
  assert(Math.abs(cb.min[2] - -0.5) < 0.01 && Math.abs(cb.max[2] - 0.4) < 0.01,
    `cutter z span [${cb.min[2].toFixed(2)}, ${cb.max[2].toFixed(2)}] = [-0.5, 0.4]`);
  const h = cb.max[1] - cb.min[1];
  assert(Math.abs(h - 9) < 0.3, `text height ${h.toFixed(2)} ~ 9 mm`);
  const cx = (cb.min[0] + cb.max[0]) / 2, cy = (cb.min[1] + cb.max[1]) / 2;
  assert(Math.abs(cx - tx) < 0.2 && Math.abs(cy - ty) < 0.2,
    `centered at (${cx.toFixed(2)}, ${cy.toFixed(2)}) ~ (${tx}, ${ty})`);
  const flat = bin3d.FOOT_BOT / 2 - 1.0;
  assert(cb.min[0] > tx - flat && cb.max[0] < tx + flat &&
    cb.min[1] > ty - flat && cb.max[1] < ty + flat,
    "text stays on the foot's flat bottom (clear of the chamfer)");
  const magRim = 13 - (magnets.r + magnets.chamfer);
  assert(cb.max[1] < ty + magRim - 0.5 && cb.min[1] > ty - magRim + 0.5,
    "text clears the magnet pocket rims by > 0.5 mm");

  // cut it and verify: valid, bbox unchanged, floor faces at z = 0.4
  const cut = bin3d.tryCut(oc, shape, cutter.wrapped, "deboss", log);
  assert(cut !== shape, "cut applied (no warning fallback): " + logs.join(" | "));
  assert(bin3d.isValid(oc, cut), "debossed solid is valid");
  const after = bin3d.bbox(oc, cut);
  for (let i = 0; i < 3; i++) {
    assert(Math.abs(after.dims[i] - before.dims[i]) < 1e-6,
      `bbox dim ${i} unchanged (${after.dims[i].toFixed(3)})`);
  }
  const at = (s, z) => {
    const m = bin3d.tessellate(oc, s);
    let n = 0;
    for (let i = 2; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i] - z) < 1e-6) n++;
    }
    return n;
  };
  assert(at(shape, deboss.DEBOSS_DEPTH) === 0, "plain bin has no z=0.4 facets");
  assert(at(cut, deboss.DEBOSS_DEPTH) > 20, "deboss floor facets present at z=0.4");

  // a debossed STEP for the reference-kernel re-import check (the spec
  // runs step_check.py on it when the PoC repo is present)
  const text = bin3d.writeStepText(oc, cut, { name: "deboss test bin" });
  fs.mkdirSync(path.join(APP, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(APP, "test-results", "deboss.step"), text);
  console.log("DEBOSS OK");
}
main();

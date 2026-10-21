// Round-tool cradle geometry gate (no oracle needed): a synthetic
// screwdriver outline (Ø10 shaft, Ø25 handle) built as a revolved cradle
// with the axis sub-flush, flush and proud; asserts validity, cradle
// depth, straight walls above a sub-flush axis, the proud opening, the
// 7 mm floor, and the negative body. Run from app/ via tests/run_cjs.sh.
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

/** closed outline: shaft r 5 (y -60…10, pointed tip), handle r 12.5
 *  (y 15…75, rounded ends), CCW */
function screwdriver() {
  const half = [];
  for (let y = -60; y <= 75; y += 0.25) {
    let w;
    if (y < -55) w = 5 * (y + 60) / 5; // the tip
    else if (y < 10) w = 5;
    else if (y < 15) w = 5 + 7.5 * (y - 10) / 5; // the ferrule flare
    else if (y < 70) w = 12.5;
    else w = Math.sqrt(Math.max(0, 12.5 ** 2 - ((y - 70) * 12.5 / 5) ** 2));
    half.push([Math.max(w, 0), y]);
  }
  const right = half.map(([w, y]) => [w, y]);
  const left = half.slice().reverse().map(([w, y]) => [-w, y]);
  return [...right, ...left].filter((p, i, a) =>
    i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
}

async function main() {
  const base = path.join(APP, "node_modules/replicad-opencascadejs/src");
  const factory = require(path.join(base, "replicad_single.js"));
  const oc = await (typeof factory === "function" ? factory : factory.default)(
    { locateFile: () => path.join(base, "replicad_single.wasm") });
  const bin3d = await import(pathToFileURL(path.join(APP, "src/bin3d.js")));
  const round = await import(pathToFileURL(path.join(APP, "src/round.js")));
  const sp = await import(pathToFileURL(path.join(APP, "src/smoothprof.js")));

  // material top of `shape` along the vertical line at (x, y): the
  // shape cut down to a 0.1 mm column, its bbox (-Infinity = none)
  const top = (shape, x, y) => {
    const box = new oc.BRepPrimAPI_MakeBox_4(new oc.gp_Pnt_3(x - 0.05, y - 0.05, -1),
      new oc.gp_Pnt_3(x + 0.05, y + 0.05, 200)).Shape();
    const op = new oc.BRepAlgoAPI_Common_3(shape, box, new oc.Message_ProgressRange_1());
    op.Build(new oc.Message_ProgressRange_1());
    const b = bin3d.bbox(oc, op.Shape());
    return b.max[2] > -1e10 && Number.isFinite(b.max[2]) ? b.max[2] : -Infinity;
  };
  const pts = screwdriver();
  const tck = sp.periodicFit(pts, 1e-9, 2.0);
  const mer = round.meridian(pts);
  const r = round.meridianR(mer);
  assert(Math.abs(r - 12.5) < 0.05, `meridian radius ${r.toFixed(3)} ~ 12.5`);
  assert(mer[0][0] === 0 && mer[mer.length - 1][0] === 0, "meridian ends on the axis");
  const opts = round.roundOptions(r);
  const center = [0, 7.5];
  const magnets = { r: 3.075, depth: 2.1, chamfer: 0.5 };

  for (const mode of ["sub", "flush", "proud"]) {
    const o = opts[mode];
    assert(o.ok, `${mode}: allowed (a ${o.a.toFixed(2)}, ${o.nz}u, depth ${o.depth.toFixed(2)})`);
    assert(o.H - o.depth >= 7 - 1e-9, `${mode}: floor ${(o.H - o.depth).toFixed(2)} >= 7 mm`);
    const logs = [];
    const { shape, H } = bin3d.buildBin(oc, [tck], true, 1, 4, o.nz, o.depth, {
      magnets, edgeStyle: "chamfer", edgeSize: 1.0, center, pocketPts: pts,
      round: { mer, axisZ: o.axisZ, a: o.a }, log: (l) => logs.push(l) });
    assert(bin3d.isValid(oc, shape), `${mode}: solid valid — ${logs.join(" | ")}`);
    assert(bin3d.tessellate(oc, shape).indices.length > 0, `${mode}: the preview mesh builds`);
    const want = o.axisZ - r;
    const zLow = top(shape, 0, 42);
    assert(Math.abs(zLow - want) < 0.05,
      `${mode}: cradle bottom z ${zLow.toFixed(2)} ~ ${want.toFixed(2)} (axis − r)`);
    // part way out: the cradle follows the circle, axis − √(r² − x²)
    const zMid = top(shape, 8, 42), wantMid = o.axisZ - Math.sqrt(r * r - 64);
    assert(Math.abs(zMid - wantMid) < 0.05 || (wantMid >= H && Math.abs(zMid - H) < 0.05),
      `${mode}: cradle at x = 8 z ${zMid.toFixed(2)} ~ ${Math.min(wantMid, H).toFixed(2)}`);
    assert(Math.abs(top(shape, 15, 42) - H) < 0.05, `${mode}: full height beside the pocket`);
    if (mode === "sub") {
      // just inside the widest point the cavity is open from the cradle
      // up through the rim: nothing above it
      const zIn = top(shape, 12.4, 42);
      assert(zIn < o.axisZ, `sub: straight walls above the axis (material top ${zIn.toFixed(2)} < axis ${o.axisZ.toFixed(2)})`);
    }
    if (mode === "proud") {
      const w = Math.sqrt(r * r - o.a * o.a);
      assert(top(shape, w - 0.2, 42) < H - 0.1 && Math.abs(top(shape, w + 0.2, 42) - H) < 0.05,
        `proud: opening half-width ~ √(r² − a²) = ${w.toFixed(2)}`);
    }
    const neg = bin3d.pocketBody(oc, [tck], true, H - o.depth, H,
      { mer, axisZ: o.axisZ, a: o.a });
    const nb = bin3d.bbox(oc, neg);
    assert(bin3d.isValid(oc, neg) && Math.abs(nb.max[2] - H) < 0.01 &&
      Math.abs(nb.min[2] - want) < 0.05,
      `${mode}: negative body valid, z ${nb.min[2].toFixed(2)}…${nb.max[2].toFixed(2)}`);
    if (mode === "sub") {
      const text = bin3d.writeStepText(oc, shape, { name: "round test bin" });
      fs.mkdirSync(path.join(APP, "test-results"), { recursive: true });
      fs.writeFileSync(path.join(APP, "test-results", "round.step"), text);
    }
  }

  // scoops never disturb the cradle (a scoop bounded by the smooth
  // outline once made the cut silently drop the cradle in flush mode)
  for (const mode of ["sub", "flush", "proud"]) {
    const o = opts[mode];
    const mk = (scoops) => bin3d.buildBin(oc, [tck], true, 1, 4, o.nz, o.depth, {
      center, pocketPts: pts, edgeStyle: "chamfer", edgeSize: 1.0, log: () => {},
      round: { mer, axisZ: o.axisZ, a: o.a, scoops, scoopR: 12.5 } }).shape;
    // a mirrored pair a hair apart, as the app gives it: ONE slot across
    const withS = mk([[-12.45, 42], [12.5, 42.02]]), noS = mk([]);
    const a1 = top(withS, 0, -20), a0 = top(noS, 0, -20);
    assert(Math.abs(a1 - a0) < 0.01, `${mode}: scoops leave the shaft cradle alone (${a1.toFixed(2)} = ${a0.toFixed(2)})`);
    const want = o.H - o.depth + 0.5;
    for (const x of [12.5, 0, -6]) { // at the scoop, under the axis, across
      const zs = top(withS, x, 42);
      // nothing stands above the slot floor (the cradle may dip deeper)
      assert(zs < want + 0.05 && zs > want - 1,
        `${mode}: finger slot at x = ${x}: material top z ${zs.toFixed(2)} <= ${want.toFixed(2)}`);
    }
  }

  // scoops: cut to the full depth, beside the handle
  {
    const o = opts.sub, logs = [];
    const scoops = [[-12.5, 42], [12.5, 42]];
    const { shape, H } = bin3d.buildBin(oc, [tck], true, 1, 4, o.nz, o.depth, {
      center, pocketPts: pts, log: (l) => logs.push(l),
      round: { mer, axisZ: o.axisZ, a: o.a, scoops, scoopR: 10 } });
    assert(bin3d.isValid(oc, shape), "scoops: solid valid");
    // inside the outline near its edge (the synthetic outline has no
    // scoop lobes): the cradle alone would leave z ~ 16.6 here
    const zs = top(shape, 11, 42), floorZ = H - o.depth + 0.5; // SCOOP_LIFT
    assert(Math.abs(zs - floorZ) < 0.05,
      `scoops: full depth beside the handle (z ${zs.toFixed(2)} ~ ${floorZ.toFixed(2)})`);
    // the preview mesher choked on a scoop floor tangent to the cradle
    const m = bin3d.tessellate(oc, shape);
    assert(m.indices.length > 0, "scoops: the preview mesh builds");
  }
  // finger scoop fillet + rim chamfer around the slots (owner bug
  // 2026-10-21: both were sharp in round mode). The slot outline's own
  // fillet arcs say where: just inside an arc is slot (down to its
  // floor), just outside is the rim chamfer (H − 1 + d at d mm out).
  for (const mode of ["sub", "flush"]) {
    const o = opts[mode], logs = [];
    const R = 6, blend = 6;
    const { shape, H } = bin3d.buildBin(oc, [tck], true, 1, 4, o.nz, o.depth, {
      center, pocketPts: pts, edgeStyle: "chamfer", edgeSize: 1.0, magnets,
      log: (l) => logs.push(l),
      round: { mer, axisZ: o.axisZ, a: o.a, scoops: [[-11, 42], [11, 42]], scoopR: R, blend } });
    assert(bin3d.isValid(oc, shape) && logs.some((l) => /6\.0 mm fillet at the walls/.test(l)),
      `${mode}: filleted finger slot valid — ${logs.filter((l) => /slot/.test(l)).join(" | ")}`);
    assert(bin3d.tessellate(oc, shape).indices.length > 0, `${mode}: filleted slot mesh builds`);
    if (mode === "sub") {
      fs.writeFileSync(path.join(APP, "test-results", "round-scoops.step"),
        bin3d.writeStepText(oc, shape, { name: "round scoops test bin" }));
    }
    const chain = bin3d.slotOutline(bin3d.cradlePlan(mer), 11, 42, R, blend);
    const arcs = chain.filter((e) => e.type === "arc");
    assert(arcs.filter((e) => !e.convex).length === 4, `${mode}: four fillet arcs`);
    const floorZ = H - o.depth + 0.5;
    for (const e of arcs) {
      const M = [e.c[0] + e.md[0] * e.r, e.c[1] + e.md[1] * e.r];
      const n = e.convex ? e.md : [-e.md[0], -e.md[1]]; // toward the material
      const at = (d) => top(shape, M[0] + n[0] * d, M[1] + n[1] * d);
      const zin = at(-0.3), zc = at(0.5), zo = at(2);
      const tag = `${mode}: ${e.convex ? "scoop" : "fillet"} arc at (${M[0].toFixed(1)}, ${M[1].toFixed(1)})`;
      assert(Math.abs(zin - floorZ) < 0.05, `${tag}: slot inside, z ${zin.toFixed(2)} ~ ${floorZ.toFixed(2)}`);
      assert(Math.abs(zc - (H - 0.45)) < 0.06, `${tag}: rim chamfer 0.5 mm out, z ${zc.toFixed(2)} ~ ${(H - 0.45).toFixed(2)}`);
      assert(Math.abs(zo - H) < 0.01, `${tag}: full height 2 mm out`);
    }
  }
  console.log("ROUND OK");
}
main();

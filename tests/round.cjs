// Round-tool cradle geometry gate (no oracle needed): a synthetic
// screwdriver outline (Ø10 shaft, Ø25 handle) built as a revolved cradle
// with the axis Tool flush ("sub") and flush (owner 2026-10-21: never
// proud); asserts validity, cradle depth, straight walls above the axis,
// the 7 mm floor, the negative body, and the finger slots' fillets and
// rim chamfer — all the way round the rim, so nothing stands up at the
// junctions. Run from app/ via tests/run_cjs.sh.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = process.cwd();
// one axis mode only ("sub" | "flush" after --): round.spec.js runs the
// two halves in parallel (all of it took ~5 min)
const ONLY = process.argv.find((a) => a === "sub" || a === "flush");
const MODES = ONLY ? [ONLY] : ["sub", "flush"];

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
    try {
      const p0 = new oc.gp_Pnt_3(x - 0.05, y - 0.05, -1);
      const p1 = new oc.gp_Pnt_3(x + 0.05, y + 0.05, 200);
      const mb = new oc.BRepPrimAPI_MakeBox_4(p0, p1);
      const pr = new oc.Message_ProgressRange_1();
      const op = new oc.BRepAlgoAPI_Common_3(shape, mb.Shape(), pr);
      op.Build(new oc.Message_ProgressRange_1());
      const res = op.Shape();
      const b = bin3d.bbox(oc, res);
      // free it all: ~1000 probes per run ran the wasm heap out
      res.delete(); op.delete(); pr.delete(); mb.delete(); p0.delete(); p1.delete();
      return b.max[2] > -1e10 && Number.isFinite(b.max[2]) ? b.max[2] : -Infinity;
    } catch (e) {
      console.log(`probe threw at (${x.toFixed(2)}, ${y.toFixed(2)}): ${e}`);
      return NaN;
    }
  };
  const pts = screwdriver();
  const tck = sp.periodicFit(pts, 1e-9, 2.0);
  const mer = round.meridian(pts);
  const r = round.meridianR(mer);
  assert(Math.abs(r - 12.5) < 0.05, `meridian radius ${r.toFixed(3)} ~ 12.5`);
  assert(mer[0][0] === 0 && mer[mer.length - 1][0] === 0, "meridian ends on the axis");
  const opts = round.roundOptions(r);
  assert(Object.keys(opts).sort().join() === "flush,sub" && round.axisModeOf("proud") === "flush" &&
    round.axisModeOf("sub") === "sub" && round.axisModeOf(undefined) === "sub",
    "axis options: flush + tool flush only; an old proud design reopens as flush");
  const center = [0, 7.5];
  const magnets = { r: 3.075, depth: 2.1, chamfer: 0.5 };

  for (const mode of MODES) {
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
  for (const mode of MODES) {
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
  if (MODES.includes("sub")) {
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
  // finger slots in the plan above the axis (owner 2026-10-21: the first
  // fix left spikes standing at every fillet). Probe the WHOLE rim along
  // the plan outline U — 0.3 mm inside (open down to the axis, or the
  // flare's floor at an axis-flush rim), 0.5 mm out (the 45° chamfer
  // band), 2 mm out (full height) — densest round the slots, where the
  // spikes stood. Cases: handle slot (6 mm fillet, 2 and 10 too), a slot
  // across the ferrule step, a slot on the shaft; chamfer and fillet rims.
  const cases = [
    { tag: "handle 6", scoops: [[-11, 42], [11, 42]], R: 6, blend: 6 },
    { tag: "handle 2", scoops: [[-11, 42], [11, 42]], R: 6, blend: 2 },
    { tag: "handle 10", scoops: [[-11, 42], [11, 42]], R: 6, blend: 10 },
    { tag: "ferrule", scoops: [[-7, 12], [7, 12]], R: 7, blend: 4 },
    { tag: "shaft", scoops: [[-5, -20], [5, -20]], R: 9, blend: 4 },
  ];
  const t0 = Date.now();
  for (const mode of MODES) {
    for (const c of cases) {
      for (const edgeStyle of c.tag === "handle 6" ? ["chamfer", "fillet"] : ["chamfer"]) {
        const o = opts[mode], logs = [];
        const rnd = { mer, axisZ: o.axisZ, a: o.a, scoops: c.scoops, scoopR: c.R, blend: c.blend };
        const { shape, H } = bin3d.buildBin(oc, [tck], true, 1, 4, o.nz, o.depth, {
          center, pocketPts: pts, edgeStyle, edgeSize: 1.0, magnets,
          log: (l) => logs.push(l), round: rnd });
        const tag = `${mode} ${c.tag} ${edgeStyle}`;
        const plan = bin3d.roundPlan(rnd, 1.0);
        assert(bin3d.isValid(oc, shape) && !logs.some((l) => /WARNING/.test(l)),
          `${tag}: valid, slots ${plan.slots.map((s) => s.mode).join("/")} — ` +
          logs.filter((l) => /slot|entry/.test(l)).join(" | "));
        assert(plan.slots.every((s) => s.mode !== "full"), `${tag}: every slot filleted into the plan`);
        const mesh = bin3d.tessellate(oc, shape);
        let zMax = -Infinity;
        for (let i = 2; i < mesh.positions.length; i += 3) zMax = Math.max(zMax, mesh.positions[i]);
        assert(mesh.indices.length > 0 && zMax < H + 1e-6, `${tag}: mesh builds, top z ${zMax.toFixed(3)} <= ${H}`);
        if (mode === "sub" && c.tag === "handle 6" && edgeStyle === "chamfer") {
          fs.writeFileSync(path.join(APP, "test-results", "round-scoops.step"),
            bin3d.writeStepText(oc, shape, { name: "round scoops test bin" }));
        }
        // the ring: U sampled, outward normals (CCW: (dy, -dx))
        const poly = bin3d.planPoly(plan.chain);
        const near = (p) => c.scoops.some(([, sy]) => Math.abs(p[1] - sy) < c.R + c.blend + 4);
        // just inside U: open to the axis (walls), or round a slot down
        // to its floor (no step under a fillet, at the axis or the rim)
        const floorZ = H - o.depth + 0.5;
        const inSlot = (p) => plan.slots.some((sl) => sl.run &&
          p[1] > sl.run.bot.T[1] - 0.1 && p[1] < sl.run.top.T[1] + 0.1);
        const inZOf = (p) => inSlot(p) ? floorZ : mode === "sub" ? o.axisZ : H - 1;
        let n = 0, worst = { d: 0 };
        let acc = 0;
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i], b = poly[(i + 1) % poly.length];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          acc += L;
          const step = near(a) ? 0.5 : 4;
          if (acc < step || L < 1e-6) continue;
          acc = 0;
          if (Math.abs(a[0]) < 2.5) continue; // the pointed ends: capped miter
          const nx = (b[1] - a[1]) / L, ny = -(b[0] - a[0]) / L;
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          const at = (d) => top(shape, m[0] + nx * d, m[1] + ny * d);
          const zi = at(-0.3), zc = at(0.5), zo = at(2);
          const wantC = edgeStyle === "fillet" ? H - 0.134 : H - 0.5;
          const inZ = inZOf(m);
          const errs = [zi - inZ, Math.abs(zc - wantC) - 0.1, Math.abs(zo - H) - 0.01];
          const d = Math.max(...errs);
          if (d > worst.d) worst = { d, at: m.map((v) => +v.toFixed(2)), zi, zc, zo };
          n++;
        }
        assert(worst.d <= 0.06, `${tag}: rim clean at ${n} probes (worst ${JSON.stringify(worst)})`);
      }
    }
  }
  console.log(`slot cases: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log("ROUND OK");
}
main();

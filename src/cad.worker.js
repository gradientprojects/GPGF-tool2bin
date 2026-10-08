// Web Worker: owns the OpenCASCADE WASM instance; all CAD runs off the
// main thread. C5: full Gridfinity bin build from the profile stage's
// splines (src/bin3d.js drives the raw kernel), preview tessellation,
// STEP export with embedded design JSON.
import { expose } from "comlink";
import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox } from "replicad";
import {
  buildBin, tessellate, bbox, writeStepText, tryCut, pocketBody,
} from "./bin3d.js";
import { ensureDebossFont, debossCutter } from "./deboss.js";
import debossFontUrl from "./assets/t2b-rev-bold.ttf?url";

let ready = null;
let ocInstance = null;
function init() {
  if (!ready) {
    ready = opencascade({ locateFile: () => opencascadeWasm }).then((oc) => {
      ocInstance = oc;
      setOC(oc);
      return oc;
    });
  }
  return ready;
}

async function helloStep() {
  await init();
  const box = makeBaseBox(42, 42, 7); // one Gridfinity unit footprint, why not
  const blob = box.blobSTEP();
  const head = (await blob.slice(0, 64).text()).trim();
  return { bytes: blob.size, head };
}

let lastBuild = null; // { shape, depth, H, profile, params }

/** profile: the cv-worker profile result (segs/periodic/layout/center/
 *  pocketPts); params: UI params (thickness, magnets, edge). */
async function build(profile, params) {
  const oc = await init();
  const logs = [];
  const t0 = performance.now();
  if (lastBuild && lastBuild.shape) lastBuild.shape.delete();
  const magnets = params.magnets && params.magnets.enabled
    ? { r: +params.magnets.r, depth: +params.magnets.depth,
        chamfer: +params.magnets.chamfer }
    : null;
  const edge = params.edge || {};
  let { shape, depth, H } = buildBin(oc, profile.segs, profile.periodic,
    profile.layout.nx, profile.layout.ny, profile.layout.nz,
    profile.layout.depth, {
      magnets, edgeStyle: edge.style || null, edgeSize: +(edge.size || 0),
      center: profile.center, pocketPts: profile.pocketPts,
      log: (l) => logs.push(l),
    });
  if (!params.deboss || params.deboss.enabled) {
    const rev = Math.max(1, Math.trunc(+params.rev || 1));
    const text = "R" + String(rev).padStart(2, "0");
    try {
      await ensureDebossFont(fetch(debossFontUrl).then((r) => r.arrayBuffer()));
      const cutter = debossCutter(text, profile.layout.nx, profile.layout.ny,
        profile.center);
      shape = tryCut(oc, shape, cutter.wrapped,
        `rev deboss '${text}' (0.4 mm, underside)`, (l) => logs.push(l));
    } catch (err) {
      logs.push(`WARNING: rev deboss skipped (${err})`);
    }
  }
  lastBuild = { shape, depth, H, profile, params };
  const mesh = tessellate(oc, shape);
  const bb = bbox(oc, shape);
  return {
    ok: true, depth, H, bbox: bb, logs,
    mesh: {
      positions: Float32Array.from(mesh.positions),
      indices: Uint32Array.from(mesh.indices),
    },
    ms: Math.round(performance.now() - t0),
  };
}

async function exportStep(name, rev = 1, label = null, negative = false) {
  const oc = await init();
  if (!lastBuild) throw new Error("no bin built yet");
  const design = {
    name, rev, source: "gpgf-tool2bin",
    params: lastBuild.params,
    layout: lastBuild.profile.layout,
    contour: lastBuild.profile.contour || null,
  };
  const text = writeStepText(oc, lastBuild.shape,
    { name: label || `${name} bin`, design });
  let negText = null;
  if (negative) {
    const { segs, periodic } = lastBuild.profile;
    const body = pocketBody(oc, segs, periodic, lastBuild.H - lastBuild.depth,
      lastBuild.H);
    negText = writeStepText(oc, body,
      { name: `${label || name} negative` });
    body.delete();
  }
  return { ok: true, text, bytes: text.length, negText };
}

expose({ helloStep, build, exportStep });

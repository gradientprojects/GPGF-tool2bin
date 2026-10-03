// Web Worker: owns the OpenCASCADE WASM instance; all CAD runs off the main
// thread. C1 scope: prove the kernel works end-to-end by building a box and
// exporting a real STEP.
import { expose } from "comlink";
import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import { setOC, makeBaseBox } from "replicad";

let ready = null;
function init() {
  if (!ready) {
    ready = opencascade({ locateFile: () => opencascadeWasm }).then((oc) => setOC(oc));
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

expose({ helloStep });

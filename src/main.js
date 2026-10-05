import { wrap } from "comlink";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// results Playwright asserts on
window.__selftest = { cad: null, cv: null };
window.__warp = null;
window.__contour = null;
window.__profile = null;
window.__bin = null;

// one CAD worker for the whole app (comlink)
const cadApi = wrap(new Worker(new URL("./cad.worker.js", import.meta.url),
  { type: "module" }));

function setCheck(id, ok, text) {
  const el = document.getElementById(id);
  el.classList.remove("ok", "bad");
  el.classList.add(ok ? "ok" : "bad");
  el.querySelector(".st").textContent = text;
}

// one CV worker for the whole app; promise-per-request over reqId
const cvWorker = new Worker(new URL("./cv.worker.js", import.meta.url),
  { type: "module" });
let nextReq = 1;
const pending = new Map();
cvWorker.onmessage = (e) => {
  const p = pending.get(e.data.reqId);
  if (p) { pending.delete(e.data.reqId); p.resolve(e.data); }
};
cvWorker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message));
  pending.clear();
};
function cvRequest(msg, transfer = [], timeoutMs = 120000) {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`cv worker timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    pending.set(reqId, {
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (err) => { clearTimeout(to); reject(err); },
    });
    cvWorker.postMessage({ reqId, ...msg }, transfer);
  });
}

async function fileToImageData(fileOrBlob) {
  // from-image: apply the photo's EXIF orientation like the camera intended
  const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const cnv = document.createElement("canvas");
  cnv.width = bmp.width; cnv.height = bmp.height;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return id;
}

async function cadCheck() {
  try {
    const api = cadApi;
    const t0 = performance.now();
    const r = await api.helloStep();
    const ok = r.head.startsWith("ISO-10303-21");
    window.__selftest.cad = { ok, ...r };
    setCheck("check-cad", ok,
      ok ? `STEP export OK (${(r.bytes / 1024).toFixed(1)} KB in ${((performance.now() - t0) / 1000).toFixed(1)}s)`
         : `bad STEP header: ${r.head.slice(0, 24)}`);
  } catch (e) {
    window.__selftest.cad = { ok: false, error: String(e) };
    setCheck("check-cad", false, String(e));
  }
}

async function cvCheck() {
  try {
    const resp = await fetch("fixtures/synthetic-letter.png");
    const imageData = await fileToImageData(await resp.blob());
    const result = await cvRequest({ type: "selftest", imageData },
      [imageData.data.buffer]);
    window.__selftest.cv = result;
    if (!result.ok) { setCheck("check-cv", false, result.error || "failed"); return; }
    const missing = Object.entries(result.caps).filter(([, v]) => !v).map(([k]) => k);
    document.getElementById("caps").textContent =
      (result.build ? result.build + "\n" : "") +
      (missing.length ? `missing: ${missing.join(", ")}\n` : "") +
      (result.error ? `aruco error: ${result.error}\n` : "");
    const n = result.aruco.ids.length;
    setCheck("check-cv", result.aruco.supported && n >= 6,
      result.aruco.supported ? `ArUco: ${n}/24 markers on the synthetic template`
        : "ArUco NOT exposed by this opencv.js build");
  } catch (e) {
    window.__selftest.cv = { ok: false, error: String(e) };
    setCheck("check-cv", false, String(e));
  }
}

// ---- scan: photo -> warp preview -------------------------------------------
const scanStatus = document.getElementById("scan-status");
const previewCnv = document.getElementById("warp-preview");

function drawContourOverlay(contourPx, warpSize) {
  const ctx = previewCnv.getContext("2d");
  const s = previewCnv.width / warpSize[0];
  ctx.strokeStyle = "#ff4d8d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  contourPx.forEach(([x, y], i) => {
    if (i === 0) ctx.moveTo(x * s, y * s); else ctx.lineTo(x * s, y * s);
  });
  ctx.closePath();
  ctx.stroke();
}

async function scanPhoto(file) {
  if (!file || !file.type.startsWith("image/")) {
    scanStatus.textContent = "that is not an image file"; return;
  }
  scanStatus.textContent = "reading photo…";
  window.__warp = null;
  window.__contour = null;
  window.__profile = null;
  window.__bin = null;
  binName.value = file.name.replace(/\.[^.]+$/, "");
  designRev = 1;
  try {
    const imageData = await fileToImageData(file);
    // adaptive resolution: phones get 12 px/mm (4x less work and memory
    // than the reference 20); parity suites always pass 20 explicitly
    const mobile = matchMedia("(max-width: 800px)").matches ||
      (navigator.userAgentData && navigator.userAgentData.mobile);
    const pxmm = mobile ? 12 : 20;
    scanStatus.textContent =
      `detecting (${imageData.width}×${imageData.height}, ${pxmm} px/mm)…`;
    const r = await cvRequest({ type: "warp", imageData, paper: "letter", pxmm },
      [imageData.data.buffer]);
    if (!r.ok) throw new Error(r.error);
    window.__warp = { ...r, preview: undefined };
    const ctx = previewCnv.getContext("2d");
    previewCnv.width = r.preview.width; previewCnv.height = r.preview.height;
    ctx.putImageData(r.preview, 0, 0);
    previewCnv.style.display = "block";
    const warpLine = r.mode === "template"
      ? `template '${r.page}': ${r.nMarkers} markers, ` +
        `${r.inliers}/${r.total} corner inliers (${(r.ms / 1000).toFixed(1)}s)`
      : `plain paper ${r.pageMm[0]}×${r.pageMm[1]} mm, ` +
        `skew ${(r.skew * 100).toFixed(1)}% (${(r.ms / 1000).toFixed(1)}s)`;
    scanStatus.textContent = warpLine + " — segmenting…";
    const r2 = await cvRequest({ type: "contour" }, [], 600000);
    if (!r2.ok) throw new Error(r2.error);
    window.__contour = r2;
    drawContourOverlay(r2.contourPx, r.warpSize);
    const bb = r2.contourMm.reduce((m, [x, y]) => [
      Math.min(m[0], x), Math.min(m[1], y), Math.max(m[2], x), Math.max(m[3], y),
    ], [Infinity, Infinity, -Infinity, -Infinity]);
    scanStatus.textContent = warpLine +
      ` — tool ${(bb[2] - bb[0]).toFixed(1)}×${(bb[3] - bb[1]).toFixed(1)} mm, ` +
      `${r2.areaMm2.toFixed(0)} mm², symmetry IoU ${r2.iou.toFixed(3)} ` +
      `(${(r2.ms / 1000).toFixed(1)}s)`;
    await runProfile();
  } catch (e) {
    if (!window.__warp) window.__warp = { ok: false, error: String(e) };
    window.__contour = { ok: false, error: String(e) };
    scanStatus.textContent = "error: " + e.message;
  }
}

// ---- pocket profile (stages 4-5) -------------------------------------------
const profileSec = document.getElementById("pocket");
const profileStatus = document.getElementById("profile-status");
const profileCnv = document.getElementById("profile-view");
const optMax = document.getElementById("opt-max-contour");
const optStrict = document.getElementById("opt-strict");

function drawProfile(toolMm, r) {
  const ctx = profileCnv.getContext("2d");
  const Wc = profileCnv.width, Hc = profileCnv.height;
  ctx.clearRect(0, 0, Wc, Hc);
  const all = [...toolMm, ...r.pocketPts];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of all) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const s = Math.min(Wc / (x1 - x0 + 10), Hc / (y1 - y0 + 10));
  const tx = (x) => (x - (x0 + x1) / 2) * s + Wc / 2;
  const ty = (y) => Hc / 2 - (y - (y0 + y1) / 2) * s; // +Y up
  const poly = (pts, stroke, fill) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(tx(x), ty(y)); else ctx.lineTo(tx(x), ty(y));
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  };
  poly(r.pocketPts, "#ff7a30", "rgba(255,122,48,0.12)");
  poly(toolMm, "#9aa7b5", "rgba(154,167,181,0.25)");
  for (const [sx, sy] of r.scallops) {
    ctx.beginPath();
    ctx.arc(tx(sx), ty(sy), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#4da3ff"; ctx.fill();
  }
}

const sliders = {};
for (const [id, label] of [["clearance", "v-clearance"], ["smooth", "v-smooth"],
                           ["scallop", "v-scallop"], ["wall", "v-wall"]]) {
  const el = document.getElementById(`sl-${id}`);
  const lbl = document.getElementById(label);
  el.addEventListener("input", () => { lbl.textContent = el.value; });
  el.addEventListener("change", () => runProfile());
  sliders[id] = el;
}
const optSymmetric = document.getElementById("opt-symmetric");
optSymmetric.addEventListener("change", () => runProfile());

function currentParams() {
  return {
    thickness: +binThickness.value || 25,
    clearance: +sliders.clearance.value,
    smooth_r: +sliders.smooth.value,
    scallop_d: +sliders.scallop.value,
    scallop_blend: 4.0,
    min_wall: +sliders.wall.value,
    symmetric: optSymmetric.checked,
    max_contour: optMax.checked,
    strict_contain: optStrict.checked,
    magnets: { enabled: optMagnets.checked,
               r: 3.075, depth: 2.1, chamfer: 0.5 },
    edge: optEdge.value ? { style: optEdge.value, size: 1.0 } : {},
  };
}

async function runProfile() {
  const cres = window.__contour;
  if (!cres || !cres.ok) return;
  profileSec.style.display = "block";
  profileStatus.textContent = "fitting pocket profile…";
  try {
    const params = currentParams();
    const msg = { type: "profile", params };
    if (cres.fromStep) msg.contourMm = cres.contourMm;
    const r = await cvRequest(msg, [], 600000);
    if (!r.ok) throw new Error(r.error);
    window.__profile = { ...r, params };
    drawProfile(cres.contourMm, r);
    const L = r.layout;
    profileStatus.textContent =
      `bin ${L.nx}×${L.ny}×${L.nz}u (${(L.nx * 42 - 0.5).toFixed(1)}×` +
      `${(L.ny * 42 - 0.5).toFixed(1)}×${L.H} mm), pocket depth ${L.depth} mm` +
      (r.warnings.length ? ` — ⚠ ${r.warnings.join("; ")}` : "") +
      ` (${(r.ms / 1000).toFixed(1)}s)`;
    await runBuild();
  } catch (e) {
    window.__profile = { ok: false, error: String(e) };
    profileStatus.textContent = "error: " + e.message;
  }
}
optMax.addEventListener("change", runProfile);
optStrict.addEventListener("change", runProfile);

// ---- bin build + 3D preview + export ---------------------------------------
const binSec = document.getElementById("bin");
const binStatus = document.getElementById("bin-status");
const binName = document.getElementById("bin-name");
const binPrefix = document.getElementById("bin-prefix");

// filename prefix: per-device convenience, editable, default GPGF-t2b
try { binPrefix.value = localStorage.getItem("t2b.prefix") ?? "GPGF-t2b"; }
catch { binPrefix.value = "GPGF-t2b"; }
binPrefix.addEventListener("change", () => {
  try { localStorage.setItem("t2b.prefix", binPrefix.value); } catch {}
});

// revision: R01 for a fresh scan, uprevs when a STEP is dropped back in
let designRev = 1;
const binThickness = document.getElementById("bin-thickness");
const optMagnets = document.getElementById("opt-magnets");
const optDeboss = document.getElementById("opt-deboss");
const optEdge = document.getElementById("opt-edge");
const exportBtn = document.getElementById("export-step");

let three = null;
function threeView() {
  if (three) return three;
  const canvas = document.getElementById("bin-view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(1, -1.2, 1.8);
  scene.add(dir);
  const controls = new OrbitControls(cam, canvas);
  controls.addEventListener("change", () => renderer.render(scene, cam));
  three = { renderer, scene, cam, controls, mesh: null };
  return three;
}

function showMesh(positions, indices, size) {
  const t = threeView();
  if (t.mesh) { t.scene.remove(t.mesh); t.mesh.geometry.dispose(); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff7a30, metalness: 0.05, roughness: 0.65,
    flatShading: false, side: THREE.DoubleSide,
  });
  t.mesh = new THREE.Mesh(geo, mat);
  t.scene.add(t.mesh);
  const canvas = t.renderer.domElement;
  const m = Math.max(size[0], size[1], size[2]) * 0.72;
  const aspect = canvas.clientWidth / canvas.clientHeight || 4 / 3;
  Object.assign(t.cam, { left: -m * aspect, right: m * aspect, top: m, bottom: -m });
  t.cam.position.set(m, -m, m);
  t.cam.up.set(0, 0, 1);
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  t.cam.lookAt(c);
  t.controls.target.copy(c);
  t.cam.updateProjectionMatrix();
  t.renderer.setSize(canvas.clientWidth || 560, canvas.clientHeight || 420, false);
  t.renderer.render(t.scene, t.cam);
}

async function runBuild() {
  const p = window.__profile;
  if (!p || !p.ok) return;
  binSec.style.display = "block";
  exportBtn.disabled = true;
  binStatus.textContent = "building bin solid…";
  try {
    // the tool contour rides into the STEP's embedded design so an
    // exported file can be revised without the photo
    const tool = window.__contour.contourMm;
    const stride = Math.max(1, Math.ceil(tool.length / 1500));
    const contour = [];
    for (let i = 0; i < tool.length; i += stride) {
      contour.push([Math.round(tool[i][0] * 1000) / 1000,
                    Math.round(tool[i][1] * 1000) / 1000]);
    }
    // rev + deboss are injected at build time: the rev isn't a profile
    // param, and the deboss toggle must not force a profile re-fit
    const r = await cadApi.build(
      { segs: p.segs, periodic: p.periodic, layout: p.layout,
        center: p.center, pocketPts: p.pocketPts, contour },
      { ...p.params, rev: designRev,
        deboss: { enabled: optDeboss.checked } });
    window.__bin = { ok: r.ok, depth: r.depth, H: r.H, bbox: r.bbox,
      logs: r.logs, ms: r.ms };
    showMesh(r.mesh.positions, r.mesh.indices, r.bbox.dims);
    binStatus.textContent =
      `solid ${r.bbox.dims.map((v) => v.toFixed(1)).join("×")} mm, ` +
      `pocket depth ${r.depth} mm (${(r.ms / 1000).toFixed(1)}s)`;
    exportBtn.disabled = false;
  } catch (e) {
    window.__bin = { ok: false, error: String(e) };
    binStatus.textContent = "error: " + (e.message || e);
  }
}
binThickness.addEventListener("change", runProfile);
optMagnets.addEventListener("change", runProfile);
optDeboss.addEventListener("change", runBuild);
optEdge.addEventListener("change", runProfile);

// spaces are fine in filenames; strip only what filesystems reject
const cleanName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-")
  .replace(/\s+/g, " ").trim();

exportBtn.addEventListener("click", async () => {
  const p = window.__profile;
  if (!p || !p.ok) return;
  const name = cleanName(binName.value) || "tool";
  const prefix = cleanName(binPrefix.value);
  const L = p.layout;
  try {
    binStatus.textContent = "writing STEP…";
    const stem = `${prefix ? prefix + " " : ""}${name} - ` +
      `${L.nx}X${L.ny}Y${L.nz}Z R${String(designRev).padStart(2, "0")}`;
    const r = await cadApi.exportStep(name, designRev, stem);
    const fname = `${stem}.step`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.text], { type: "application/step" }));
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    binStatus.textContent = `exported ${fname} (${(r.bytes / 1024).toFixed(0)} KB)`;
  } catch (e) {
    binStatus.textContent = "export error: " + (e.message || e);
  }
});

// parity-suite hook: run stages 2+3 on an injected warp canvas (a
// losslessly-dumped reference warp), bypassing stage 1 entirely.
window.__segmentWarp = async (blob, field) => {
  const imageData = await fileToImageData(blob);
  return cvRequest({ type: "contour", imageData, field },
    [imageData.data.buffer], 600000);
};
// parity hook for stages 4-5 on an injected oriented contour
window.__profileRun = (contourMm, params) =>
  cvRequest({ type: "profile", contourMm, params }, [], 600000);

// drop an exported STEP back in: revise its embedded design, no photo
async function reviseFromStep(file) {
  scanStatus.textContent = "reading STEP design…";
  try {
    const text = await file.text();
    const m = [...text.matchAll(/\/\* S2S\| (.*?) \*\//gs)].map((x) => x[1]);
    if (!m.length) throw new Error("no Tool2Bin design found in this STEP");
    const design = JSON.parse(m.join(""));
    if (!design.contour) throw new Error("design has no contour (old export?)");
    window.__warp = null;
    window.__contour = { ok: true, contourMm: design.contour, fromStep: true };
    binName.value = design.name || "tool";
    designRev = (design.rev || 1) + 1;
    const p = design.params || {};
    if (p.thickness) binThickness.value = p.thickness;
    if (p.clearance != null) sliders.clearance.value = p.clearance;
    if (p.smooth_r != null) sliders.smooth.value = p.smooth_r;
    if (p.scallop_d != null) sliders.scallop.value = p.scallop_d;
    if (p.min_wall != null) sliders.wall.value = p.min_wall;
    optSymmetric.checked = p.symmetric !== false;
    optMagnets.checked = !!(p.magnets && p.magnets.enabled);
    optDeboss.checked = !(p.deboss && p.deboss.enabled === false);
    optEdge.value = (p.edge && p.edge.style) || "";
    scanStatus.textContent = `revising '${design.name}' from its embedded ` +
      `design (next export is R${String(designRev).padStart(2, "0")})`;
    await runProfile();
  } catch (e) {
    scanStatus.textContent = "error: " + e.message;
  }
}

function handleFile(file) {
  if (!file) return;
  if (/\.ste?p$/i.test(file.name)) return reviseFromStep(file);
  return scanPhoto(file);
}

document.getElementById("photo").addEventListener("change",
  (e) => handleFile(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

// PWA: cache-on-fetch service worker -> works offline after first load
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

cadCheck();
cvCheck();

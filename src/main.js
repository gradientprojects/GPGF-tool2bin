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
  if (!p) return;
  if (e.data.progress) {
    if (p.onProgress) p.onProgress(e.data);
    return;
  }
  pending.delete(e.data.reqId);
  p.resolve(e.data);
};
cvWorker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message));
  pending.clear();
};
function cvRequest(msg, transfer = [], timeoutMs = 120000, onProgress = null) {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      pending.delete(reqId);
      reject(new Error(`cv worker timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    pending.set(reqId, {
      onProgress,
      resolve: (v) => { clearTimeout(to); resolve(v); },
      reject: (err) => { clearTimeout(to); reject(err); },
    });
    cvWorker.postMessage({ reqId, ...msg }, transfer);
  });
}

async function fileToImageData(fileOrBlob, maxEdge = 4096) {
  // from-image: apply the photo's EXIF orientation like the camera
  // intended. Long edge capped at 4096 px: phone cameras shoot
  // 12-48 MP, which blows past iOS Safari's ~16 MP canvas ceiling
  // (blank getImageData / crash) and multiplies every CV pass for
  // detail the warp resamples away anyway. 4096 passes the reference
  // corpus photos (4032 px) through untouched, keeping parity exact.
  const bmp = await createImageBitmap(fileOrBlob, { imageOrientation: "from-image" });
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const cnv = document.createElement("canvas");
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
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
const paneWarp = document.getElementById("pane-warp");
const paneProfile = document.getElementById("pane-profile");
const paneBin = document.getElementById("pane-bin");

/** in-progress status: message + progress bar + elapsed seconds. The
 *  bar cycles until the returned updater reports a real fraction, then
 *  turns determinate. Any later plain `.textContent =` write clears
 *  the bar (and the ticker notices and stops itself). */
function busyStatus(el, msg) {
  el.textContent = msg;
  const label = el.firstChild; // the text node
  const secs = document.createElement("span");
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  el.append(secs, bar);
  const t0 = Date.now();
  const tick = setInterval(() => {
    if (!el.contains(bar)) { clearInterval(tick); return; }
    secs.textContent = ` ${Math.round((Date.now() - t0) / 1000)} s`;
  }, 1000);
  return (frac, stage) => {
    if (!el.contains(bar)) return;
    fill.style.animation = "none";
    fill.style.width = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%`;
    label.nodeValue = stage ? `${msg} ${stage}, ${Math.round(frac * 100)}%` : msg;
  };
}

// plain-paper size: sets the mm scale of the fallback (template mode
// auto-detects its page); per-device convenience like the prefix
const optPaper = document.getElementById("opt-paper");
try { optPaper.value = localStorage.getItem("t2b.paper") ?? "letter"; }
catch { optPaper.value = "letter"; }
optPaper.addEventListener("change", () => {
  try { localStorage.setItem("t2b.paper", optPaper.value); } catch {}
});
const optFine = document.getElementById("opt-fine");

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
  busyStatus(scanStatus, "reading photo…");
  window.__warp = null;
  window.__contour = null;
  window.__profile = null;
  window.__bin = null;
  customScallops = null; // fresh tool, fresh auto-placement
  if (three) three.placed = false; // new design: reframe the 3D view
  designRev = 1;
  try {
    const imageData = await fileToImageData(file);
    // 12 px/mm (~300 dpi) everywhere: the reference's 20 costs ~3x the
    // wasm time for detail beyond what a printed bin can use. Parity
    // suites pass 20 explicitly; the "fine detail" toggle restores it.
    const pxmm = optFine.checked ? 20 : 12;
    const prog = busyStatus(scanStatus,
      `detecting (${imageData.width}×${imageData.height}, ${pxmm} px/mm)…`);
    const r = await cvRequest(
      { type: "warp", imageData, paper: optPaper.value, pxmm },
      [imageData.data.buffer], 120000, (p) => prog(p.frac, p.stage));
    if (!r.ok) throw new Error(r.error);
    window.__warp = { ...r, preview: undefined };
    const ctx = previewCnv.getContext("2d");
    previewCnv.width = r.preview.width; previewCnv.height = r.preview.height;
    ctx.putImageData(r.preview, 0, 0);
    paneWarp.style.display = "block";
    const warpLine = r.mode === "template"
      ? `template '${r.page}': ${r.nMarkers} markers, ` +
        `${r.inliers}/${r.total} corner inliers (${(r.ms / 1000).toFixed(1)}s)`
      : `plain paper ${r.pageMm[0]}×${r.pageMm[1]} mm, ` +
        `skew ${(r.skew * 100).toFixed(1)}% (${(r.ms / 1000).toFixed(1)}s)`;
    const prog2 = busyStatus(scanStatus, warpLine + " —");
    const r2 = await cvRequest({ type: "contour" }, [], 600000,
      (p) => prog2(p.frac, p.stage));
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

let lastProfileDraw = null; // redrawn on resize at the new display size
let profView = null;        // mm<->canvas transform of the last draw
let customScallops = null;  // user-dragged scallop centers (worker override)
let dragIdx = -1, dragScallops = null; // in-progress drag
function drawProfile(toolMm, r) {
  lastProfileDraw = [toolMm, r];
  // backing resolution follows the CSS display box, sharp on hidpi
  const dpr = window.devicePixelRatio || 1;
  const cw = profileCnv.clientWidth || 560;
  const ch = profileCnv.clientHeight || Math.round(cw * 0.75);
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  if (profileCnv.width !== W || profileCnv.height !== H) {
    profileCnv.width = W; profileCnv.height = H;
  }
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
  profView = { s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, Wc, Hc };
  const poly = (pts, stroke, fill) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(tx(x), ty(y)); else ctx.lineTo(tx(x), ty(y));
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
  };
  poly(r.pocketPts, "#ff7a30", "rgba(255,122,48,0.12)");
  poly(toolMm, "#9aa7b5", "rgba(154,167,181,0.25)");
  const scallopD = +sliders.scallop.value;
  const dots = dragScallops || r.scallops;
  if (scallopD > 0 && dots) dots.forEach(([sx, sy], i) => {
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.arc(tx(sx), ty(sy), (scallopD / 2) * s, 0, Math.PI * 2);
    ctx.strokeStyle = dragIdx === i ? "#8ec5ff" : "rgba(77,163,255,0.6)";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tx(sx), ty(sy), 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#4da3ff"; ctx.fill();
  });
}

// ---- draggable scallops (ported from the PoC UI) ---------------------------
function snapToFit(pt) {
  const fit = lastProfileDraw[1].fit;
  let best = Infinity, bi = 0;
  for (let i = 0; i < fit.length; i++) {
    const d = Math.hypot(fit[i][0] - pt[0], fit[i][1] - pt[1]);
    if (d < best) { best = d; bi = i; }
  }
  return [fit[bi][0], fit[bi][1]];
}

function pointerMm(e) {
  const rect = profileCnv.getBoundingClientRect();
  const k = profView.Wc / rect.width; // CSS px -> backing px
  const px = (e.clientX - rect.left) * k, py = (e.clientY - rect.top) * k;
  return { px, py, k,
           mm: [(px - profView.Wc / 2) / profView.s + profView.cx,
                profView.cy + (profView.Hc / 2 - py) / profView.s] };
}

profileCnv.addEventListener("pointerdown", (e) => {
  const r = lastProfileDraw && lastProfileDraw[1];
  if (!r || !r.scallops || !r.scallops.length || +sliders.scallop.value <= 0 ||
      !profView) return;
  const { px, py, k } = pointerMm(e);
  const hit = 14 * k; // 14 CSS px, like the PoC
  dragIdx = r.scallops.findIndex(([sx, sy]) => {
    const dx = (sx - profView.cx) * profView.s + profView.Wc / 2 - px;
    const dy = profView.Hc / 2 - (sy - profView.cy) * profView.s - py;
    return Math.hypot(dx, dy) < hit;
  });
  if (dragIdx < 0) return;
  dragScallops = r.scallops.map((p) => p.slice());
  profileCnv.setPointerCapture(e.pointerId);
  e.preventDefault();
});
profileCnv.addEventListener("pointermove", (e) => {
  if (dragIdx < 0) return;
  const p = snapToFit(pointerMm(e).mm);
  dragScallops[dragIdx] = p;
  // the other scallop mirrors across the symmetry axis (x = 0), as in
  // the PoC — contours arrive centered from pose normalization
  if (dragScallops.length > 1) {
    dragScallops[1 - dragIdx] = snapToFit([-p[0], p[1]]);
  }
  drawProfile(...lastProfileDraw);
});
const endDrag = (e) => {
  if (dragIdx < 0) return;
  customScallops = dragScallops;
  dragIdx = -1; dragScallops = null;
  try { profileCnv.releasePointerCapture(e.pointerId); } catch {}
  runProfile();
};
profileCnv.addEventListener("pointerup", endDrag);
profileCnv.addEventListener("pointercancel", endDrag);

const sliders = {};
for (const [id, label] of [["clearance", "v-clearance"], ["smooth", "v-smooth"],
                           ["scallop", "v-scallop"], ["wall", "v-wall"]]) {
  const el = document.getElementById(`sl-${id}`);
  const lbl = document.getElementById(label);
  el.addEventListener("input", () => { lbl.textContent = el.value; });
  el.addEventListener("change", () => {
    // smoothness reshapes the base outline -> dragged spots go stale
    if (id === "smooth") customScallops = null;
    runProfile();
  });
  sliders[id] = el;
}
/** push slider values back into their value labels (imports set values
 *  programmatically, which fires no input events) */
function syncSliderLabels() {
  for (const [id, lbl] of [["clearance", "v-clearance"], ["smooth", "v-smooth"],
                           ["scallop", "v-scallop"], ["wall", "v-wall"]]) {
    document.getElementById(lbl).textContent = sliders[id].value;
  }
}

const optSymmetric = document.getElementById("opt-symmetric");
optSymmetric.addEventListener("change", () => {
  customScallops = null; // mirrored outline moves the auto spots
  runProfile();
});
const optFlat = document.getElementById("opt-flat");
optFlat.addEventListener("change", () => runProfile());

function currentParams() {
  return {
    thickness: +binThickness.value || 25,
    depth_mode: depthMode,
    clearance: +sliders.clearance.value,
    smooth_r: +sliders.smooth.value,
    scallop_d: +sliders.scallop.value,
    scallop_blend: 4.0,
    min_wall: +sliders.wall.value,
    symmetric: optSymmetric.checked,
    max_contour: optMax.checked,
    strict_contain: optStrict.checked,
    flat_faithful: optFlat.checked,
    scallops: customScallops || undefined,
    magnets: currentMagnets(),
    edge: optEdge.value ? { style: optEdge.value, size: 1.0 } : {},
  };
}

async function runProfile() {
  const cres = window.__contour;
  if (!cres || !cres.ok) return;
  profileSec.style.display = "block";
  paneProfile.style.display = "block";
  busyStatus(profileStatus, "fitting pocket profile…");
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
    showDepthChoice(r.depthChoice);
    await runBuild();
  } catch (e) {
    window.__profile = { ok: false, error: String(e) };
    profileStatus.textContent = "error: " + e.message;
  }
}
optMax.addEventListener("change", runProfile);
optStrict.addEventListener("change", runProfile);

// pocket depth: flush (full-depth pocket) or one bin unit shorter with
// the tool standing proud. Each button states what it gives and gets.
let depthMode = "flush";
const depthBtns = {
  flush: document.getElementById("depth-flush"),
  proud: document.getElementById("depth-proud"),
};
const fmtMm = (v) => v.toFixed(1).replace(/\.0$/, "");
function showDepthChoice(choice) {
  const { flush, proud } = choice.options;
  const setText = (btn, give, get) => {
    btn.querySelector(".give").textContent = give;
    btn.querySelector(".get").textContent = get;
  };
  setText(depthBtns.flush, "tool level with the top",
    `${flush.H} mm bin (${flush.nz}u)`);
  if (proud.ok) {
    setText(depthBtns.proud, `give: tool sticks up ${fmtMm(proud.stickout)} mm`,
      `get: ${proud.H} mm bin (${proud.nz}u), ${proud.saveMm} mm shorter`);
  } else {
    setText(depthBtns.proud, "not available", "already the shortest bin");
  }
  depthBtns.proud.disabled = !proud.ok;
  for (const [m, btn] of Object.entries(depthBtns)) {
    btn.setAttribute("aria-checked", String(m === choice.mode));
  }
}
for (const [m, btn] of Object.entries(depthBtns)) {
  btn.addEventListener("click", () => {
    if (depthMode === m) return;
    depthMode = m;
    runProfile();
  });
}

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

// magnet POCKET dimensions as cut (the user includes their own
// press-fit allowance; 6x2 magnet -> 6.15 x 2.1). Ranges keep the
// Gridfinity foot printable: pocket + 0.5 mm chamfer must leave ~1 mm
// of foot wall (centers at +-13 on a 35.6 mm foot bottom), and the cut
// must leave >= 2 mm of floor above it (feet are 4.75 mm tall).
// Per-device convenience like the prefix.
const magOd = document.getElementById("mag-od");
const magH = document.getElementById("mag-h");
const clampMag = (el) => {
  const v = +el.value;
  el.value = Math.min(+el.max, Math.max(+el.min, isFinite(v) ? v : +el.min));
};
try {
  magOd.value = localStorage.getItem("t2b.pocketod") ?? "6.15";
  magH.value = localStorage.getItem("t2b.pocketd") ?? "2.1";
} catch {}
clampMag(magOd); clampMag(magH);
function currentMagnets() {
  return { enabled: optMagnets.checked,
           r: +magOd.value / 2,
           depth: +magH.value, chamfer: 0.5 };
}
for (const el of [magOd, magH]) {
  el.addEventListener("change", () => {
    clampMag(el);
    try {
      localStorage.setItem("t2b.pocketod", magOd.value);
      localStorage.setItem("t2b.pocketd", magH.value);
    } catch {}
    runBuild();
  });
}
const optDeboss = document.getElementById("opt-deboss");
const optEdge = document.getElementById("opt-edge");
const exportBtn = document.getElementById("export-step");

// 3D viewer, ported from the PoC: z-up ortho camera, OrbitControls,
// preset ortho views, n-to-nearest-view snap, bbox-fit zoom. The
// camera survives rebuilds (deboss/magnet toggles) and only reframes
// on a fresh scan or import.
let three = null;
function threeView() {
  if (three) return three;
  const canvas = document.getElementById("bin-view");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, -4000, 4000);
  cam.up.set(0, 0, 1); // z-up, like the geometry
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f46, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(0.5, -1, 1.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-1, 0.6, 0.8);
  scene.add(fill);
  const controls = new OrbitControls(cam, canvas);
  controls.addEventListener("change", () => renderer.render(scene, cam));
  three = { renderer, scene, cam, controls, mesh: null,
            viewHalf: 100, bbox: null, placed: false };
  return three;
}

function applyFrustum() {
  const t = three;
  const canvas = t.renderer.domElement;
  const w = canvas.clientWidth || 560, h = canvas.clientHeight || 420;
  const asp = w / Math.max(1, h);
  t.cam.left = -t.viewHalf * asp; t.cam.right = t.viewHalf * asp;
  t.cam.top = t.viewHalf; t.cam.bottom = -t.viewHalf;
  t.cam.updateProjectionMatrix();
  t.renderer.setSize(w, h, false);
}

function fitZoom() { // zoom so the mesh bbox fills ~90% of the pane
  const t = three;
  if (!t.bbox) return;
  t.cam.updateMatrixWorld(true);
  const inv = t.cam.matrixWorldInverse;
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
  const hi = lo.clone().negate();
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? t.bbox.max.x : t.bbox.min.x,
                                i & 2 ? t.bbox.max.y : t.bbox.min.y,
                                i & 4 ? t.bbox.max.z : t.bbox.min.z)
      .applyMatrix4(inv);
    lo.min(p); hi.max(p);
  }
  t.cam.zoom = 0.9 * Math.min((t.cam.right - t.cam.left) / (hi.x - lo.x),
                              (t.cam.top - t.cam.bottom) / (hi.y - lo.y));
  t.cam.updateProjectionMatrix();
}

// head-on orthographic views; top gets an epsilon tilt so the view
// direction never parallels up=(0,0,1)
const VIEW_DIRS = { iso: [1, -1, 1], top: [0, -1e-4, 1],
                    front: [0, -1, 0], right: [1, 0, 0] };
function setView(name) {
  const t = three;
  if (!t || !t.mesh) return;
  const d = new THREE.Vector3(...VIEW_DIRS[name]).normalize()
    .multiplyScalar(t.viewHalf * 4);
  t.cam.position.copy(t.controls.target).add(d);
  applyFrustum();
  t.controls.update();
  fitZoom();
  t.renderer.render(t.scene, t.cam);
}

// n snaps to whichever of the 6 axis-aligned ortho views is closest
function snapNormal() {
  const t = three;
  if (!t || !t.mesh) return;
  const d = t.cam.position.clone().sub(t.controls.target).normalize();
  let best = null, bd = -2;
  for (const v of [[1, 0, 0], [-1, 0, 0], [0, 1, 0],
                   [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const dot = d.x * v[0] + d.y * v[1] + d.z * v[2];
    if (dot > bd) { bd = dot; best = v; }
  }
  const dir = new THREE.Vector3(...best);
  if (Math.abs(dir.z) > 0.99) dir.y = -1e-4 * Math.sign(dir.z);
  dir.normalize().multiplyScalar(three.viewHalf * 4);
  t.cam.position.copy(t.controls.target).add(dir);
  applyFrustum();
  t.controls.update();
  fitZoom();
  t.renderer.render(t.scene, t.cam);
}

document.querySelectorAll(".pv[data-view]").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view)));
const optViewEdges = document.getElementById("opt-edges");
optViewEdges.addEventListener("change", () => {
  if (!three || !three.edges) return;
  three.edges.visible = optViewEdges.checked;
  three.renderer.render(three.scene, three.cam);
});
window.addEventListener("keydown", (e) => {
  if (e.key !== "n" && e.key !== "N") return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  snapNormal();
});

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
    // pushed back slightly so the edge overlay draws cleanly on top
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  t.mesh = new THREE.Mesh(geo, mat);
  t.scene.add(t.mesh);
  if (t.edges) { t.scene.remove(t.edges); t.edges.geometry.dispose(); }
  t.edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 25),
    new THREE.LineBasicMaterial({ color: 0x5c2d10 }));
  t.edges.visible = optViewEdges.checked;
  t.scene.add(t.edges);
  geo.computeBoundingBox();
  t.bbox = geo.boundingBox;
  t.viewHalf = Math.max(size[0], size[1], size[2]) * 0.72;
  t.controls.target.copy(t.bbox.getCenter(new THREE.Vector3()));
  if (!t.placed) {
    t.placed = true;
    setView("iso"); // first build of a design: frame it
  } else {
    applyFrustum(); // rebuild (deboss/magnets/...): keep the user's view
    t.controls.update();
    t.renderer.render(t.scene, t.cam);
  }
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastProfileDraw) drawProfile(...lastProfileDraw);
    if (three && three.mesh) {
      applyFrustum();
      three.renderer.render(three.scene, three.cam);
    }
  }, 150);
});

async function runBuild() {
  const p = window.__profile;
  if (!p || !p.ok) return;
  binSec.style.display = "block";
  paneBin.style.display = "block";
  exportBtn.disabled = true;
  busyStatus(binStatus, "building bin solid…");
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
    // rev, deboss + magnets are injected at build time: none of them
    // are profile params, so changing them must not force a re-fit
    const r = await cadApi.build(
      { segs: p.segs, periodic: p.periodic, layout: p.layout,
        center: p.center, pocketPts: p.pocketPts, contour },
      { ...p.params, rev: designRev,
        deboss: { enabled: optDeboss.checked },
        magnets: currentMagnets() });
    window.__bin = { ok: r.ok, depth: r.depth, H: r.H, bbox: r.bbox,
      logs: r.logs, ms: r.ms };
    showMesh(r.mesh.positions, r.mesh.indices, r.bbox.dims);
    // surface build warnings (e.g. "rim chamfer failed; stays square")
    // that previously lived only in the hidden log
    const warns = (r.logs || []).filter((l) => l.includes("WARNING"))
      .map((l) => l.replace(/^WARNING:\s*/, ""));
    binStatus.textContent =
      `solid ${r.bbox.dims.map((v) => v.toFixed(1)).join("×")} mm, ` +
      `pocket depth ${r.depth} mm (${(r.ms / 1000).toFixed(1)}s)` +
      (warns.length ? ` — ⚠ ${warns.join("; ")}` : "");
    const logEl = document.getElementById("bin-log");
    logEl.querySelector("pre").textContent = (r.logs || []).join("\n");
    logEl.style.display = "block";
    exportBtn.disabled = false;
  } catch (e) {
    window.__bin = { ok: false, error: String(e) };
    binStatus.textContent = "error: " + (e.message || e);
  }
}
binThickness.addEventListener("change", runProfile);
optMagnets.addEventListener("change", runBuild);
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
    busyStatus(binStatus, "writing STEP…");
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
  // the injected reference warp canvas exceeds the photo cap; never scale it
  const imageData = await fileToImageData(blob, Infinity);
  return cvRequest({ type: "contour", imageData, field },
    [imageData.data.buffer], 600000);
};
// parity hook for stages 4-5 on an injected oriented contour
window.__profileRun = (contourMm, params) =>
  cvRequest({ type: "profile", contourMm, params }, [], 600000);

// drop an exported STEP back in: revise its embedded design, no photo
async function reviseFromStep(file) {
  busyStatus(scanStatus, "reading STEP design…");
  try {
    const text = await file.text();
    const m = [...text.matchAll(/\/\* S2S\| (.*?) \*\//gs)].map((x) => x[1]);
    if (!m.length) throw new Error("no Tool2Bin design found in this STEP");
    const design = JSON.parse(m.join(""));
    if (!design.contour) throw new Error("design has no contour (old export?)");
    window.__warp = null;
    window.__contour = { ok: true, contourMm: design.contour, fromStep: true };
    if (three) three.placed = false; // new design: reframe the 3D view
    binName.value = design.name || "tool";
    designRev = (design.rev || 1) + 1;
    const p = design.params || {};
    if (p.thickness) binThickness.value = p.thickness;
    depthMode = p.depth_mode === "proud" ? "proud" : "flush";
    if (p.clearance != null) sliders.clearance.value = p.clearance;
    if (p.smooth_r != null) sliders.smooth.value = p.smooth_r;
    if (p.scallop_d != null) sliders.scallop.value = p.scallop_d;
    if (p.min_wall != null) sliders.wall.value = p.min_wall;
    optSymmetric.checked = p.symmetric !== false;
    optFlat.checked = !!p.flat_faithful;
    customScallops = Array.isArray(p.scallops) ? p.scallops : null;
    optMagnets.checked = !!(p.magnets && p.magnets.enabled);
    if (p.magnets && p.magnets.r) {
      magOd.value = (2 * p.magnets.r).toFixed(2).replace(/\.?0+$/, "");
      magH.value = (+p.magnets.depth).toFixed(2).replace(/\.?0+$/, "");
      clampMag(magOd); clampMag(magH);
    }
    optDeboss.checked = !(p.deboss && p.deboss.enabled === false);
    optEdge.value = (p.edge && p.edge.style) || "";
    syncSliderLabels(); // programmatic sets fire no input events
    scanStatus.textContent = `revising '${design.name}' from its embedded ` +
      `design (next export is R${String(designRev).padStart(2, "0")})`;
    await runProfile();
  } catch (e) {
    scanStatus.textContent = "error: " + e.message;
  }
}

// name + thickness gate: a photo is held until both are entered (the
// PoC asked in a modal before scanning; here the fields live in the
// scan step). STEP re-imports bypass it — they carry their own design.
let pendingPhoto = null;
const scanGate = document.getElementById("scan-gate");
const startScan = document.getElementById("start-scan");
const gateOk = () => cleanName(binName.value).length > 0 &&
  +binThickness.value >= 1 && +binThickness.value <= 60;
const gateUpdate = () => { startScan.disabled = !gateOk(); };
binName.addEventListener("input", gateUpdate);
binThickness.addEventListener("input", gateUpdate);
function gatePhoto(file) {
  pendingPhoto = file;
  binName.value = file.name.replace(/\.[^.]+$/, "");
  binThickness.value = "";
  depthMode = "flush";
  scanGate.style.display = "block";
  gateUpdate();
  scanStatus.textContent = "photo loaded — confirm the name, enter the " +
    "tool's thickness, and start the scan";
  binThickness.focus();
}
startScan.addEventListener("click", () => {
  if (!pendingPhoto || !gateOk()) return;
  const f = pendingPhoto;
  pendingPhoto = null;
  scanGate.style.display = "none";
  scanPhoto(f);
});

function handleFile(file) {
  if (!file) return;
  if (/\.ste?p$/i.test(file.name)) return reviseFromStep(file);
  return gatePhoto(file);
}

document.getElementById("photo").addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  e.target.value = ""; // same file re-picked later must fire again
});
document.getElementById("stepfile").addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  e.target.value = "";
});
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

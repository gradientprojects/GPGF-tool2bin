import { wrap } from "comlink";

// results Playwright asserts on
window.__selftest = { cad: null, cv: null };
window.__warp = null;
window.__contour = null;
window.__profile = null;

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
    const worker = new Worker(new URL("./cad.worker.js", import.meta.url),
      { type: "module" });
    const api = wrap(worker);
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
  try {
    const imageData = await fileToImageData(file);
    scanStatus.textContent =
      `detecting (${imageData.width}×${imageData.height})…`;
    const r = await cvRequest({ type: "warp", imageData, paper: "letter" },
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

async function runProfile() {
  const cres = window.__contour;
  if (!cres || !cres.ok) return;
  profileSec.style.display = "block";
  profileStatus.textContent = "fitting pocket profile…";
  try {
    const params = {
      max_contour: optMax.checked,
      strict_contain: optStrict.checked,
    };
    const r = await cvRequest({ type: "profile", params }, [], 600000);
    if (!r.ok) throw new Error(r.error);
    window.__profile = r;
    drawProfile(cres.contourMm, r);
    const L = r.layout;
    profileStatus.textContent =
      `bin ${L.nx}×${L.ny}×${L.nz}u (${(L.nx * 42 - 0.5).toFixed(1)}×` +
      `${(L.ny * 42 - 0.5).toFixed(1)}×${L.H} mm), pocket depth ${L.depth} mm` +
      (r.warnings.length ? ` — ⚠ ${r.warnings.join("; ")}` : "") +
      ` (${(r.ms / 1000).toFixed(1)}s)`;
  } catch (e) {
    window.__profile = { ok: false, error: String(e) };
    profileStatus.textContent = "error: " + e.message;
  }
}
optMax.addEventListener("change", runProfile);
optStrict.addEventListener("change", runProfile);

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

document.getElementById("photo").addEventListener("change",
  (e) => scanPhoto(e.target.files[0]));
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) scanPhoto(e.dataTransfer.files[0]);
});

cadCheck();
cvCheck();

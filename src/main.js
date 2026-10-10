import { wrap } from "comlink";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  GRID, GAP, chordPartner, scoopsForMode, SCOOP_MODES, legacyScoopParams,
} from "./profilestage.js";
import { R_TOP } from "./bin3d.js";
import { suggestSize, suggestPosition, D_MIN } from "./scoopfit.js";
import {
  DRAG_R, dragContour, nearestIndex, snapAngle, applyToolDrags, segDist,
  bowSpan, shorterArc, tangentLine, hullBridge,
} from "./outlineedit.js";

// results Playwright asserts on
window.__selftest = { cad: null, cv: null };
window.__warp = null;
window.__contour = null;
window.__profile = null;
window.__bin = null;
window.__quick = null;

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
  ctx.strokeStyle = "#4eb2f1";
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
  customScoops = null; // fresh tool, fresh auto-placement
  warpImg = null;
  resetEdits(null);
  if (three) three.placed = false; // new design: reframe the 3D view
  designRev = 1; revExported = false;
  autoBuild = true; binStale = false; updateStale();
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
    warpImg = r.preview; // kept: outline edits redraw over it
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
    resetEdits(r2.contourMm);
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
let customScoops = null;  // user-dragged scoop centers (worker override)
let dragIdx = -1, dragScoops = null; // in-progress drag
let previewScoops = null, previewD = null; // hovered suggestion
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
  // the bin's footprint (same centre buildBin uses) frames the view
  const L = r.layout;
  const bw = L.nx * GRID - GAP, bd = L.ny * GRID - GAP;
  const [bcx, bcy] = r.center;
  const all = [...toolMm, ...r.pocketPts,
    [bcx - bw / 2, bcy - bd / 2], [bcx + bw / 2, bcy + bd / 2]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of all) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const s = Math.min(Wc / (x1 - x0 + 10), Hc / (y1 - y0 + 10));
  const tx = (x) => (x - (x0 + x1) / 2) * s + Wc / 2;
  const ty = (y) => Hc / 2 - (y - (y0 + y1) / 2) * s; // +Y up
  profView = { s, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, Wc, Hc };
  window.__profView = profView; // UI tests aim pointer events with it
  const poly = (pts, stroke, fill) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(tx(x), ty(y)); else ctx.lineTo(tx(x), ty(y));
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2 * dpr; ctx.stroke(); }
  };
  // footprint: outline, 42 mm cell lines, dashed min-wall keep-out
  const rect = (cx, cy, w, h, rad) => {
    ctx.beginPath();
    ctx.roundRect(tx(cx - w / 2), ty(cy + h / 2), w * s, h * s, rad * s);
  };
  const pz = r.puzzle;
  if (pz && pz.on && pz.outline) {
    // puzzle-piece bin: its own outline (rounded like the 3D body)
    const v = pz.outline, n = v.length;
    ctx.beginPath();
    const mid = (a, b) => [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2];
    const m0 = mid(v[n - 1], v[0]);
    ctx.moveTo(tx(m0[0]), ty(m0[1]));
    v.forEach((c, k) => {
      const m = mid(c, v[(k + 1) % n]);
      ctx.arcTo(tx(c.p[0]), ty(c.p[1]), tx(m[0]), ty(m[1]),
        (c.convex ? R_TOP : R_TOP - GAP) * s);
    });
    ctx.closePath();
  } else {
    rect(bcx, bcy, bw, bd, R_TOP);
  }
  ctx.fillStyle = "rgba(232,232,232,0.04)"; ctx.fill();
  ctx.strokeStyle = "rgba(232,232,232,0.5)"; ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.save();
  if (pz && pz.on && pz.outline) ctx.clip(); // cell lines inside it only
  if (pz && !pz.on && pz.drop > 0) {
    // what Puzzle-piece would drop: those cells, faintly hatched
    const keepSet = new Set(pz.keep.map(([i, j]) => `${i},${j}`));
    ctx.beginPath();
    for (let i = 0; i < L.nx; i++) {
      for (let j = 0; j < L.ny; j++) {
        if (keepSet.has(`${i},${j}`)) continue;
        const x0 = bcx + (i - L.nx / 2) * GRID, y0 = bcy + (j - L.ny / 2) * GRID;
        for (let t = 6; t < 2 * GRID; t += 6) {
          const a = [x0 + Math.max(0, t - GRID), y0 + Math.min(t, GRID)];
          const b = [x0 + Math.min(t, GRID), y0 + Math.max(0, t - GRID)];
          ctx.moveTo(tx(a[0]), ty(a[1])); ctx.lineTo(tx(b[0]), ty(b[1]));
        }
      }
    }
    ctx.strokeStyle = "rgba(232,232,232,0.12)"; ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 1; i < L.nx; i++) {
    const x = bcx + (i - L.nx / 2) * GRID;
    ctx.moveTo(tx(x), ty(bcy - bd / 2)); ctx.lineTo(tx(x), ty(bcy + bd / 2));
  }
  for (let j = 1; j < L.ny; j++) {
    const y = bcy + (j - L.ny / 2) * GRID;
    ctx.moveTo(tx(bcx - bw / 2), ty(y)); ctx.lineTo(tx(bcx + bw / 2), ty(y));
  }
  ctx.strokeStyle = "rgba(232,232,232,0.15)"; ctx.lineWidth = 1 * dpr;
  ctx.stroke();
  ctx.restore();
  const wall = r.params ? r.params.min_wall : 0;
  if (wall > 0 && !(pz && pz.on)) {
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    rect(bcx, bcy, bw - 2 * wall, bd - 2 * wall, Math.max(0, R_TOP - wall));
    ctx.strokeStyle = "rgba(232,232,232,0.25)"; ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = "rgba(232,232,232,0.6)";
  ctx.font = `${12 * dpr}px -apple-system, Helvetica, sans-serif`;
  ctx.fillText(`${L.nx}×${L.ny} · ${fmtMm(bw)} × ${fmtMm(bd)} mm` +
    (pz && pz.on ? ` · ${pz.total - pz.drop} of ${pz.total} cells` : ""),
    8 * dpr, 18 * dpr);

  if (r.provisional) { // fast approximation while the real fit runs
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    poly(r.pocketPts, "#ff9300", "rgba(255,147,0,0.06)");
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,147,0,0.9)";
    ctx.fillText("refining pocket…", 8 * dpr, 36 * dpr);
  } else {
    poly(r.pocketPts, "#ff9300", "rgba(255,147,0,0.12)");
  }
  poly(toolMm, "#4eb2f1", "rgba(78,178,241,0.22)");
  // straightened stretches as the worker built them (slid snug, ends run
  // on to the pocket; mirrored on a symmetric pocket) + a pending end
  for (const [a, b, src] of r.provisional ? [] : r.straightLines || []) {
    const sel = pocketSel && pocketSel.kind === "straight" && pocketSel.i === src;
    ctx.strokeStyle = sel ? "#ffffff" : "#fff2cc";
    ctx.lineWidth = (sel ? 3.5 : 2) * dpr;
    ctx.beginPath();
    ctx.moveTo(tx(a[0]), ty(a[1])); ctx.lineTo(tx(b[0]), ty(b[1]));
    ctx.stroke();
  }
  if (lineDrag && lineDrag.off) { // where the dragged line will go
    const { e0, e1, n } = lineDrag, o = lineDrag.off;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(tx(e0[0] + n[0] * o), ty(e0[1] + n[1] * o));
    ctx.lineTo(tx(e1[0] + n[0] * o), ty(e1[1] + n[1] * o));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // pocket drag handles (while editing the pocket): click to select
  if (pocketOn || straightOn) customPocketDrags.forEach(([at, d], i) => {
    const [hx, hy] = dragHandle({ at, d });
    const sel = pocketSel && pocketSel.kind === "drag" && pocketSel.i === i;
    const h = (sel ? 6 : 4.5) * dpr;
    ctx.fillStyle = sel ? "#ffffff" : "#ff9300";
    ctx.strokeStyle = "#1e1f22"; ctx.lineWidth = 1.5 * dpr;
    ctx.fillRect(tx(hx) - h, ty(hy) - h, 2 * h, 2 * h);
    ctx.strokeRect(tx(hx) - h, ty(hy) - h, 2 * h, 2 * h);
  });
  if (straightAuto) { // what a click would straighten (the tangent line)
    const a = straightAuto.la, b = straightAuto.lb;
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.strokeStyle = "#fff2cc"; ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(tx(a[0]), ty(a[1])); ctx.lineTo(tx(b[0]), ty(b[1]));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(tx(p[0]), ty(p[1]), 4 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    }
  }
  const scoopD = previewD ?? +sliders.scoop.value;
  const dots = dragScoops || previewScoops || r.scoops;
  if (scoopD > 0 && dots) dots.forEach(([sx, sy], i) => {
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.arc(tx(sx), ty(sy), (scoopD / 2) * s, 0, Math.PI * 2);
    ctx.strokeStyle = dragIdx === i ? "#ffffff" : "rgba(242,230,255,0.7)";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tx(sx), ty(sy), 5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "#f2e6ff"; ctx.fill();
  });
}

// ---- draggable scoops (ported from the PoC UI) ---------------------------
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
  if (!r || !profView || r.provisional) return;
  const { px, py, k, mm } = pointerMm(e);
  const hit = 14 * k; // 14 CSS px, like the PoC
  // scoop dots sit on the pocket: while editing it, they stay put
  if (!straightOn && !pocketOn && r.scoops && r.scoops.length &&
      +sliders.scoop.value > 0) {
    dragIdx = r.scoops.findIndex(([sx, sy]) => {
      const dx = (sx - profView.cx) * profView.s + profView.Wc / 2 - px;
      const dy = profView.Hc / 2 - (sy - profView.cy) * profView.s - py;
      return Math.hypot(dx, dy) < hit;
    });
  }
  if (dragIdx < 0 && (pocketOn || straightOn)) {
    // an existing edit under the pointer: select it (a line also drags)
    const hd = customPocketDrags.findIndex(([at, d]) => {
      const h = dragHandle({ at, d });
      return Math.hypot(h[0] - mm[0], h[1] - mm[1]) * profView.s < 10 * k;
    });
    if (hd >= 0) {
      setPocketSel({ kind: "drag", i: hd });
      e.preventDefault();
      return;
    }
    const ln = (r.straightLines || []).find(([a, b]) =>
      segDist(mm, a, b) * profView.s < 8 * k);
    if (ln) {
      setPocketSel({ kind: "straight", i: ln[2] });
      // off = mm out from the tangent; a drag in stops at the clearance
      // (the worker reports that limit per line as minOff, <= 0)
      const cur = +customStraights[ln[2]][3] || 0;
      const inf = (r.straightInfo || [])[ln[2]];
      const min = inf && Number.isFinite(inf.minOff) ? Math.min(0, inf.minOff) : 0;
      lineDrag = { src: ln[2], e0: ln[0], e1: ln[1], start: mm, cur, min,
                   n: outwardNormal(ln[0], ln[1], r.pocketPts), raw: 0, off: 0 };
      profileCnv.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (pocketSel) setPocketSel(null);
  }
  if (dragIdx >= 0) {
    dragScoops = r.scoops.map((p) => p.slice());
  } else if (pocketOn) {
    // grab the pocket near the pointer (a little more forgiving than a dot)
    const idx = nearestIndex(r.pocketPts, mm);
    const p = r.pocketPts[idx];
    if (Math.hypot(p[0] - mm[0], p[1] - mm[1]) * profView.s > 20 * k) return;
    pocketDrag = { idx, at: [p[0], p[1]], start: mm, r, cur: null };
  } else if (straightOn) {
    // a click straightens the bow under it (on release, so Shift can
    // still be pressed)
    straightPress = { mm };
  } else {
    return;
  }
  profileCnv.setPointerCapture(e.pointerId);
  e.preventDefault();
});
profileCnv.addEventListener("pointermove", (e) => {
  if (lineDrag) {
    // only the push across the line counts; never closer than snug
    const { mm } = pointerMm(e), o = lineDrag;
    o.raw = (mm[0] - o.start[0]) * o.n[0] + (mm[1] - o.start[1]) * o.n[1];
    o.off = Math.max(o.raw, o.min - o.cur);
    drawProfile(...lastProfileDraw);
    return;
  }
  if (pocketDrag) {
    const o = pocketDrag, { mm } = pointerMm(e);
    o.cur = dragContour(o.r.pocketPts, o.idx, [mm[0] - o.start[0], mm[1] - o.start[1]],
      DRAG_R, optSymmetric.checked);
    drawProfile(lastProfileDraw[0], { ...o.r, pocketPts: o.cur });
    return;
  }
  if (straightOn && profView && lastProfileDraw && !lastProfileDraw[1].provisional) {
    lastPointer = pointerMm(e).mm;
    const pts = lastProfileDraw[1].pocketPts;
    straightSnap = pts[nearestIndex(pts, lastPointer)];
    if (!straightPress) straightAuto = autoSpan(lastPointer, e.shiftKey);
    drawProfile(...lastProfileDraw);
    return;
  }
  if (dragIdx < 0) return;
  const p = snapToFit(pointerMm(e).mm);
  dragScoops[dragIdx] = p;
  // mirrored pair: the other scoop follows to the far edge at the same
  // height; independent / single scoops move alone
  if (optScoopMode.value === "mirror" && dragScoops.length > 1) {
    dragScoops[1 - dragIdx] = chordPartner(lastProfileDraw[1].fit, p);
  }
  drawProfile(...lastProfileDraw);
});
const endDrag = (e) => {
  if (straightPress) {
    const pr = straightPress;
    straightPress = null;
    try { profileCnv.releasePointerCapture(e.pointerId); } catch {}
    let span = null;
    const au = autoSpan(pr.mm, e.shiftKey); // the whole bow around it
    if (au) {
      span = [au.a, au.b];
      if (au.dir != null) span.push(au.dir); // shift: 0 / 45 / 90 / 135°
    } else {
      edNote("no gently curved stretch there to straighten");
    }
    straightAuto = null;
    if (!span) { drawProfile(...lastProfileDraw); return; }
    pushUndo();
    customStraights = [...customStraights, span];
    straightAdded = true; // its fit reports whether it could be built
    edNote("");
    updateEditButtons();
    runProfile();
    return;
  }
  if (lineDrag) {
    const o = lineDrag;
    lineDrag = null;
    try { profileCnv.releasePointerCapture(e.pointerId); } catch {}
    if (Math.abs(o.raw) < 0.1) { // a click: just the selection
      drawProfile(...lastProfileDraw);
      return;
    }
    pushUndo();
    const [a, b, dir] = customStraights[o.src];
    customStraights = customStraights.map((s, i) =>
      (i === o.src ? [a, b, dir ?? null, o.cur + o.off] : s));
    edNote(o.raw < o.min - o.cur - 0.05
      ? "a straight line stops at the clearance — it can't go closer to the tool"
      : "");
    applyPocketEdits();
    return;
  }
  if (pocketDrag) {
    const o = pocketDrag, { mm } = pointerMm(e);
    pocketDrag = null;
    try { profileCnv.releasePointerCapture(e.pointerId); } catch {}
    drawProfile(lastProfileDraw[0], o.r);
    if (!o.cur) return; // a click, not a drag
    pushUndo();
    customPocketDrags = [...customPocketDrags,
      [o.at, [mm[0] - o.start[0], mm[1] - o.start[1]]]];
    edNote("");
    updateEditButtons();
    runProfile();
    return;
  }
  if (dragIdx < 0) return;
  customScoops = dragScoops;
  dragIdx = -1; dragScoops = null;
  try { profileCnv.releasePointerCapture(e.pointerId); } catch {}
  runProfile();
};
profileCnv.addEventListener("pointerup", endDrag);
profileCnv.addEventListener("pointercancel", endDrag);

// ---- hand edits: tool outline on the photo, the pocket on the preview -----
// The edited outline replaces the design's tool contour (sent to the
// worker with every fit, embedded in the STEP). Pocket edits (straight
// lines, drags) are profile params applied after the fit, so they live
// through refits. All are per-design: a new scan or STEP resets them.
// The tool outline is edited on the photo only (where the real edge
// shows); the pocket preview edits the pocket only (owner, 2026-10-09).
let dragOn = false;         // "Edit outline" (photo pane)
let pocketOn = false;       // "Edit pocket" (pocket pane)
let straightOn = false;     // "Straighten" (pocket pane)
let outlineDrag = null;     // in-progress outline drag (photo)
let pocketDrag = null;      // in-progress pocket drag (preview)
let lineDrag = null;        // in-progress drag of a straight line (preview)
let toolDrags = [];         // [{at, d, mirror}] tool outline drags, in order
let photoSel = -1;          // selected tool drag (photo), -1 = none
let pocketSel = null;       // selected pocket edit {kind: "straight"|"drag", i}
let straightSnap = null;    // pocket point under the cursor (hover dot)
let straightPress = null;   // pressed in Straighten: {mm}
let straightAuto = null;    // hover preview of a click: {a, b, dir}
let lastPointer = null;     // mm, for re-aiming the preview on Shift
let customStraights = [];   // [[a, b, dir?], ...] mm points on the pocket
let customPocketDrags = []; // [[at, d], ...] mm: pocket point, its move
let editUndo = [];          // snapshots before each edit (one history)
let origContour = null;     // as scanned / opened, for Reset
let warpImg = null;         // the photo preview, redrawn under the outline
const edBtns = {
  drag: document.getElementById("ed-drag"),
  pocket: document.getElementById("ed-pocket"),
  straight: document.getElementById("ed-straight"),
  undo: [...document.querySelectorAll(".ed-undo")],
  reset: document.getElementById("ed-reset"),
  clear: document.getElementById("ed-clear"),
  del: document.getElementById("ed-del"),
  delPhoto: document.getElementById("ed-del-photo"),
};
const edMirror = document.getElementById("ed-mirror");
// UI tests read the edit lists (and aim at their handles) through this
window.__edits = () => ({ toolDrags, straights: customStraights,
                          pocketDrags: customPocketDrags });
const edHints = {
  drag: document.getElementById("ed-hint-photo"),
  pocket: document.getElementById("ed-hint"),
  straight: document.getElementById("ed-hint"),
};
const ED_HINTS = {
  drag: "drag the blue outline onto the tool's real edge — the pocket " +
    "refits around it. Tick “mirror edits” to move the matching spot on " +
    "the other side too (symmetric tools only). Click a square handle " +
    "to select a drag; Delete removes just that one.",
  pocket: "drag the orange pocket to reshape it — independent of the tool " +
    "outline (with symmetric on, the other side follows). Drag a cream " +
    "line to move it. Click a handle or line to select it; Delete " +
    "removes just that one.",
  straight: "click a bowed stretch of the orange pocket to snap it " +
    "straight (the dashed line shows what a click does); hold Shift for " +
    "horizontal / vertical / 45°. Drag a cream line to move it; click " +
    "one and press Delete to remove it.",
};
const edNoteEl = document.getElementById("ed-note");
/** what the last pocket edit did, or why it couldn't ("" clears) */
function edNote(text) {
  edNoteEl.hidden = !text;
  edNoteEl.textContent = text;
}
// Cmd/Ctrl+Z undoes edits (text fields keep their own undo)
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
for (const b of edBtns.undo) b.title = `Undo (${isMac ? "⌘" : "Ctrl+"}Z)`;

/** what a click at mm would straighten: the bow around the nearest
 *  pocket point (bowSpan), and with shift its held 0/45/90/135° angle */
function autoSpan(mm, shift) {
  const pts = lastProfileDraw[1].pocketPts;
  // a dent: bridge it (the hull edge across it = the tangent on its
  // outermost points); a bulge or flat: the gently curved stretch
  const at = nearestIndex(pts, mm);
  const span = hullBridge(pts, at) || bowSpan(pts, at);
  if (!span) return null;
  const [a, b] = span;
  const dir = shift ? snapAngle(a, b).dir : null;
  // what gets built: the tangent resting on the stretch's outermost
  // points (the worker does the same on its fit; this is the preview)
  const { from, to } = shorterArc(pts, nearestIndex(pts, a), nearestIndex(pts, b));
  const arc = [];
  for (let k = from; ; k = (k + 1) % pts.length) { arc.push(pts[k]); if (k === to) break; }
  const p0 = arc[0], p1 = arc[arc.length - 1];
  let u = [p1[0] - p0[0], p1[1] - p0[1]];
  if (dir != null) {
    const v = [Math.cos(dir * Math.PI / 180), Math.sin(dir * Math.PI / 180)];
    const s = Math.sign(u[0] * v[0] + u[1] * v[1]) || 1;
    u = [s * v[0], s * v[1]];
  } else {
    const L = Math.hypot(u[0], u[1]) || 1;
    u = [u[0] / L, u[1] / L];
  }
  const n = outwardNormal(p0, [p0[0] + u[0], p0[1] + u[1]], pts);
  const tg = tangentLine(arc, u, n);
  let la = tg.a, lb = tg.b;
  if (Math.hypot(lb[0] - la[0], lb[1] - la[1]) < 2) { // touches at one spot
    const len = (p1[0] - p0[0]) * u[0] + (p1[1] - p0[1]) * u[1];
    la = [p0[0] + n[0] * tg.sup, p0[1] + n[1] * tg.sup];
    lb = [la[0] + u[0] * len, la[1] + u[1] * len];
  }
  return { a, b, dir, la, lb };
}

/** one edit mode per pane: the pocket pane's two are exclusive */
function setToggle(which, on) {
  if (on && which === "pocket" && straightOn) setToggle("straight", false);
  if (on && which === "straight" && pocketOn) setToggle("pocket", false);
  if (which === "drag") dragOn = on;
  else if (which === "pocket") pocketOn = on;
  else straightOn = on;
  edBtns[which].setAttribute("aria-pressed", String(on));
  const anyPocket = pocketOn || straightOn;
  if (which === "drag") {
    edHints.drag.hidden = !on;
    edHints.drag.textContent = on ? ED_HINTS.drag : "";
  } else {
    edHints.pocket.hidden = !anyPocket;
    edHints.pocket.textContent = straightOn ? ED_HINTS.straight
      : pocketOn ? ED_HINTS.pocket : "";
    straightSnap = null; straightAuto = null; straightPress = null;
    if (lastProfileDraw) drawProfile(...lastProfileDraw);
  }
}
function updateEditButtons() {
  for (const b of edBtns.undo) b.disabled = !editUndo.length;
  edBtns.reset.disabled = !toolDrags.length;
  edBtns.clear.disabled = !(customStraights.length || customPocketDrags.length);
  // the straight edge blend slider only matters once there's a line
  document.getElementById("blend-row").hidden = !customStraights.length;
  edBtns.drag.disabled = !warpFrame();
  edBtns.delPhoto.disabled = photoSel < 0;
  edBtns.del.disabled = !pocketSel;
}
function resetEdits(contour) {
  origContour = contour;
  toolDrags = [];
  customStraights = [];
  customPocketDrags = [];
  editUndo = [];
  photoSel = -1; pocketSel = null;
  straightSnap = null; straightAuto = null; straightPress = null;
  outlineDrag = null; pocketDrag = null; lineDrag = null;
  edNote("");
  updateEditButtons();
}
function pushUndo() {
  editUndo.push({ tool: toolDrags, straights: customStraights,
                  drags: customPocketDrags });
}
// a new __contour object, so a fit already running is superseded
function setToolContour(contour, edited = true) {
  window.__contour = { ...window.__contour, contourMm: contour, edited };
  updateEditButtons();
  drawPhotoOutline();
  runProfile();
}
/** the tool outline = the detected one + the drag list, re-applied */
function applyToolEdits() {
  if (!window.__contour || !origContour) return;
  if (photoSel >= toolDrags.length) photoSel = -1;
  setToolContour(toolDrags.length ? applyToolDrags(origContour, toolDrags)
    : origContour, toolDrags.length > 0);
}
/** after any pocket-edit change: selection still valid? then refit */
function applyPocketEdits() {
  if (pocketSel && !(pocketSel.kind === "straight" ? customStraights
    : customPocketDrags)[pocketSel.i]) pocketSel = null;
  updateEditButtons();
  runProfile();
}
function setPhotoSel(i) {
  photoSel = i;
  updateEditButtons();
  drawPhotoOutline();
}
function setPocketSel(sel) {
  pocketSel = sel;
  updateEditButtons();
  if (lastProfileDraw) drawProfile(...lastProfileDraw);
}
/** take out just the selected edit (photo drag, pocket drag or line) */
function deleteSelected(pane) {
  if (pane === "photo" && photoSel >= 0) {
    pushUndo();
    toolDrags = toolDrags.filter((_, i) => i !== photoSel);
    photoSel = -1;
    applyToolEdits();
  } else if (pane === "pocket" && pocketSel) {
    pushUndo();
    const { kind, i } = pocketSel;
    if (kind === "straight") customStraights = customStraights.filter((_, j) => j !== i);
    else customPocketDrags = customPocketDrags.filter((_, j) => j !== i);
    pocketSel = null;
    edNote("");
    applyPocketEdits();
  }
}
/** after a fit: a straight line just drawn that couldn't be built is
 *  taken back (with a note); one that had to move out is explained */
let straightAdded = false; // a line was just drawn: report on its fit
function noteStraights(r) {
  const info = r.straightInfo || [];
  const i = customStraights.length - 1;
  if (!straightAdded || i < 0 || !info[i]) return;
  straightAdded = false;
  if (!info[i].built) {
    customStraights = customStraights.slice(0, -1);
    editUndo.pop();
    edNote("that line would cut right through the tool — not added");
    applyPocketEdits();
  } else if (info[i].shift > 0.3) {
    edNote(`that line crossed the tool, so it moved out ` +
      `${info[i].shift.toFixed(1)} mm to clear it`);
  }
}
edBtns.drag.addEventListener("click", () => setToggle("drag", !dragOn));
edBtns.pocket.addEventListener("click", () => setToggle("pocket", !pocketOn));
edBtns.straight.addEventListener("click", () => setToggle("straight", !straightOn));
edBtns.delPhoto.addEventListener("click", () => deleteSelected("photo"));
edBtns.del.addEventListener("click", () => deleteSelected("pocket"));
for (const b of edBtns.undo) b.addEventListener("click", () => {
  const u = editUndo.pop();
  if (!u || !window.__contour) return;
  const toolChanged = u.tool !== toolDrags;
  toolDrags = u.tool;
  customStraights = u.straights;
  customPocketDrags = u.drags;
  photoSel = -1; pocketSel = null;
  edNote("");
  if (toolChanged) applyToolEdits(); else applyPocketEdits();
});
edBtns.reset.addEventListener("click", () => {
  if (!window.__contour || !origContour || !toolDrags.length) return;
  pushUndo();
  toolDrags = [];
  photoSel = -1;
  // a STEP's own contour still has to ride along (fromStep stays set)
  applyToolEdits();
});
edBtns.clear.addEventListener("click", () => {
  if (!window.__contour || edBtns.clear.disabled) return;
  pushUndo();
  customStraights = [];
  customPocketDrags = [];
  pocketSel = null;
  edNote("");
  applyPocketEdits();
});

// photo <-> oriented mm: pose.js rotateContour + toOrientedMm, both ways
// (a rotation, the centring and the optional 180° flip: rigid, so drags
// measured in mm on the photo mean the same in the pocket)
function warpFrame() {
  const c = window.__contour, w = window.__warp;
  if (!c || !c.ok || c.fromStep || !c.centerPx || !w || !w.ok || !warpImg) {
    return null;
  }
  const t = (c.angleDeg * Math.PI) / 180, a = Math.cos(t), b = Math.sin(t);
  const [cx, cy] = c.centerPx, cols = w.warpSize[0];
  const m2 = (1 - a) * cx - b * cy + (cols / 2 - cx), m5 = b * cx + (1 - a) * cy;
  const f = c.flipped ? -1 : 1, px = w.pxmm, [mx, my] = c.centerMm;
  const s = previewCnv.width / cols; // warp px -> preview canvas px
  return {
    s, pxPerMm: px * s,
    toMm: ([u, v]) => {
      const rx = a * u + b * v + m2, ry = -b * u + a * v + m5;
      return [f * (rx / px - mx), f * (-ry / px - my)];
    },
    toPx: ([x, y]) => {
      const rx = (f * x + mx) * px - m2, ry = -(f * y + my) * px - m5;
      return [a * rx - b * ry, b * rx + a * ry];
    },
  };
}
window.__warpFrame = warpFrame; // UI tests aim pointer events with it

/** the photo with the tool outline on it: the detected one, or (edited)
 *  the current one solid over the detected one faint */
function drawPhotoOutline(contourMm = null) {
  const c = window.__contour, w = window.__warp;
  if (!warpImg || !c || !c.ok || !w || !w.ok) return;
  const ctx = previewCnv.getContext("2d");
  ctx.putImageData(warpImg, 0, 0);
  const cur = contourMm || (c.edited ? c.contourMm : null);
  const fr = cur && warpFrame();
  if (!fr) { drawContourOverlay(c.contourPx, w.warpSize); return; }
  ctx.save();
  ctx.globalAlpha = 0.35;
  drawContourOverlay(c.contourPx, w.warpSize);
  ctx.restore();
  ctx.strokeStyle = "#4eb2f1"; ctx.lineWidth = 2;
  ctx.beginPath();
  cur.forEach((p, i) => {
    const [u, v] = fr.toPx(p);
    if (i === 0) ctx.moveTo(u * fr.s, v * fr.s); else ctx.lineTo(u * fr.s, v * fr.s);
  });
  ctx.closePath();
  ctx.stroke();
  // one handle per drag (where it moved the outline to): click to select
  if (dragOn) toolDrags.forEach((op, i) => {
    const [u, v] = fr.toPx(dragHandle(op));
    const r = photoSel === i ? 6 : 4.5;
    ctx.fillStyle = photoSel === i ? "#ffffff" : "#4eb2f1";
    ctx.strokeStyle = "#1e1f22"; ctx.lineWidth = 1.5;
    ctx.fillRect(u * fr.s - r, v * fr.s - r, 2 * r, 2 * r);
    ctx.strokeRect(u * fr.s - r, v * fr.s - r, 2 * r, 2 * r);
  });
}
/** where a drag's handle sits: the grabbed point, moved */
const dragHandle = (op) => [op.at[0] + op.d[0], op.at[1] + op.d[1]];

/** the photo's drawn box inside the canvas element: object-fit:contain
 *  letterboxes it when max-height caps a tall photo */
function photoBox() {
  const r = previewCnv.getBoundingClientRect();
  const sc = Math.min(r.width / previewCnv.width, r.height / previewCnv.height);
  return { left: r.left + (r.width - previewCnv.width * sc) / 2,
           top: r.top + (r.height - previewCnv.height * sc) / 2,
           k: 1 / sc }; // CSS px -> backing px
}
window.__photoBox = photoBox;
function photoPointer(e, fr) {
  const b = photoBox();
  const u = (e.clientX - b.left) * b.k / fr.s, v = (e.clientY - b.top) * b.k / fr.s;
  return { k: b.k, mm: fr.toMm([u, v]) };
}
previewCnv.addEventListener("pointerdown", (e) => {
  const fr = dragOn && warpFrame();
  if (!fr) return;
  const { k, mm } = photoPointer(e, fr);
  // a drag's handle: select it (Delete removes just that drag)
  const hi = toolDrags.findIndex((op) => {
    const h = dragHandle(op);
    return Math.hypot(h[0] - mm[0], h[1] - mm[1]) * fr.pxPerMm < 10 * k;
  });
  if (hi >= 0) {
    setPhotoSel(hi);
    e.preventDefault();
    return;
  }
  setPhotoSel(-1);
  const tool = window.__contour.contourMm;
  const idx = nearestIndex(tool, mm);
  const d = Math.hypot(tool[idx][0] - mm[0], tool[idx][1] - mm[1]);
  if (d * fr.pxPerMm > 14 * k) return; // 14 CSS px, like the scoop dots
  outlineDrag = { idx, start: mm, base: tool, cur: tool, fr, d: [0, 0] };
  previewCnv.setPointerCapture(e.pointerId);
  e.preventDefault();
});
previewCnv.addEventListener("pointermove", (e) => {
  const o = outlineDrag;
  if (!o) return;
  const { mm } = photoPointer(e, o.fr);
  o.d = [mm[0] - o.start[0], mm[1] - o.start[1]];
  o.cur = dragContour(o.base, o.idx, o.d, DRAG_R, edMirror.checked);
  drawPhotoOutline(o.cur);
});
const endOutlineDrag = (e) => {
  const o = outlineDrag;
  if (!o) return;
  outlineDrag = null;
  try { previewCnv.releasePointerCapture(e.pointerId); } catch {}
  if (o.cur === o.base) return; // a click, not a drag
  pushUndo();
  toolDrags = [...toolDrags,
    { at: o.base[o.idx].slice(), d: o.d, mirror: edMirror.checked }];
  applyToolEdits();
};
previewCnv.addEventListener("pointerup", endOutlineDrag);
previewCnv.addEventListener("pointercancel", endOutlineDrag);
window.addEventListener("keydown", (e) => {
  const undoKey = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey &&
    e.key.toLowerCase() === "z";
  if (undoKey) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) &&
              !/^(checkbox|radio|range|button)$/.test(t.type))) return;
    e.preventDefault();
    if (editUndo.length) edBtns.undo[0].click();
    return;
  }
  const typing = e.target && (e.target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) &&
    !/^(checkbox|radio|range|button)$/.test(e.target.type));
  // Delete / Backspace: take out just the selected edit
  if ((e.key === "Delete" || e.key === "Backspace") && !typing &&
      (photoSel >= 0 || pocketSel)) {
    e.preventDefault();
    deleteSelected(photoSel >= 0 ? "photo" : "pocket");
    return;
  }
  if (e.key === "Escape") {
    if (straightPress) {
      straightPress = null;
      if (lastProfileDraw) drawProfile(...lastProfileDraw);
    } else if (pocketSel) setPocketSel(null);
    else if (photoSel >= 0) setPhotoSel(-1);
  }
});

/** unit normal of line a-b pointing out of the pocket (away from the
 *  bulk of its points), for dragging a straight line across itself */
function outwardNormal(a, b, pocketPts) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L, bulk = 0;
  for (const p of pocketPts) bulk += (p[0] - a[0]) * nx + (p[1] - a[1]) * ny;
  return bulk > 0 ? [-nx, -ny] : [nx, ny];
}
// Shift pressed / released mid-hover: re-aim the preview line
for (const ev of ["keydown", "keyup"]) {
  window.addEventListener(ev, (e) => {
    if (e.key !== "Shift" || !straightOn || !lastPointer || !lastProfileDraw) return;
    const shift = e.type === "keydown";
    if (straightAuto) straightAuto = autoSpan(lastPointer, shift);
    else return;
    drawProfile(...lastProfileDraw);
  });
}
// pointer gone from the pocket preview: no hover dot / preview line
profileCnv.addEventListener("pointerleave", () => {
  if (straightPress) return; // pressed: the release decides
  if (!straightSnap && !straightAuto) return;
  straightSnap = null; straightAuto = null;
  if (lastProfileDraw) drawProfile(...lastProfileDraw);
});

const sliders = {};
for (const [id, label] of [["clearance", "v-clearance"], ["smooth", "v-smooth"],
                           ["scoop", "v-scoop"], ["fillet", "v-fillet"],
                           ["wall", "v-wall"], ["blend", "v-blend"]]) {
  const el = document.getElementById(`sl-${id}`);
  const lbl = document.getElementById(label);
  el.addEventListener("input", () => {
    lbl.textContent = el.value;
    // scoop circles are drawn here, not fitted: preview the size live
    if (id === "scoop" && lastProfileDraw) drawProfile(...lastProfileDraw);
  });
  el.addEventListener("change", () => {
    // smoothness reshapes the base outline -> dragged spots go stale
    if (id === "smooth") customScoops = null;
    runProfile();
  });
  sliders[id] = el;
}
/** push slider values back into their value labels (imports set values
 *  programmatically, which fires no input events) */
function syncSliderLabels() {
  for (const [id, lbl] of [["clearance", "v-clearance"], ["smooth", "v-smooth"],
                           ["scoop", "v-scoop"], ["fillet", "v-fillet"],
                           ["wall", "v-wall"], ["blend", "v-blend"]]) {
    document.getElementById(lbl).textContent = sliders[id].value;
  }
}

const optSymmetric = document.getElementById("opt-symmetric");
optSymmetric.addEventListener("change", () => {
  customScoops = null; // mirrored outline moves the auto spots
  runProfile();
});
const optFlat = document.getElementById("opt-flat");
optFlat.addEventListener("change", () => runProfile());
// scoop mode keeps the spots on screen where it can (dragged or auto)
const optScoopMode = document.getElementById("opt-scoop-mode");
optScoopMode.addEventListener("change", () => {
  const r = lastProfileDraw && lastProfileDraw[1];
  customScoops = r ? scoopsForMode(r.fit, r.scoops, optScoopMode.value)
    : null;
  runProfile();
});

function currentParams() {
  return {
    thickness: +binThickness.value || 25,
    depth_mode: depthMode,
    puzzle: puzzleOn || undefined,
    clearance: +sliders.clearance.value,
    smooth_r: +sliders.smooth.value,
    scoop_d: +sliders.scoop.value,
    scoop_blend: +sliders.fillet.value,
    straight_blend: +sliders.blend.value,
    scoop_mode: optScoopMode.value,
    min_wall: +sliders.wall.value,
    symmetric: optSymmetric.checked,
    max_contour: optMax.checked,
    strict_contain: optStrict.checked,
    flat_faithful: optFlat.checked,
    scoops: customScoops || undefined,
    straights: customStraights.length ? customStraights : undefined,
    pocket_drags: customPocketDrags.length ? customPocketDrags : undefined,
    magnets: currentMagnets(),
    edge: optEdge.value ? { style: optEdge.value, size: 1.0 } : {},
  };
}

// Latest wins: while a fit runs, further tweaks only flag a rerun, so a
// burst of changes costs one extra fit (at the newest settings) instead
// of queueing one per change in the worker.
let profileBusy = false, profileQueued = false;
// params that reshape the base outline (a full smooth refit)
const QUICK_KEYS = ["clearance", "smooth_r", "symmetric", "max_contour",
                    "flat_faithful"];
// the quick preview runs ahead of the real fit in the same worker, so it
// only pays off where the fit is slow; fast machines skip it
let lastFitMs = 0;
const QUICK_MIN_MS = 700;
// the first profile of a new design (scan / STEP import) builds the
// solid by itself; after that the 3D view waits for "Rebuild 3D"
let autoBuild = false;
async function runProfile() {
  if (!window.__contour || !window.__contour.ok) return;
  clearSuggestions(); // they were for the old settings
  if (profileBusy) { profileQueued = true; return; }
  profileBusy = true;
  profileSec.style.display = "block";
  paneProfile.style.display = "block";
  markStale();
  try {
    do {
      profileQueued = false;
      const cres = window.__contour;
      if (!cres || !cres.ok) break;
      busyStatus(profileStatus, window.__profile && window.__profile.ok
        ? "updating pocket profile…" : "fitting pocket profile…");
      const params = currentParams();
      const msg = { type: "profile", params };
      if (cres.fromStep || cres.edited) msg.contourMm = cres.contourMm;
      // outline-shaping change on a machine where the refit is slow:
      // first draw the fast approximate pocket (dashed) in its place
      const prev = window.__profile;
      if (prev && prev.ok && lastFitMs > (window.__quickMinMs ?? QUICK_MIN_MS) &&
          QUICK_KEYS.some((k) => prev.params[k] !== params[k])) {
        const q = await cvRequest({ ...msg, type: "quick" }, [], 60000);
        if (cres !== window.__contour) profileQueued = true;
        if (profileQueued) continue;
        window.__quick = q.ok ? { ms: q.ms, n: q.pocketPts.length } : q;
        if (q.ok) {
          drawProfile(cres.contourMm, { ...prev, pocketPts: q.pocketPts,
                                        provisional: true });
        }
      }
      const r = await cvRequest(msg, [], 600000);
      // superseded while fitting (newer tweak, or a new design)
      if (cres !== window.__contour) profileQueued = true;
      if (profileQueued) continue;
      if (!r.ok) throw new Error(r.error);
      window.__profile = { ...r, params };
      if (r.timings && r.timings.fit != null) lastFitMs = r.timings.fit;
      drawProfile(cres.contourMm, window.__profile);
      noteStraights(r);
      const L = r.layout;
      profileStatus.textContent =
        `bin ${L.nx}×${L.ny}×${L.nz}u (${(L.nx * 42 - 0.5).toFixed(1)}×` +
        `${(L.ny * 42 - 0.5).toFixed(1)}×${L.H} mm), pocket depth ${L.depth} mm` +
        (r.warnings.length ? ` — ⚠ ${r.warnings.join("; ")}` : "") +
        ` (${(r.ms / 1000).toFixed(1)}s)`;
      showDepthChoice(r.depthChoice);
      showShapeChoice(r.puzzle);
    } while (profileQueued);
  } catch (e) {
    window.__profile = { ok: false, error: String(e) };
    profileStatus.textContent = "error: " + e.message;
  } finally {
    profileBusy = false;
    updateStale();
  }
  if (window.__profile && window.__profile.ok) refreshSuggestions();
  if (autoBuild && window.__profile && window.__profile.ok) {
    autoBuild = false;
    await runBuild();
  }
}
optMax.addEventListener("change", runProfile);

// ---- scoop suggestions that save a grid unit ------------------------------
// scoopfit.js predicts candidates from the bbox alone; each one is
// then checked with a real fit (cheap: the base fit is cached) and only
// shown if the real layout is smaller. Any tweak cancels the round.
const suggestEl = document.getElementById("scoop-suggest");
const sgBtns = { size: document.getElementById("sg-size"),
                 move: document.getElementById("sg-move") };
let suggestGen = 0, suggestions = { size: null, move: null };
window.__suggest = null;
function clearSuggestions() {
  suggestGen++;
  suggestions = { size: null, move: null };
  window.__suggest = { done: false, size: null, move: null };
  suggestEl.hidden = true;
  for (const b of Object.values(sgBtns)) b.hidden = true;
  if (previewScoops || previewD != null) {
    previewScoops = null; previewD = null;
    if (lastProfileDraw) drawProfile(...lastProfileDraw);
  }
}
async function refreshSuggestions() {
  clearSuggestions();
  const gen = suggestGen;
  const p = window.__profile, cres = window.__contour;
  const { params } = p;
  const cur = { nx: p.layout.nx, ny: p.layout.ny };
  const verify = async (over) => {
    const msg = { type: "profile", params: { ...params, ...over } };
    if (cres.fromStep || cres.edited) msg.contourMm = cres.contourMm;
    const r = await cvRequest(msg, [], 600000);
    if (gen !== suggestGen || !r.ok) return null;
    const L = r.layout;
    const ok = L.nx <= cur.nx && L.ny <= cur.ny &&
      L.nx * L.ny < cur.nx * cur.ny && L.nz === p.layout.nz;
    return ok ? L : null;
  };
  try {
    let size = null, move = null;
    const s = suggestSize(p.fit, p.scoops, params.scoop_d, params.min_wall, cur);
    // the bbox prediction can be a hair optimistic: allow 2 mm more
    if (s) for (let d = s.d; d >= Math.max(D_MIN, s.d - 2); d--) {
      const L = await verify({ scoop_d: d });
      if (gen !== suggestGen) return;
      if (L) { size = { d, L }; break; }
    }
    const m = suggestPosition(p.fit, p.scoops, params.scoop_d, params.min_wall,
      cur, params.scoop_mode);
    if (m) {
      const L = await verify({ scoops: m.scoops });
      if (gen !== suggestGen) return;
      if (L) move = { scoops: m.scoops, move: m.move, L };
    }
    suggestions = { size, move };
    showSuggestions(cur, params.scoop_d);
    window.__suggest = { done: true, size, move };
  } catch (e) {
    if (gen === suggestGen) window.__suggest = { done: true, error: String(e) };
  }
}
function showSuggestions(cur, d) {
  const gain = (L) => {
    const parts = [];
    if (L.nx < cur.nx) parts.push(`${(cur.nx - L.nx) * GRID} mm narrower`);
    if (L.ny < cur.ny) parts.push(`${(cur.ny - L.ny) * GRID} mm less deep`);
    return `get: ${L.nx}×${L.ny} bin (was ${cur.nx}×${cur.ny}), ${parts.join(", ")}`;
  };
  const set = (btn, give, get) => {
    btn.querySelector(".give").textContent = give;
    btn.querySelector(".get").textContent = get;
    btn.hidden = false;
  };
  const { size, move } = suggestions;
  if (size) set(sgBtns.size, `give: finger scoops ${d} → ${size.d} mm`, gain(size.L));
  if (move) set(sgBtns.move,
    `give: finger scoops move ${Math.round(move.move)} mm (hover to preview)`, gain(move.L));
  suggestEl.hidden = !size && !move;
}
const previewSuggestion = (kind, on) => {
  const sg = suggestions[kind];
  previewScoops = on && kind === "move" && sg ? sg.scoops : null;
  previewD = on && kind === "size" && sg ? sg.d : null;
  if (lastProfileDraw) drawProfile(...lastProfileDraw);
};
for (const [kind, btn] of Object.entries(sgBtns)) {
  btn.addEventListener("mouseenter", () => previewSuggestion(kind, true));
  btn.addEventListener("focus", () => previewSuggestion(kind, true));
  btn.addEventListener("mouseleave", () => previewSuggestion(kind, false));
  btn.addEventListener("blur", () => previewSuggestion(kind, false));
  btn.addEventListener("click", () => {
    const sg = suggestions[kind];
    if (!sg) return;
    if (kind === "size") {
      sliders.scoop.value = sg.d;
      syncSliderLabels();
    } else {
      customScoops = sg.scoops;
    }
    runProfile();
  });
}
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
  } else if (proud.why === "engage") {
    setText(depthBtns.proud, "not available",
      `tool would stick up ${fmtMm(proud.stickout)} mm — too much of it`);
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

// bin shape: Full / Puzzle-piece (drop the cells the pocket doesn't
// need). Offered only when that saves at least one cell (owner rule —
// no disabled stub); off by default; a style setting like magnets, so
// it stays for the next design and is copied by "use only its settings".
let puzzleOn = false;
const shapeRow = document.getElementById("shape-row");
const shapeBtns = {
  full: document.getElementById("shape-full"),
  puzzle: document.getElementById("shape-puzzle"),
};
function showShapeChoice(pz) {
  shapeRow.hidden = !(pz && pz.drop > 0);
  if (shapeRow.hidden) return;
  const kept = pz.total - pz.drop;
  const set = (btn, give, get) => {
    btn.querySelector(".give").textContent = give;
    btn.querySelector(".get").textContent = get;
  };
  set(shapeBtns.full, "every grid cell", `${pz.total} cells`);
  set(shapeBtns.puzzle, `drops ${pz.drop} unused cell${pz.drop > 1 ? "s" : ""}`,
    `${kept} cells — less plastic, frees space for other bins`);
  shapeBtns.full.setAttribute("aria-checked", String(!pz.on));
  shapeBtns.puzzle.setAttribute("aria-checked", String(pz.on));
}
for (const [m, btn] of Object.entries(shapeBtns)) {
  btn.addEventListener("click", () => {
    if (puzzleOn === (m === "puzzle")) return;
    puzzleOn = m === "puzzle";
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
// and on the first rebuild after an export (the rev is debossed + embedded
// at build time, so re-exporting an unchanged model keeps its rev)
let designRev = 1, revExported = false;
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
    markStale();
  });
}
const optDeboss = document.getElementById("opt-deboss");
const optEdge = document.getElementById("opt-edge");
// foot fit: 0 = Gridfinity spec feet; 0.25 = the whole foot profile 0.25
// mm smaller per side (owner, 2026-10-09: matches the FeatureScript the
// owner's other bins come from — 36.7 band / 35.1 bottom; and the owner
// made it the DEFAULT). A build-time setting like magnets (no refit);
// remembered per device, saved in the STEP.
const optFoot = document.getElementById("opt-foot");
try {
  const v = localStorage.getItem("t2b.footfit");
  if (v === "0" || v === "0.25") optFoot.value = v;
} catch {}
optFoot.addEventListener("change", () => {
  try { localStorage.setItem("t2b.footfit", optFoot.value); } catch {}
  markStale();
});
const exportBtn = document.getElementById("export-step");
const exportNegBtn = document.getElementById("export-neg");

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
  // from below: only downward faces see it, so the underside (feet, rev
  // deboss, magnets) is readable in the bottom view; top views unchanged
  const under = new THREE.DirectionalLight(0xffffff, 1.1);
  under.position.set(0.4, -0.6, -1.5);
  scene.add(under);
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
                    // from below, tipped away from you: how the rev deboss
                    // reads (spun 180°, owner 2026-10-09)
                    bottom: [0, 1e-4, -1],
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
  // the rev deboss (DEBOSS_DEPTH 0.4 mm deep in deboss.js — not imported:
  // that would pull replicad into the page bundle) is hard to see in orange:
  // its faces — and only its faces: everything else down there reaches
  // >= 0.5 mm (magnet + foot chamfers) — get a light highlight colour.
  // Each CAD face has its own vertices, so colouring never bleeds.
  const col = new Float32Array(positions.length);
  const base = new THREE.Color(0xff9300), hi = new THREE.Color(0xfff2cc);
  for (let v = 0; v < positions.length / 3; v++) base.toArray(col, 3 * v);
  let zMin = Infinity;
  for (let i = 2; i < positions.length; i += 3) zMin = Math.min(zMin, positions[i]);
  let debossTris = 0;
  for (let t = 0; t < indices.length; t += 3) {
    let zTop = -Infinity;
    for (let k = 0; k < 3; k++) zTop = Math.max(zTop, positions[3 * indices[t + k] + 2]);
    const dz = zTop - zMin;
    if (dz > 0.38 && dz < 0.42) {
      for (let k = 0; k < 3; k++) hi.toArray(col, 3 * indices[t + k]);
      debossTris++;
    }
  }
  window.__debossTris = debossTris; // UI tests check the highlight
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, metalness: 0.05, roughness: 0.65,
    flatShading: false, side: THREE.DoubleSide,
    // pushed back slightly so the edge overlay draws cleanly on top
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  t.mesh = new THREE.Mesh(geo, mat);
  t.scene.add(t.mesh);
  if (t.edges) { t.scene.remove(t.edges); t.edges.geometry.dispose(); }
  t.edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 25),
    new THREE.LineBasicMaterial({ color: 0x5c3500 }));
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

// 3D model out of date: any tweak after a design's first build marks it
// stale; "Rebuild 3D" (or Download STEP) rebuilds it
const staleEl = document.getElementById("bin-stale");
const rebuildBtn = document.getElementById("rebuild-3d");
let binStale = false, buildBusy = false;
function markStale() {
  // nothing built and nothing building: the first build is still coming
  // (and will use the latest fit). A change DURING a build counts: that
  // build is of the older settings.
  if (!window.__bin && !buildBusy) return;
  binStale = true;
  updateStale();
}
function updateStale() {
  const p = window.__profile;
  const ready = !!(p && p.ok) && !profileBusy && !buildBusy;
  staleEl.hidden = !binStale;
  rebuildBtn.disabled = !ready;
  exportBtn.disabled = !ready || !(binStale || (window.__bin && window.__bin.ok));
  exportNegBtn.disabled = exportBtn.disabled;
}
rebuildBtn.addEventListener("click", () => runBuild());

async function runBuild() {
  const p = window.__profile;
  if (!p || !p.ok || profileBusy || buildBusy) return;
  binSec.style.display = "block";
  paneBin.style.display = "block";
  buildBusy = true;
  binStale = false;
  updateStale();
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
    if (revExported) { designRev++; revExported = false; }
    const r = await cadApi.build(
      { segs: p.segs, periodic: p.periodic, layout: p.layout,
        center: p.center, pocketPts: p.pocketPts, contour,
        keepCells: p.puzzle && p.puzzle.on ? p.puzzle.keep : null },
      { ...p.params, rev: designRev,
        deboss: { enabled: optDeboss.checked },
        foot_clearance: +optFoot.value,
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
  } catch (e) {
    window.__bin = { ok: false, error: String(e) };
    binStale = true; // keep the rebuild offer up for a retry
    binStatus.textContent = "error: " + (e.message || e);
  } finally {
    buildBusy = false;
    // a newer fit landed while this one was building: offer the rebuild
    if (window.__profile !== p) binStale = true;
    updateStale();
  }
}
binThickness.addEventListener("change", runProfile);
optMagnets.addEventListener("change", markStale);
optDeboss.addEventListener("change", markStale);
optEdge.addEventListener("change", runProfile);


// spaces are fine in filenames; strip only what filesystems reject
const cleanName = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "-")
  .replace(/\s+/g, " ").trim();

/** Download the bin's STEP, or its negative body ("<stem> NEG.step":
 *  the plain pocket cutout, no design embedded) — each its own button. */
async function exportFile(negative) {
  const p = window.__profile;
  if (!p || !p.ok) return;
  // never export a solid that doesn't match the settings on screen
  if (binStale) {
    await runBuild();
    if (!window.__bin || !window.__bin.ok) return;
  }
  const name = cleanName(binName.value) || "tool";
  const prefix = cleanName(binPrefix.value);
  const L = p.layout;
  try {
    busyStatus(binStatus, "writing STEP…");
    const stem = `${prefix ? prefix + " " : ""}${name} - ` +
      `${L.nx}X${L.ny}Y${L.nz}Z R${String(designRev).padStart(2, "0")}`;
    const r = await cadApi.exportStep(name, designRev, stem, negative, !negative);
    const fname = negative ? `${stem} NEG.step` : `${stem}.step`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([negative ? r.negText : r.text],
      { type: "application/step" }));
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    // either file carries this rev in its name: the next change uprevs
    revExported = true;
    binStatus.textContent = `exported ${fname} (${(r.bytes / 1024).toFixed(0)} KB)`;
  } catch (e) {
    binStatus.textContent = "export error: " + (e.message || e);
  }
}
exportBtn.addEventListener("click", () => exportFile(false));
exportNegBtn.addEventListener("click", () => exportFile(true));

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

// the design every export embeds as /* S2S| ... */ comments
async function readStepDesign(file) {
  const text = await file.text();
  const m = [...text.matchAll(/\/\* S2S\| (.*?) \*\//gs)].map((x) => x[1]);
  if (!m.length) throw new Error("no Tool2Bin design found in this STEP");
  return JSON.parse(m.join(""));
}

/** The reusable settings of a saved design: everything about how the
 *  pocket and bin are made, nothing about the tool itself (outline,
 *  thickness, scoop spots, pocket depth choice, name, rev). */
function applySettings(p) {
  if (p.clearance != null) sliders.clearance.value = p.clearance;
  if (p.smooth_r != null) sliders.smooth.value = p.smooth_r;
  if (p.scoop_d != null) sliders.scoop.value = p.scoop_d;
  if (p.scoop_blend != null) sliders.fillet.value = p.scoop_blend;
  if (p.straight_blend != null) sliders.blend.value = p.straight_blend;
  if (p.min_wall != null) sliders.wall.value = p.min_wall;
  optSymmetric.checked = p.symmetric !== false;
  optFlat.checked = !!p.flat_faithful;
  if (p.max_contour != null) optMax.checked = !!p.max_contour;
  if (p.strict_contain != null) optStrict.checked = !!p.strict_contain;
  optScoopMode.value = SCOOP_MODES.includes(p.scoop_mode)
    ? p.scoop_mode : "mirror";
  optMagnets.checked = !!(p.magnets && p.magnets.enabled);
  if (p.magnets && p.magnets.r) {
    magOd.value = (2 * p.magnets.r).toFixed(2).replace(/\.?0+$/, "");
    magH.value = (+p.magnets.depth).toFixed(2).replace(/\.?0+$/, "");
    clampMag(magOd); clampMag(magH);
  }
  optDeboss.checked = !(p.deboss && p.deboss.enabled === false);
  optEdge.value = (p.edge && p.edge.style) || "";
  if (p.foot_clearance != null) {
    optFoot.value = +p.foot_clearance === 0.25 ? "0.25" : "0";
    try { localStorage.setItem("t2b.footfit", optFoot.value); } catch {}
  }
  puzzleOn = !!p.puzzle; // applies only where it saves cells
  syncSliderLabels(); // programmatic sets fire no input events
}

// drop an exported STEP back in: revise its embedded design, no photo
async function reviseFromStep(file) {
  busyStatus(scanStatus, "reading STEP design…");
  try {
    const design = await readStepDesign(file);
    if (!design.contour) throw new Error("design has no contour (old export?)");
    window.__warp = null;
    window.__contour = { ok: true, contourMm: design.contour, fromStep: true };
    // no photo with a STEP: an earlier scan's photo would be misleading
    warpImg = null;
    paneWarp.style.display = "none";
    resetEdits(design.contour);
    window.__profile = null;
    window.__bin = null;
    if (three) three.placed = false; // new design: reframe the 3D view
    autoBuild = true; binStale = false; updateStale();
    binName.value = design.name || "tool";
    designRev = (design.rev || 1) + 1; revExported = false;
    const p = legacyScoopParams(design.params || {});
    if (p.thickness) binThickness.value = p.thickness;
    depthMode = p.depth_mode === "proud" ? "proud" : "flush";
    applySettings(p);
    customScoops = Array.isArray(p.scoops) ? p.scoops : null;
    customStraights = Array.isArray(p.straights) ? p.straights : [];
    customPocketDrags = Array.isArray(p.pocket_drags) ? p.pocket_drags : [];
    updateEditButtons();
    scanStatus.textContent = `revising '${design.name}' from its embedded ` +
      `design (next export is R${String(designRev).padStart(2, "0")})`;
    await runProfile();
  } catch (e) {
    scanStatus.textContent = "error: " + e.message;
  }
}

// reuse a good bin's settings: copy them from its STEP onto the design
// that's open now (refit, 3D goes stale); they stay for the next photo
async function settingsFromStep(file) {
  try {
    const design = await readStepDesign(file);
    applySettings(legacyScoopParams(design.params || {}));
    const rev = design.rev ? ` R${String(design.rev).padStart(2, "0")}` : "";
    scanStatus.textContent = `settings from '${design.name || "tool"}${rev}' ` +
      `applied — tool shape, thickness and scoop spots are untouched`;
    window.__settingsFrom = { name: design.name, rev: design.rev };
    customScoops = null; // re-place the scoops for the copied mode
    await runProfile(); // no-op until a design is open
  } catch (e) {
    scanStatus.textContent = "settings error: " + e.message;
  }
}

// a STEP opened while a tool is open: revise it, or take only its
// settings (one file input for everything — owner rule)
const stepChoice = document.getElementById("step-choice");
let pendingStep = null;
function askStep(file) {
  pendingStep = file;
  document.getElementById("step-choice-head").textContent =
    `'${file.name}' — what should it do?`;
  stepChoice.hidden = false;
}
for (const [id, fn] of [["step-revise", reviseFromStep],
                        ["step-settings", settingsFromStep]]) {
  document.getElementById(id).addEventListener("click", () => {
    const f = pendingStep;
    pendingStep = null;
    stepChoice.hidden = true;
    if (f) fn(f);
  });
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
  pendingStep = null;
  stepChoice.hidden = true;
  if (/\.ste?p$/i.test(file.name)) {
    return window.__contour && window.__contour.ok
      ? askStep(file) : reviseFromStep(file);
  }
  return gatePhoto(file);
}

document.getElementById("photo").addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  e.target.value = ""; // same file re-picked later must fire again
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

// desktop-first: phones are fine cameras but awkward for getting the
// STEP out, so they get a notice (the app still works under it)
if (matchMedia("(pointer: coarse) and (max-width: 900px)").matches) {
  document.getElementById("phone-note").hidden = false;
}

// PWA: cache-on-fetch service worker -> works offline after first load
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

cadCheck();
cvCheck();

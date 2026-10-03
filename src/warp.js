// Stage 1 port: paper detection + perspective warp.
// Mirrors scan2step/paper.py + template.py detect_and_warp. Runs inside the
// CV worker; `c` is the ready OpenCV instance. All Mats we create are
// deleted except the returned warp.
import { PAGES, PX_REF, layout, markerCornersMm } from "./template.js";

function matOfPoints(c, pts) {
  const flat = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => { flat[2 * i] = p[0]; flat[2 * i + 1] = p[1]; });
  return c.matFromArray(pts.length, 1, c.CV_32FC2, flat);
}

function tryTemplate(c, src, gray, pxmm, log) {
  const dict = c.getPredefinedDictionary(c.DICT_4X4_50);
  const det = new c.aruco_ArucoDetector(dict, new c.aruco_DetectorParameters(),
    new c.aruco_RefineParameters(10, 3, true));
  const cornersVec = new c.MatVector();
  const idsMat = new c.Mat();
  const rej = new c.MatVector();
  det.detectMarkers(gray, cornersVec, idsMat, rej);
  const n = idsMat.rows;
  const detected = [];
  for (let i = 0; i < n; i++) {
    const m = cornersVec.get(i); // 1x4 CV_32FC2
    const d = m.data32F;
    detected.push({ id: idsMat.intAt(i, 0),
      corners: [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]] });
    m.delete();
  }
  cornersVec.delete(); idsMat.delete(); rej.delete();
  if (detected.length < 6) return null;

  let best = null;
  for (const page of Object.keys(PAGES)) {
    const L = layout(page);
    const srcPts = [], dstPts = [], used = [];
    for (const dmark of detected) {
      if (!L.markers.has(dmark.id)) continue;
      const [mx, my] = L.markers.get(dmark.id);
      srcPts.push(...dmark.corners);
      dstPts.push(...markerCornersMm(mx, my).map(([x, y]) => [x * pxmm, y * pxmm]));
      used.push(dmark.id);
    }
    if (used.length >= 6 && (!best || used.length > best.used.length)) {
      best = { page, srcPts, dstPts, used, L };
    }
  }
  if (!best) return null;

  const srcMat = matOfPoints(c, best.srcPts);
  const dstMat = matOfPoints(c, best.dstPts);
  const mask = new c.Mat();
  // RANSAC threshold 3.0 px is defined on the reference 20 px/mm canvas
  const Hm = c.findHomography(srcMat, dstMat, c.RANSAC, 3.0 * (pxmm / PX_REF), mask);
  if (Hm.empty()) { [srcMat, dstMat, mask, Hm].forEach((m) => m.delete()); return null; }
  let inliers = 0;
  for (let i = 0; i < mask.rows; i++) inliers += mask.ucharAt(i, 0);

  const { W, H: Hmm, field } = best.L;
  const warp = new c.Mat();
  c.warpPerspective(src, warp, Hm, new c.Size(Math.floor(W * pxmm), Math.floor(Hmm * pxmm)),
    c.INTER_LINEAR, c.BORDER_CONSTANT, new c.Scalar(255, 255, 255, 255));

  // detected marker corners mapped to template mm (the parity quantity)
  const proj = new c.Mat();
  c.perspectiveTransform(srcMat, proj, Hm);
  const cornersMm = [];
  for (let i = 0; i < proj.rows; i++) {
    cornersMm.push([proj.data32F[2 * i] / pxmm, proj.data32F[2 * i + 1] / pxmm]);
  }
  [srcMat, dstMat, mask, Hm, proj].forEach((m) => m.delete());
  log(`fiducial template '${best.page}': ${best.used.length} markers, ` +
      `${inliers}/${best.srcPts.length} corner inliers`);
  return { mode: "template", page: best.page, nMarkers: best.used.length,
    markerIds: best.used, cornersMm, inliers, total: best.srcPts.length,
    field, pageMm: [W, Hmm], warp };
}

function percentile(c, gray1ch, p) {
  const srcVec = new c.MatVector();
  srcVec.push_back(gray1ch);
  const hist = new c.Mat();
  c.calcHist(srcVec, [0], new c.Mat(), hist, [256], [0, 256]);
  const total = gray1ch.rows * gray1ch.cols;
  let cum = 0, out = 255;
  for (let i = 0; i < 256; i++) {
    cum += hist.data32F[i];
    if (cum >= p * total) { out = i; break; }
  }
  srcVec.delete(); hist.delete();
  return out;
}

function quadFromMask(c, mask, imgArea) {
  const k = c.Mat.ones(31, 31, c.CV_8U);
  c.morphologyEx(mask, mask, c.MORPH_OPEN, k);
  k.delete();
  const contours = new c.MatVector();
  const hier = new c.Mat();
  c.findContours(mask, contours, hier, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
  hier.delete();
  let bestIdx = -1, bestArea = 0;
  for (let i = 0; i < contours.size(); i++) {
    const a = c.contourArea(contours.get(i));
    if (a > bestArea) { bestArea = a; bestIdx = i; }
  }
  let quad = null;
  if (bestIdx >= 0 && bestArea >= 0.15 * imgArea) {
    const hull = new c.Mat();
    c.convexHull(contours.get(bestIdx), hull);
    const approx = new c.Mat();
    c.approxPolyDP(hull, approx, 0.02 * c.arcLength(hull, true), true);
    if (approx.rows === 4) {
      quad = [];
      for (let i = 0; i < 4; i++) {
        quad.push([approx.data32S[2 * i], approx.data32S[2 * i + 1]]);
      }
    }
    hull.delete(); approx.delete();
  }
  contours.delete();
  return quad;
}

function orderCorners(q) {
  const s = q.map(([x, y]) => x + y);
  const d = q.map(([x, y]) => y - x);
  const argmin = (a) => a.indexOf(Math.min(...a));
  const argmax = (a) => a.indexOf(Math.max(...a));
  return [q[argmin(s)], q[argmin(d)], q[argmax(s)], q[argmax(d)]]; // TL TR BR BL
}

function tryPlainPaper(c, src, paper, pxmm, log) {
  let [pw, ph] = PAGES[paper];
  const imgArea = src.rows * src.cols;
  const blur = new c.Mat();
  c.GaussianBlur(src, blur, new c.Size(41, 41), 0);
  const rgb = new c.Mat();
  c.cvtColor(blur, rgb, c.COLOR_RGBA2RGB);
  const hsv = new c.Mat();
  c.cvtColor(rgb, hsv, c.COLOR_RGB2HSV);
  blur.delete(); rgb.delete();

  // candidate thresholds, strict-inequality bounds matching the reference
  const mk = (lo, hi) => {
    const m = new c.Mat();
    const l = new c.Mat(hsv.rows, hsv.cols, hsv.type(), new c.Scalar(...lo));
    const h = new c.Mat(hsv.rows, hsv.cols, hsv.type(), new c.Scalar(...hi));
    c.inRange(hsv, l, h, m);
    l.delete(); h.delete();
    return m;
  };
  const vCh = new c.MatVector();
  c.split(hsv, vCh);
  const p75 = percentile(c, vCh.get(2), 0.75);
  const candidates = [
    ["tuned", () => mk([86, 9, 181], [109, 44, 255])],
    ["bright-unsat", () => mk([0, 0, 161], [180, 59, 255])],
    ["bright", () => mk([0, 0, p75 + 1], [180, 255, 255])],
  ];
  vCh.delete();

  let quad = null;
  for (const [name, make] of candidates) {
    const m = make();
    quad = quadFromMask(c, m, imgArea);
    m.delete();
    if (quad) { log(`paper found via '${name}' threshold`); break; }
  }
  hsv.delete();
  if (!quad) throw new Error("paper sheet not found; adjust lighting or thresholds");

  const srcQ = orderCorners(quad);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = dist(srcQ[1], srcQ[0]), left = dist(srcQ[3], srcQ[0]);
  if (top > left && pw < ph) { [pw, ph] = [ph, pw]; log("paper is landscape in photo; canvas swapped"); }
  const W = pw * pxmm, Hpx = ph * pxmm;
  const srcMat = matOfPoints(c, srcQ);
  const dstMat = matOfPoints(c, [[0, 0], [W, 0], [W, Hpx], [0, Hpx]]);
  const M = c.getPerspectiveTransform(srcMat, dstMat);
  const warp = new c.Mat();
  c.warpPerspective(src, warp, M, new c.Size(Math.floor(W), Math.floor(Hpx)),
    c.INTER_LINEAR, c.BORDER_CONSTANT, new c.Scalar(255, 255, 255, 255));
  const bot = dist(srcQ[2], srcQ[3]), right = dist(srcQ[2], srcQ[1]);
  const skew = Math.max(Math.abs(top - bot) / Math.max(top, bot),
    Math.abs(left - right) / Math.max(left, right));
  log(`quad side skew ${(skew * 100).toFixed(1)}% (shoot more top-down if large)`);
  [srcMat, dstMat, M].forEach((m) => m.delete());
  return { mode: "plain", quadPx: srcQ, pageMm: [pw, ph], skew, field: null, warp };
}

/** Returns meta + a live warp Mat (caller owns/deletes it). */
export function detectAndWarp(c, imageData, paper = "letter", pxmm = PX_REF, log = () => {}) {
  const src = c.matFromImageData(imageData);
  const gray = new c.Mat();
  c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
  let out = null;
  try {
    out = tryTemplate(c, src, gray, pxmm, log);
    if (!out) out = tryPlainPaper(c, src, paper, pxmm, log);
    out.pxmm = pxmm;
    return out;
  } finally {
    src.delete(); gray.delete();
  }
}

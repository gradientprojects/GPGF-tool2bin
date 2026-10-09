// Web Worker: owns the OpenCV WASM instance (bundled from
// @techstark/opencv-js, pinned to the 4.x line to match the reference
// pipeline). C1 scope: capability report + ArUco detection on the
// synthetic template fixture.
import cvPromise from "@techstark/opencv-js";

const WANT = ["Mat", "matFromImageData", "cvtColor", "resize", "dilate",
  "morphologyEx", "GaussianBlur", "medianBlur", "warpPerspective", "warpAffine",
  "findHomography", "getPerspectiveTransform", "estimateAffine2D", "inpaint",
  "connectedComponentsWithStats", "findContours", "threshold",
  "aruco_ArucoDetector", "aruco_DetectorParameters", "aruco_RefineParameters",
  "getPredefinedDictionary", "DICT_4X4_50"];

async function cvReady() {
  let c = cvPromise;
  if (c && typeof c.then === "function") c = await c;
  if (c && !c.Mat && "onRuntimeInitialized" in c) {
    await new Promise((res) => { c.onRuntimeInitialized = res; });
  }
  return c;
}

function detectAruco(c, imageData) {
  const src = c.matFromImageData(imageData);
  const gray = new c.Mat();
  c.cvtColor(src, gray, c.COLOR_RGBA2GRAY);
  const dict = c.getPredefinedDictionary(c.DICT_4X4_50);
  const det = new c.aruco_ArucoDetector(dict, new c.aruco_DetectorParameters(),
    new c.aruco_RefineParameters(10, 3, true));
  const corners = new c.MatVector();
  const ids = new c.Mat();
  const rejected = new c.MatVector();
  det.detectMarkers(gray, corners, ids, rejected);
  const out = [];
  for (let i = 0; i < ids.rows; i++) out.push(ids.intAt(i, 0));
  [src, gray, ids].forEach((m) => m.delete());
  corners.delete(); rejected.delete();
  return { supported: true, ids: out.sort((a, b) => a - b) };
}

import { detectAndWarp } from "./warp.js";
import { segment } from "./segment.js";
import { findPose, rotateContour, toOrientedMm } from "./pose.js";
import { profileResponse, clearProfileCache, quickPocket } from "./profilestage.js";

let lastContourMm = null; // oriented mm contour from the contour stage
let lastProfile = null;

let lastWarp = null; // Mat kept worker-side for the later pipeline stages
let lastField = null;
let lastPxmm = 20;

function preview(c, mat, maxW = 560) {
  const s = Math.min(1, maxW / mat.cols);
  const small = new c.Mat();
  c.resize(mat, small, new c.Size(Math.round(mat.cols * s), Math.round(mat.rows * s)),
    0, 0, c.INTER_AREA);
  const id = new ImageData(new Uint8ClampedArray(small.data), small.cols, small.rows);
  small.delete();
  return id;
}

async function selftest(imageData) {
  const c = await cvReady();
  const caps = {};
  for (const k of WANT) caps[k] = typeof c[k] !== "undefined";
  let aruco = { supported: false, ids: [] };
  let error = null;
  try {
    if (caps.aruco_ArucoDetector) aruco = detectAruco(c, imageData);
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  const build = c.getBuildInformation()
    .split("\n").find((l) => l.includes("Version control")) || "";
  return { ok: true, caps, aruco, error, build: build.trim() };
}

async function warp({ imageData, paper = "letter", pxmm = 20 }, tick = () => {}) {
  const c = await cvReady();
  const logs = [];
  const t0 = performance.now();
  tick(0.05, "finding the sheet");
  // the detect stages have no finer hooks than their log milestones
  let n = 0;
  const log = (l) => { logs.push(l); tick(Math.min(0.1 + ++n * 0.2, 0.7)); };
  const r = detectAndWarp(c, imageData, paper, pxmm, log);
  tick(0.85, "warping");
  if (lastWarp) lastWarp.delete();
  lastWarp = r.warp;
  lastField = r.field || null;
  lastPxmm = r.pxmm;
  const { warp: _drop, ...meta } = r;
  const img = preview(c, lastWarp);
  return { ok: true, ...meta, logs, ms: Math.round(performance.now() - t0),
    warpSize: [lastWarp.cols, lastWarp.rows], preview: img };
}

// Stages 2+3 (segmentation + pose) on the last warp, or on an injected
// warp canvas (imageData + field) — the latter is how the parity suite
// gates this port on input identical to the reference's.
async function contour({ imageData = null, field, pxmm }, tick = () => {}) {
  const c = await cvReady();
  const logs = [];
  const log = (l) => logs.push(l);
  const t0 = performance.now();
  let src = lastWarp, fld = lastField, px = lastPxmm;
  const own = imageData != null;
  if (own) {
    src = c.matFromImageData(imageData);
    fld = field || null;
    px = pxmm || 20;
  } else if (!src) {
    throw new Error("no warp available; run warp first");
  }
  const seg = segment(c, src, fld, px, log,
    (f) => tick(0.02 + f * 0.83, "segmenting"));
  tick(0.87, "finding the symmetry axis");
  const pose = findPose(c, seg.mask, log);
  tick(0.97, "orienting");
  const rot = rotateContour(seg.contourPx, pose.angle, pose.center, src.cols);
  const { cMm, flipped, centerMm } = toOrientedMm(rot, px, log);
  lastContourMm = cMm;
  clearProfileCache();
  seg.mask.delete();
  if (own) src.delete();
  return { ok: true, contourMm: cMm, contourPx: seg.contourPx,
    angleDeg: pose.angle, iou: pose.iou, centerPx: pose.center,
    areaMm2: seg.areaMm2, flipped, centerMm, logs,
    ms: Math.round(performance.now() - t0) };
}

// Stages 4-5: pocket profile from the oriented contour (last computed,
// or injected for parity), at the given UI params.
async function profile({ contourMm = null, params = {} }) {
  const c = await cvReady();
  const logs = [];
  const t0 = performance.now();
  const src = contourMm || lastContourMm;
  if (!src) throw new Error("no contour available; run contour first");
  const r = profileResponse(c, src, params, (l) => logs.push(l));
  lastProfile = r;
  // segs (tck data) ride along: the CAD worker builds the solid from them
  return { ok: true, fit: r.fit, pocketPts: r.pocketPts, layout: r.layout,
    center: r.center, scoops: r.scoops, warnings: r.warnings,
    depthChoice: r.depthChoice, timings: r.timings, cached: r.cached,
    periodic: r.periodic, segs: r.segs, straightLines: r.straightLines,
    straightInfo: r.straightInfo, puzzle: r.puzzle, logs,
    ms: Math.round(performance.now() - t0) };
}

const HANDLERS = {
  selftest: (d) => selftest(d.imageData),
  warp: (d, tick) => warp(d, tick),
  contour: (d, tick) => contour(d, tick),
  profile: (d) => profile(d),
  // fast approximate pocket shown while a full refit runs
  quick: async (d) => {
    const src = d.contourMm || lastContourMm;
    if (!src) throw new Error("no contour available; run contour first");
    return { ok: true, ...quickPocket(await cvReady(), src, d.params || {}) };
  },
};

self.onmessage = async (e) => {
  const { type = "selftest", reqId } = e.data;
  const tick = (frac, stage) => self.postMessage({ reqId, progress: true, frac, stage });
  try {
    const result = await HANDLERS[type](e.data, tick);
    const transfer = result.preview ? [result.preview.data.buffer] : [];
    self.postMessage({ reqId, ...result }, transfer);
  } catch (err) {
    self.postMessage({ reqId, ok: false, error: String(err && err.stack || err) });
  }
};

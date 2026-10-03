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

self.onmessage = async (e) => {
  try {
    const c = await cvReady();
    const caps = {};
    for (const k of WANT) caps[k] = typeof c[k] !== "undefined";
    let aruco = { supported: false, ids: [] };
    let error = null;
    try {
      if (caps.aruco_ArucoDetector) aruco = detectAruco(c, e.data.imageData);
    } catch (err) {
      error = String(err && err.message ? err.message : err);
    }
    const build = c.getBuildInformation()
      .split("\n").find((l) => l.includes("Version control")) || "";
    self.postMessage({ ok: true, caps, aruco, error, build: build.trim() });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};

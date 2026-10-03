import { wrap } from "comlink";

// results Playwright asserts on
window.__selftest = { cad: null, cv: null };

function setCheck(id, ok, text) {
  const el = document.getElementById(id);
  el.classList.add(ok ? "ok" : "bad");
  el.querySelector(".st").textContent = text;
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
    const bmp = await createImageBitmap(await resp.blob());
    const cnv = document.createElement("canvas");
    cnv.width = bmp.width; cnv.height = bmp.height;
    const ctx = cnv.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const imageData = ctx.getImageData(0, 0, bmp.width, bmp.height);

    const worker = new Worker(new URL("./cv.worker.js", import.meta.url),
      { type: "module" });
    const result = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("cv worker timeout (90s)")), 90000);
      worker.onmessage = (e) => { clearTimeout(to); resolve(e.data); };
      worker.onerror = (e) => { clearTimeout(to); reject(new Error(e.message)); };
      worker.postMessage({ imageData }, [imageData.data.buffer]);
    });

    window.__selftest.cv = result;
    const capsEl = document.getElementById("caps");
    if (!result.ok) {
      setCheck("check-cv", false, result.error || "failed");
      return;
    }
    const missing = Object.entries(result.caps).filter(([, v]) => !v).map(([k]) => k);
    capsEl.textContent =
      (result.build ? result.build + "\n" : "") +
      `capabilities: ${Object.entries(result.caps).filter(([, v]) => v).map(([k]) => k).join(", ")}\n` +
      (missing.length ? `missing: ${missing.join(", ")}\n` : "") +
      (result.error ? `aruco error: ${result.error}\n` : "");
    const n = result.aruco.ids.length;
    const ok = result.aruco.supported && n >= 6;
    setCheck("check-cv", ok,
      result.aruco.supported ? `ArUco: ${n}/24 markers on the synthetic template`
        : "ArUco NOT exposed by this opencv.js build");
  } catch (e) {
    window.__selftest.cv = { ok: false, error: String(e) };
    setCheck("check-cv", false, String(e));
  }
}

cadCheck();
cvCheck();

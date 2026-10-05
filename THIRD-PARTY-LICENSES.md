# Third-party licenses

This app bundles the following third-party components. Their license
texts are available at the linked projects.

## Runtime

- **Open CASCADE Technology (OCCT)** — LGPL-2.1 (with the OCCT
  exception). Compiled to WebAssembly and shipped as the separate
  `replicad_single.wasm` file via
  [replicad-opencascadejs](https://github.com/sgenoud/replicad) (the
  npm wrapper itself is MIT). The WASM module loads as a standalone
  file, so it can be replaced/relinked as the LGPL requires.
  <https://dev.opencascade.org>
- **replicad** — MIT. <https://replicad.xyz>
- **OpenCV** — Apache-2.0, bundled as WebAssembly via
  [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js)
  (wrapper also Apache-2.0). <https://opencv.org>
- **three.js** — MIT. <https://threejs.org>
- **comlink** — Apache-2.0. <https://github.com/GoogleChromeLabs/comlink>
- **Inter** (typeface by Rasmus Andersson) — SIL Open Font License 1.1.
  `src/assets/t2b-rev-bold.ttf` is a subset of Inter Bold v4.1 (the
  glyphs R and 0–9), renamed "T2B Rev" in accordance with the OFL's
  Reserved Font Name clause. <https://rsms.me/inter/>

## Development only (not distributed)

- **Vite** — MIT. **Playwright** — Apache-2.0.

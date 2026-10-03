# GPGF-Tool2Bin

Photograph a tool on a printed template — get a Gridfinity bin as a
**STEP** file, ready for CAD or slicing. Everything runs in your
browser: the photo never leaves your device, there is no server, no
account, no tracking.

**Status: early scaffold.** The current page is an engine self-test
(OpenCASCADE WASM STEP export + OpenCV.js ArUco detection). The scan →
profile → bin pipeline lands next.

## How it will work

1. Print the template sheet (ArUco border + gray field) at 100% scale.
2. Put your tool on it, take a photo with your phone.
3. The app warps, segments, and fits a clean closed profile, sizes a
   Gridfinity bin around it (42 mm grid), adds finger scallops and
   optional magnet pockets.
4. Download the STEP. The design parameters ride inside the file as
   STEP comments, so dropping an exported file back onto the page
   reopens it for revision.

## Development

```bash
npm install
npm run dev        # vite dev server
npm run build && npm test   # build + playwright smoke tests
```

Vision runs on [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js)
(OpenCV 4.x as WebAssembly) and geometry on [replicad](https://replicad.xyz)
(OpenCASCADE as WebAssembly) — each inside its own Web Worker.

## License

Not yet chosen — all rights reserved for now.

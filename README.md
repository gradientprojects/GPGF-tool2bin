# GPGF-Tool2Bin

Photograph a tool on a printed template — get a Gridfinity bin as a
**STEP** file, ready for CAD or slicing. Everything runs in your
browser: the photo never leaves your device, there is no server, no
account, no tracking. After the first load it works offline (PWA).

## How it works

1. **Print the template** (letter or A4, linked on the page) at 100%
   scale — verify the printed 100 mm ruler. Plain paper works too,
   the template is just much more robust in uneven light.
2. **Take a photo** of your tool on the sheet (on a phone the button
   opens the camera directly).
3. The app perspective-corrects the sheet via the ArUco border,
   segments the tool with illumination-normalized scoring, finds its
   symmetry axis, and fits a smooth pocket profile — clearance,
   smoothness, finger scallops, symmetry and wall thickness are all
   live controls.
4. A full Gridfinity bin (42 mm grid, standard foot profile, optional
   6 mm magnet pockets, chamfered rim) is built in OpenCASCADE —
   in your browser — and shown in 3D.
5. **Download the STEP.** The design (parameters + tool outline) rides
   inside the file as STEP comments: drop an exported file back onto
   the page and it reopens for revision, no photo needed.

Pocket guarantees: by default the pocket keeps the requested clearance
to the tool *everywhere* (smoothing may only bow outward), and a "max
contour" toggle makes it ignore concave notches entirely.

## Development

```bash
npm install
npm run dev                 # vite dev server
npm run build && npm test   # build + playwright tests
```

Vision runs on [@techstark/opencv-js](https://www.npmjs.com/package/@techstark/opencv-js)
(OpenCV 4.x as WebAssembly) and geometry on the raw
[OpenCASCADE](https://dev.opencascade.org) kernel from
[replicad-opencascadejs](https://replicad.xyz) — each inside its own
Web Worker. The numeric pipeline (P-spline fitting, signed-distance
morphology, marching squares) is a line-faithful port of a private
Python reference implementation and is pinned to it by golden-value
tests; the committed fixtures under `tests/fixtures/` let CI verify
the full chain standalone.

## License

Not yet chosen — all rights reserved for now.

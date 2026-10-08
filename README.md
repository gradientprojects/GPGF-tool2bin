# GPGF-tool2bin

Photograph a tool on a printed template — get a Gridfinity bin as a
**STEP** file, ready for CAD or slicing. Everything runs in your
browser: the photo never leaves your device, there is no server, no
account, no tracking. After the first load it works offline (PWA).

## How it works

1. **Print the template** (letter or A4, linked on the page) at 100%
   scale — verify the printed 100 mm ruler. Plain paper works too,
   the template is just much more robust in uneven light.
2. **Photograph your tool** on the sheet with any camera (a phone is
   fine) and upload the photo on your computer — the app is built for
   desktop browsers.
3. The app perspective-corrects the sheet via the ArUco border,
   segments the tool with illumination-normalized scoring, finds its
   symmetry axis, and fits a smooth pocket profile — clearance,
   smoothness, finger scallops, symmetry and wall thickness are all
   live controls.
4. A full Gridfinity bin (42 mm grid, standard foot profile, optional
   6 mm magnet pockets, chamfered rim) is built in OpenCASCADE —
   in your browser — and shown in 3D. The revision (R01, R02, …) is
   debossed 0.4 mm into the underside so printed bins stay
   identifiable; it can be toggled off.
5. **Download the STEP.** Files are named like
   `GPGF-t2b snips - 2X4Y5Z R01.step` — footprint in Gridfinity units
   plus a revision; the prefix is editable and remembered per device.
   The design (parameters + tool outline) rides inside the file as
   STEP comments: drop an exported file back onto the page and it
   reopens for revision, no photo needed — and the next export uprevs
   itself (R01 → R02).

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

Copyright © 2026 Gradient Projects.
[GNU AGPL-3.0](LICENSE). In short: use it, print with it, study it,
modify it — but if you host this app (or a service built from its
code, modified or not, even one that only talks to users over a
network), you must make your complete source available under the same
terms.

- **Your exports are yours.** The STEP files and bins this app
  produces are your own work product; the AGPL does not apply to them.
  Print them, sell the prints, do as you like.
- For licensing under other terms, open an issue on this repository.

Bundled third-party components are listed in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

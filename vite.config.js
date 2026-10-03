import { defineConfig } from "vite";

// base "./" keeps asset paths relative so the build works from any GitHub
// Pages subpath without hardcoding it.
export default defineConfig({
  base: "./",
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // The OpenCASCADE wasm glue ships as a large prebuilt module; let Vite
    // serve it as-is rather than trying to pre-bundle it.
    exclude: ["replicad-opencascadejs"],
  },
});

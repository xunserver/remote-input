import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/decoderBundle.ts"),
      name: "RemoteInputDecoder",
      formats: ["iife"],
      fileName: () => "remote-input-decoder.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
  },
});

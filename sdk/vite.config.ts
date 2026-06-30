import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "RemoteInput",
      formats: ["iife"],
      fileName: () => "remote-input-sdk.js",
    },
    outDir: "dist",
    sourcemap: false,
  },
});

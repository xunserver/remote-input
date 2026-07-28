import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@shadcn": path.resolve(__dirname, "src/shadcn"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:17888",
      "/ws": {
        target: "http://127.0.0.1:17888",
        ws: true,
      },
    },
  },
});

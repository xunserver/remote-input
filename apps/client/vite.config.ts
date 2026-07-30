import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const buildBookmarkletLibrary =
    mode === "bookmarklet-lib" || mode === "pages-lib";
  const buildPublicPages = mode === "pages" || mode === "pages-lib";
  const outDir = path.resolve(
    __dirname,
    buildPublicPages ? "dist-pages" : "dist",
  );
  const pageInputs: Record<string, string> = {
    sender: path.resolve(__dirname, "index.html"),
    bookmarklet: path.resolve(__dirname, "bookmarklet/index.html"),
    webhid: path.resolve(__dirname, "webhid/index.html"),
  };
  if (!buildPublicPages) {
    pageInputs.receive = path.resolve(__dirname, "receive/index.html");
  }

  return {
    root: __dirname,
    base: process.env.VITE_BASE_PATH || "/",
    plugins: buildBookmarkletLibrary ? [] : [vue(), tailwindcss()],
    resolve: {
      alias: {
        "@shadcn": path.resolve(__dirname, "src/shadcn"),
        "@": path.resolve(__dirname, "src"),
      },
    },
    build: buildBookmarkletLibrary
      ? {
          outDir,
          emptyOutDir: false,
          lib: {
            entry: path.resolve(__dirname, "src/bookmarklet/loader.ts"),
            formats: ["iife"],
            name: "RemoteInputBookmarkletLoader",
            fileName: () => "bookmarklet.js",
          },
        }
      : {
          outDir,
          emptyOutDir: true,
          rollupOptions: {
            input: pageInputs,
          },
        },
    server: {
      port: 5173,
      proxy: {
        "/api": "http://127.0.0.1:17888",
        "/events": "http://127.0.0.1:17888",
        "/ws": {
          target: "http://127.0.0.1:17888",
          ws: true,
        },
      },
    },
  };
});

import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__dirname, "src/main/index.ts") },
    },
    resolve: {
      alias: {
        "@common": resolve(__dirname, "src/common"),
        "@protocol": resolve(__dirname, "../../packages/protocol/src"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__dirname, "src/preload/index.ts") },
      // Sandboxed preloads must be CommonJS.
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "index.cjs", chunkFileNames: "[name].cjs" },
      },
    },
    resolve: {
      alias: {
        "@protocol": resolve(__dirname, "../../packages/protocol/src"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      outDir: "out/renderer",
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@protocol": resolve(__dirname, "../../packages/protocol/src"),
      },
    },
  },
});

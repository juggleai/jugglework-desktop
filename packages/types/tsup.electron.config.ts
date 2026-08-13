import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "desktop-remote-control": "src/desktop-remote-control.ts",
    "agent-runtime-rollout": "src/agent-runtime/rollout.ts",
  },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  outDir: "../../apps/desktop/dist/runtime",
  clean: true,
  dts: false,
  target: "node22",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  minify: true,
  banner: {
    js: "// @ts-nocheck -- generated, bundled Electron runtime contract",
  },
  // Bundle zod and every shared implementation dependency so the packaged
  // Electron process never resolves this workspace package at runtime.
  noExternal: [/.*/],
})

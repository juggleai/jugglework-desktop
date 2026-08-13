import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "agent-runtime": "src/agent-runtime.ts",
    "desktop-remote-control": "src/desktop-remote-control.ts",
    "runtime-session": "src/runtime-session.ts",
    "codex-gateway": "src/den/codex-gateway.ts",
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

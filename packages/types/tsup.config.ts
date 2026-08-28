import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "agent-context-diagnostics": "src/agent-context-diagnostics.ts",
    "desktop-remote-control": "src/desktop-remote-control.ts",
    automation: "src/automation.ts",
    "jugglework-affordance": "src/jugglework-affordance.ts",
    "jugglework-context": "src/jugglework-context.ts",
    "jugglework-provider": "src/jugglework-provider.ts",
    "den/desktop-app-restrictions": "src/den/desktop-app-restrictions.ts",
    "den/desktop-policies": "src/den/desktop-policies.ts",
    "den/egress-diagnostics": "src/den/egress-diagnostics.ts",
    "den/mcp-connection-action": "src/den/mcp-connection-action.ts",
    "den/microsoft-365": "src/den/microsoft-365.ts",
  },
  tsconfig: "./tsconfig.json",
  format: ["esm"],
  dts: {
    tsconfig: "./tsconfig.json",
  },
  clean: true,
  target: "es2022",
  platform: "neutral",
  sourcemap: false,
  splitting: false,
  treeshake: true,
  minify: true,
  external: ["zod"],
})

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const node = process.execPath;

const serverFiles = [
  "src/agent-engine/registry.test.ts",
  "src/agent-engine/opencode-adapter.test.ts",
  "src/agent-engine/claude-adapter.test.ts",
  "src/agent-runtime-persistence/repository.test.ts",
  "src/agent-runtime-persistence/policy-audit-repository.test.ts",
  "src/legacy-importers/opencode-sqlite.test.ts",
  "src/agent-runtime-continuation.test.ts",
  "src/agent-runtime-control-plane.continuation.test.ts",
  "src/agent-runtime-routes.e2e.test.ts",
  "src/interaction-resolution-coordinator.test.ts",
  "src/interaction-resolution.e2e.test.ts",
  "src/agent-tool-policy/pre-tool-policy.test.ts",
  "src/claude-environment.test.ts",
  "src/claude-credentials.test.ts",
  "src/claude-credential-diagnostics.test.ts",
  "src/claude-profile-data.test.ts",
  "src/claude-worker-process-manager.test.ts",
  "src/claude-internal-tools-server.test.ts",
  "src/claude-mcp-runtime-config.test.ts",
  "src/claude-plugin-bundle.e2e.test.ts",
  "src/claude-advanced-rollout.test.ts",
  "src/agent-runtime-telemetry.test.ts",
  "src/opencode-mounted-cleanup.test.ts",
];

const desktopFiles = [
  "electron/claude-runtime-assets.test.mjs",
  "electron/claude-anthropic-secret-store.test.mjs",
  "electron/runtime.test.mjs",
  "electron/remote-control-agent.test.mjs",
  "electron/remote-control-mutation-adapters.test.mjs",
  "electron/remote-control-interaction-store.test.mjs",
  "electron/remote-control-read-adapters.test.mjs",
  "electron/remote-control-operations.test.mjs",
  "electron/remote-control-pending-policy.test.mjs",
  "electron/remote-session-event-bridge.test.mjs",
  "electron/remote-session-projector.test.mjs",
  "electron/sandbox-runtime.test.mjs",
  "electron/updater.test.mjs",
];

const suites = [
  {
    name: "cross-runtime contracts",
    command: pnpm,
    args: ["--filter", "@jugglework/types", "test"],
  },
  {
    name: "migration, security, and control plane",
    command: pnpm,
    args: ["--dir", "apps/server", "exec", "bun", "test", ...serverFiles],
  },
  {
    name: "worker security, sandbox, and performance",
    command: pnpm,
    args: ["--filter", "@jugglework/claude-agent-worker", "test"],
  },
  {
    name: "renderer accessibility and runtime experience",
    command: pnpm,
    args: [
      "--dir", "apps/app", "exec", "bun", "test", "--isolate",
      "tests/canonical-agent-foundation.test.ts",
      "tests/agent-runtime-accessibility.test.tsx",
      "tests/permission-approval-modal.test.ts",
      "tests/desktop-remote-control-section.test.tsx",
    ],
  },
  {
    name: "desktop runtime contract build",
    command: pnpm,
    args: ["--filter", "@jugglework/types", "build:electron-runtime"],
  },
  {
    name: "desktop, remote control, sandbox, and updater",
    command: node,
    args: ["--test", ...desktopFiles],
    cwd: "apps/desktop",
  },
  {
    name: "headless lifecycle",
    command: pnpm,
    args: ["--dir", "apps/server", "exec", "bun", "test", "src/cli-lifecycle.test.ts", "src/runtime-db.node.test.ts"],
  },
  {
    name: "installed desktop runtime smoke",
    command: node,
    args: ["apps/claude-agent-worker/scripts/check-package-content.mjs", "apps/desktop/resources/claude-agent"],
  },
  {
    name: "installed worker startup, cancellation, and shutdown",
    command: node,
    args: ["apps/claude-agent-worker/scripts/installed-smoke.mjs", "apps/desktop/resources/claude-agent"],
  },
  {
    name: "release and updater assets",
    command: node,
    args: ["--test", "scripts/release/verify-electron-updater-assets.test.mjs"],
  },
  {
    name: "release review",
    command: node,
    args: ["scripts/release/review.mjs", "--strict"],
  },
];

const environment = { ...process.env };
for (const name of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "JUGGLEWORK_CLAUDE_AGENT_LIVE_SMOKE",
  "JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH",
  "JUGGLEWORK_CLAUDE_EXECUTABLE_PATH",
]) delete environment[name];

function run(suite) {
  const startedAt = Date.now();
  process.stdout.write(`\n==> ${suite.name}\n`);
  return new Promise((resolve) => {
    const child = spawn(suite.command, suite.args, {
      cwd: suite.cwd ? fileURLToPath(new URL(`${suite.cwd}/`, new URL("../..", import.meta.url))) : root,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => resolve({ suite, ok: false, durationMs: Date.now() - startedAt, error }));
    child.once("exit", (code, signal) => resolve({
      suite,
      ok: code === 0,
      durationMs: Date.now() - startedAt,
      error: code === 0 ? null : new Error(signal ? `terminated by ${signal}` : `exited with code ${code}`),
    }));
  });
}

const results = [];
for (const suite of suites) results.push(await run(suite));

process.stdout.write("\nMulti-runtime acceptance summary\n");
for (const result of results) {
  process.stdout.write(`- ${result.ok ? "PASS" : "FAIL"} ${result.suite.name} (${(result.durationMs / 1000).toFixed(1)}s)${result.error ? `: ${result.error.message}` : ""}\n`);
}
process.stdout.write("- SKIP Claude provider live smoke (run pnpm test:acceptance:multi-runtime:live with explicit paths and a real API key)\n");

if (results.some((result) => !result.ok)) process.exitCode = 1;

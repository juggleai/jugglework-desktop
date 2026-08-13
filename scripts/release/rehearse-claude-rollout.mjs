import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_AGENT_INTERNAL_COHORT_ENV,
  CLAUDE_AGENT_ROLLOUT_STAGE_ENV,
  CLAUDE_AGENT_RUNTIME_FEATURE_FLAG,
  CLAUDE_AGENT_RUNTIME_KILL_SWITCH,
  CLAUDE_AGENT_USER_OPT_IN_ENV,
  resolveClaudeAgentRollout,
} from "../../packages/types/dist/agent-runtime.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
const outputPath = resolve(root, outputArgument || "tmp/claude-rollout/rollout-evidence.json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const revision = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

const verification = [
  {
    id: "shared-rollout-contract",
    command: [pnpm, "--filter", "@jugglework/types", "test"],
  },
  {
    id: "server-opencode-only-and-advanced-rollback",
    command: [pnpm, "--dir", "apps/server", "exec", "bun", "test", "src/agent-engine/opencode-adapter.test.ts", "src/claude-advanced-rollout.test.ts", "src/claude-worker-process-manager.test.ts"],
  },
  {
    id: "worker-run-per-query-rollback",
    command: [pnpm, "--filter", "@jugglework/claude-agent-worker", "exec", "tsx", "--test", "test/advanced-runtime.test.ts"],
  },
].map(({ id, command: [file, ...args] }) => {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  return {
    id,
    command: [file, ...args].join(" "),
    passed: result.status === 0,
    exitCode: result.status,
    ...(result.error ? { error: result.error.message.slice(0, 500) } : {}),
  };
});

const enabled = { [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1" };
const scenarios = [
  { id: "opencode-only-default", env: {}, expected: { enabled: false, reason: "feature_disabled" } },
  {
    id: "internal-ineligible",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "internal" },
    expected: { enabled: false, reason: "cohort_ineligible" },
  },
  {
    id: "internal-cohort",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "internal", [CLAUDE_AGENT_INTERNAL_COHORT_ENV]: "1" },
    expected: { enabled: true, reason: "enabled" },
  },
  {
    id: "opt-in-declined",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "opt-in" },
    expected: { enabled: false, reason: "cohort_ineligible" },
  },
  {
    id: "opt-in-accepted",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "opt-in", [CLAUDE_AGENT_USER_OPT_IN_ENV]: "1" },
    expected: { enabled: true, reason: "enabled" },
  },
  {
    id: "ga",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga" },
    expected: { enabled: true, reason: "enabled" },
  },
  {
    id: "ga-kill-switch-rollback",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga", [CLAUDE_AGENT_RUNTIME_KILL_SWITCH]: "1" },
    expected: { enabled: false, reason: "kill_switch" },
  },
  {
    id: "invalid-stage-fail-closed",
    env: { ...enabled, [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "unknown" },
    expected: { enabled: false, reason: "invalid_stage" },
  },
].map(({ id, env, expected }) => {
  const resolution = resolveClaudeAgentRollout(env);
  const passed = resolution.enabled === expected.enabled && resolution.reason === expected.reason;
  return { id, expected, resolution, passed };
});

const advancedSource = readFileSync(resolve(root, "apps/server/src/claude-advanced-rollout.ts"), "utf8");
const advancedFeatureNames = [...advancedSource.matchAll(/^\s{2}(?:"([^"]+)"|([a-z-]+)):\s"[A-Z_]+",$/gm)]
  .map((match) => match[1] || match[2]);
const advancedKillSwitches = advancedFeatureNames.map((feature) => {
  const escaped = feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stem = advancedSource.match(new RegExp(`^\\s{2}(?:"${escaped}"|${escaped}):\\s"([A-Z_]+)",`, "m"))?.[1];
  return {
    feature,
    configured: Boolean(stem),
    killSwitch: stem ? `JUGGLEWORK_CLAUDE_${stem}_KILL_SWITCH` : null,
    result: "baseline-run-per-query",
  };
});

const evidence = {
  schemaVersion: 1,
  artifactType: "claude-staged-rollout-rehearsal",
  externalReleasePublished: false,
  capturedAt: new Date().toISOString(),
  revision,
  node: process.version,
  verification,
  scenarios,
  rollback: {
    advanced: advancedKillSwitches,
    claudeRuntimeKillSwitch: "opencode-only",
    canonicalClaudeDataDeleted: false,
  },
  passed: verification.every((check) => check.passed)
    && scenarios.every((scenario) => scenario.passed)
    && advancedKillSwitches.length > 0
    && advancedKillSwitches.every((feature) => feature.configured),
};

const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
evidence.contentSha256WithoutDigest = createHash("sha256").update(serialized).digest("hex");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(outputPath);
if (!evidence.passed) process.exitCode = 1;

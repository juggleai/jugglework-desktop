import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const appPkg = readJson(resolve(root, "apps", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "apps", "desktop", "package.json"));
const pinnedOpencodeVersion = String(
  readJson(resolve(root, "constants.json")).opencodeVersion ?? "",
)
  .trim()
  .replace(/^v/, "");
const serverPkg = readJson(resolve(root, "apps", "server", "package.json"));
const workerPkg = readJson(resolve(root, "apps", "claude-agent-worker", "package.json"));
const claudePackageScript = readFileSync(
  resolve(root, "apps", "claude-agent-worker", "scripts", "package-assets.mjs"),
  "utf8",
);
const electronBuilder = readFileSync(resolve(root, "apps", "desktop", "electron-builder.yml"), "utf8");
const afterPack = readFileSync(resolve(root, "apps", "desktop", "scripts", "electron-after-pack.cjs"), "utf8");
const releaseWorkflow = readFileSync(resolve(root, ".github", "workflows", "release-macos-aarch64.yml"), "utf8");
const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const compatibilityDocPath = resolve(root, "docs", "operations", "claude-runtime-compatibility.md");
const runbookPath = resolve(root, "docs", "operations", "claude-runtime-release-runbook.md");
const compatibilityDoc = readFileSync(compatibilityDocPath, "utf8");
const runbook = readFileSync(runbookPath, "utf8");
const rolloutWorkflow = readFileSync(resolve(root, ".github", "workflows", "ci-tests.yml"), "utf8");
const rolloutResolver = readFileSync(resolve(root, "packages", "types", "src", "agent-runtime", "rollout.ts"), "utf8");
const rolloutRehearsal = readFileSync(resolve(root, "scripts", "release", "rehearse-claude-rollout.mjs"), "utf8");
const mountedCleanupEvidence = readFileSync(resolve(root, "docs", "operations", "opencode-mounted-client-cleanup.md"), "utf8");
const serverSource = readFileSync(resolve(root, "apps", "server", "src", "server.ts"), "utf8");
const rendererOpenCodeClient = readFileSync(resolve(root, "apps", "app", "src", "app", "lib", "opencode.ts"), "utf8");
const claudeSdkVersion = String(workerPkg.dependencies?.["@anthropic-ai/claude-agent-sdk"] ?? "").trim();
const claudeNodeVersion = claudePackageScript.match(/nodeVersion\s*=.*?\|\|\s*["']([^"']+)["']/)?.[1] ?? null;
const claudeTargets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
];
const claudeOptionalPackages = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  server: serverPkg.version ?? null,
  opencode: pinnedOpencodeVersion || null,
  claudeSdk: claudeSdkVersion || null,
  claudeNode: claudeNodeVersion,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

addCheck(
  "App/desktop versions match",
  versions.app && versions.desktop && versions.app === versions.desktop,
  `${versions.app ?? "?"} vs ${versions.desktop ?? "?"}`,
);
addCheck(
  "App/jugglework-server versions match",
  versions.app && versions.server && versions.app === versions.server,
  `${versions.app ?? "?"} vs ${versions.server ?? "?"}`,
);
if (versions.opencode) {
  addCheck(
    "OpenCode version pin exists",
    Boolean(versions.opencode),
    String(versions.opencode),
  );
} else {
  addWarning(
    "OpenCode version is not pinned in constants.json.",
  );
}

addCheck(
  "Claude Agent SDK is exact-pinned",
  /^\d+\.\d+\.\d+$/.test(claudeSdkVersion),
  claudeSdkVersion || "missing",
);
addCheck(
  "Claude worker Node is exact-pinned to Node 24",
  /^24\.\d+\.\d+$/.test(claudeNodeVersion ?? ""),
  claudeNodeVersion ?? "missing",
);
addCheck(
  "Claude platform optional packages match the SDK pin",
  claudeOptionalPackages.every((target) => lockfile.includes(`@anthropic-ai/claude-agent-sdk-${target}@${claudeSdkVersion}`)),
  `${claudeOptionalPackages.length} target packages at ${claudeSdkVersion || "missing"}`,
);
addCheck(
  "Claude runtime is packaged outside ASAR and checked after pack",
  /from:\s*resources\/claude-agent[\s\S]*?to:\s*claude-agent/.test(electronBuilder)
    && afterPack.includes("verifyClaudeRuntime(context, triple)"),
  "electron-builder extraResources + afterPack verification",
);
for (const target of claudeTargets) {
  addCheck(
    `Claude desktop target ${target}`,
    claudePackageScript.includes(`"${target}"`)
      && releaseWorkflow.includes(`target_triple: ${target}`)
      && compatibilityDoc.includes(`\`${target}\``),
    "package builder + release matrix + compatibility matrix",
  );
}
addCheck(
  "Release verifies Claude package content and installed smoke",
  releaseWorkflow.includes("check-package-content.mjs")
    && releaseWorkflow.includes("installed-smoke.mjs"),
  ".github/workflows/release-macos-aarch64.yml",
);
addCheck(
  "Release verifies updater assets after signing",
  releaseWorkflow.includes("verify-electron-updater-assets.mjs")
    && releaseWorkflow.indexOf("Verify Electron updater assets") > releaseWorkflow.indexOf("Apply signed Windows installer")
    && releaseWorkflow.indexOf("Verify Electron updater assets") < releaseWorkflow.indexOf("Upload Electron release assets")
    && runbook.includes("verify-electron-updater-assets.mjs"),
  "release workflow + operator runbook",
);
addCheck(
  "Headless compatibility boundaries are documented",
  compatibilityDoc.includes("Headless matrix")
    && compatibilityDoc.includes("Docker and microsandbox")
    && compatibilityDoc.includes("Not packaged"),
  "docs/operations/claude-runtime-compatibility.md",
);
addCheck(
  "Claude staged rollout and global kill switch are configured",
  rolloutResolver.includes('["internal", "opt-in", "ga"]')
    && rolloutResolver.includes("JUGGLEWORK_CLAUDE_AGENT_KILL_SWITCH")
    && rolloutResolver.includes("JUGGLEWORK_CLAUDE_USER_OPT_IN"),
  "packages/types/src/agent-runtime/rollout.ts",
);
addCheck(
  "CI archives a no-publish Claude rollout rehearsal",
  rolloutWorkflow.includes("pnpm rollout:rehearse")
    && rolloutWorkflow.includes("tmp/claude-rollout/rollout-evidence.json")
    && rolloutRehearsal.includes("externalReleasePublished: false"),
  ".github/workflows/ci-tests.yml + rehearsal script",
);
addCheck(
  "Deprecated mounted OpenCode client paths are removed with durable evidence",
  serverSource.includes("MOUNTED_OPENCODE_ENGINE_INTEGRATION_ROOTS")
    && !serverSource.includes("legacyMountedOpenCodeOperation")
    && !serverSource.includes("parseSessionExecutionStartProxyRequest")
    && !rendererOpenCodeClient.includes("wrapJuggleWorkReadWithFallback")
    && mountedCleanupEvidence.includes("Supported-client mounted reads")
    && mountedCleanupEvidence.includes("## Retained boundary"),
  "isolated mounted-client cleanup + deprecation evidence",
);
addCheck(
  "OpenCode adapter and historical-session importer remain",
  readFileSync(resolve(root, "apps", "server", "src", "agent-engine", "opencode-adapter.ts"), "utf8").includes("OpenCodeAgentEngineAdapter")
    && readFileSync(resolve(root, "apps", "server", "src", "legacy-importers", "opencode-sqlite.ts"), "utf8").includes("legacyOpencodeSessionImporter"),
  "Server adapter + documented legacy importer",
);

const report = { ok, versions, checks, warnings };

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Release review");
  for (const check of checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`- ${status}: ${check.label} (${check.details})`);
  }
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

if (strict && !ok) {
  process.exit(1);
}

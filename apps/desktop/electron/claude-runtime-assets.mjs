import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export function claudeTargetTriple(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

export async function resolveClaudeRuntimeAssets({
  resourcesPath,
  platform = process.platform,
  arch = process.arch,
  checkExecutable = true,
}) {
  const root = path.join(resourcesPath, "claude-agent");
  const manifestPath = path.join(root, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`Claude Agent package manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const expectedTarget = claudeTargetTriple(platform, arch);
  if (!expectedTarget || manifest.target !== expectedTarget) {
    throw new Error(`Claude Agent package target ${manifest.target ?? "unknown"} does not match ${expectedTarget ?? `${platform}/${arch}`}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.sdkVersion ?? "")) throw new Error("Claude Agent package SDK version is invalid");
  if (!/^24\.\d+\.\d+$/.test(manifest.nodeVersion ?? "")) throw new Error("Claude Agent package Node version is invalid");
  const resolved = {};
  for (const key of ["worker", "node", "claude"]) {
    const relative = manifest.paths?.[key];
    if (typeof relative !== "string" || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`Claude Agent package ${key} path is invalid`);
    }
    const absolute = path.join(root, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`Claude Agent package ${key} is missing: ${absolute}`);
    await access(absolute, key === "worker" || !checkExecutable ? constants.R_OK : constants.R_OK | constants.X_OK);
    resolved[key] = absolute;
  }
  return { root, manifest, ...resolved };
}

export function claudeRuntimeEnvironment(assets) {
  return {
    JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH: assets.worker,
    JUGGLEWORK_CLAUDE_AGENT_NODE_PATH: assets.node,
    JUGGLEWORK_CLAUDE_EXECUTABLE_PATH: assets.claude,
  };
}

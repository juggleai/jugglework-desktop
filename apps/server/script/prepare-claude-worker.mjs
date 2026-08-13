import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(serverRoot, "../..");
const workerRoot = resolve(repoRoot, "apps/claude-agent-worker");
const outputRoot = resolve(serverRoot, "claude-agent-worker");
function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(outputRoot, { recursive: true, force: true });
run(join(workerRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", "tsconfig.build.json"], workerRoot);
run(process.platform === "win32" ? "bun.exe" : "bun", ["build", "src/cli.ts", "--target", "node", "--format", "esm", "--outfile", "dist/cli.bundle.js"], workerRoot);
mkdirSync(join(outputRoot, "dist"), { recursive: true });
copyFileSync(join(workerRoot, "dist", "cli.bundle.js"), join(outputRoot, "dist", "cli.js"));
const expected = JSON.parse(readFileSync(join(workerRoot, "package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"];
const sdkPackagePath = join(workerRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
if (!existsSync(sdkPackagePath)) throw new Error(`Headless package is missing Claude Agent SDK: ${sdkPackagePath}`);
const sdkPackage = JSON.parse(readFileSync(sdkPackagePath, "utf8"));
const actual = sdkPackage.version;
if (actual !== expected) throw new Error(`Headless Claude Agent SDK ${actual} does not match exact pin ${expected}`);
writeFileSync(join(outputRoot, "sdk-package.json"), `${JSON.stringify({ name: sdkPackage.name, version: actual, claudeCodeVersion: sdkPackage.claudeCodeVersion }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, outputRoot, sdkVersion: actual })}\n`);

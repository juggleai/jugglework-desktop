import { spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_PLUGIN_FILES = [
  "jugglework-extensions-preview.js",
  "jugglework-capabilities-knowledge.js",
  "jugglework-office-attachments.js",
  "jugglework-anthropic-adaptive-thinking.js",
  "jugglework-anthropic-tool-schema.js",
  "jugglework-safe-grep.js",
  "jugglework-context-overflow.js",
  "jugglework-mcp-workspace-policy.js",
] as const;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const targets: string[] = [];
let outdir = resolve("dist", "bin");
let pluginSource = resolve(packageRoot, "..", "server", "dist", "opencode-plugins");
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (value === "--target" && argv[index + 1]) targets.push(argv[++index]!);
  else if (value?.startsWith("--target=")) targets.push(value.slice(9));
  else if (value === "--outdir" && argv[index + 1]) outdir = resolve(argv[++index]!);
  else if (value?.startsWith("--outdir=")) outdir = resolve(value.slice(9));
  else if (value === "--plugin-dir" && argv[index + 1]) pluginSource = resolve(argv[++index]!);
  else if (value?.startsWith("--plugin-dir=")) pluginSource = resolve(value.slice(13));
}

export function stagePluginAssets(source: string, binaryDir: string): string {
  for (const filename of REQUIRED_PLUGIN_FILES) {
    const asset = join(source, filename);
    try {
      accessSync(asset, constants.R_OK);
      if (!statSync(asset).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`Missing or invalid required plugin asset: ${asset}`);
    }
  }
  const destination = join(binaryDir, "opencode-plugins");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const filename of REQUIRED_PLUGIN_FILES) {
    copyFileSync(join(source, filename), join(destination, filename));
  }
  return destination;
}

export function outputName(target?: string): string {
  const extension = target?.includes("windows") || (!target && process.platform === "win32") ? ".exe" : "";
  return `jugglework${target ? `-${target}` : ""}${extension}`;
}

export function cleanBinaryOutputs(binaryDir: string): void {
  mkdirSync(binaryDir, { recursive: true });
  for (const entry of readdirSync(binaryDir)) {
    if (/^jugglework(?:-bun-(?:darwin|linux|windows)-(?:arm64|x64))?(?:\.exe)?$/.test(entry)) {
      rmSync(join(binaryDir, entry), { force: true });
    }
  }
}

export function main(): number {
  cleanBinaryOutputs(outdir);
  for (const target of targets.length ? targets : [undefined]) {
    const result = spawnSync("bun", [
      "build", join(packageRoot, "src", "cli.ts"), "--compile", "--outfile", join(outdir, outputName(target)),
      ...(target ? ["--target", target] : []),
    ], { stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  stagePluginAssets(pluginSource, outdir);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

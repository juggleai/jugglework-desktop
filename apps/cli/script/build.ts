import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../../server/package.json" with { type: "json" };
import {
  assertDescriptor,
  DISTRIBUTION_MANIFEST,
  type DistributionManifest,
  type DistributionTarget,
  integrityFile,
  isDistributionTarget,
  OPENCODE_DISTRIBUTION,
  REQUIRED_PLUGIN_FILES,
} from "../src/distribution.js";

export { REQUIRED_PLUGIN_FILES } from "../src/distribution.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const targets: string[] = [];
let outdir = resolve("dist", "bin");
let pluginSource = resolve(packageRoot, "..", "server", "dist", "opencode-plugins");
let sidecarRoot: string | null = null;
for (let index = 0; index < argv.length; index += 1) {
  const value = argv[index];
  if (value === "--target" && argv[index + 1]) targets.push(argv[++index]!);
  else if (value?.startsWith("--target=")) targets.push(value.slice(9));
  else if (value === "--outdir" && argv[index + 1]) outdir = resolve(argv[++index]!);
  else if (value?.startsWith("--outdir=")) outdir = resolve(value.slice(9));
  else if (value === "--plugin-dir" && argv[index + 1]) pluginSource = resolve(argv[++index]!);
  else if (value?.startsWith("--plugin-dir=")) pluginSource = resolve(value.slice(13));
  else if (value === "--sidecar-dir" && argv[index + 1]) sidecarRoot = resolve(argv[++index]!);
  else if (value?.startsWith("--sidecar-dir=")) sidecarRoot = resolve(value.slice(14));
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

function requireFile(path: string, label: string): void {
  try {
    accessSync(path, constants.R_OK);
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Missing or invalid ${label}: ${path}`);
  }
}

export function stageDistribution(input: {
  target: DistributionTarget;
  root: string;
  cliBinary: string;
  opencodeBinary: string;
  pluginSource: string;
}): DistributionManifest {
  assertDescriptor();
  const { target, root, cliBinary, opencodeBinary, pluginSource } = input;
  requireFile(cliBinary, "CLI binary");
  requireFile(opencodeBinary, "OpenCode sidecar");
  rmSync(root, { recursive: true, force: true });
  const binDir = join(root, "bin");
  const sidecarDir = join(root, "sidecars");
  const licenseDir = join(root, "licenses");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(sidecarDir, { recursive: true });
  mkdirSync(licenseDir, { recursive: true });
  const cliDestination = join(binDir, target.startsWith("bun-windows-") ? "jugglework.exe" : "jugglework");
  const sidecarDestination = join(sidecarDir, OPENCODE_DISTRIBUTION.targets[target].executable);
  copyFileSync(cliBinary, cliDestination);
  copyFileSync(opencodeBinary, sidecarDestination);
  if (!target.startsWith("bun-windows-")) {
    chmodSync(cliDestination, 0o755);
    chmodSync(sidecarDestination, 0o755);
  }
  const pluginDir = stagePluginAssets(pluginSource, root);
  const noticeSource = join(packageRoot, "distribution", "THIRD_PARTY_NOTICES.md");
  const licenseSource = join(packageRoot, "distribution", "licenses", "OpenCode-LICENSE.txt");
  const noticeDestination = join(root, "THIRD_PARTY_NOTICES.md");
  const licenseDestination = join(licenseDir, "OpenCode-LICENSE.txt");
  copyFileSync(noticeSource, noticeDestination);
  copyFileSync(licenseSource, licenseDestination);
  const manifest: DistributionManifest = {
    schemaVersion: 1,
    target,
    cli: { version: packageJson.version, file: integrityFile(root, cliDestination) },
    server: { version: serverPackageJson.version },
    opencode: {
      version: OPENCODE_DISTRIBUTION.version,
      source: OPENCODE_DISTRIBUTION.release,
      file: integrityFile(root, sidecarDestination),
    },
    plugins: {
      directory: "opencode-plugins",
      files: REQUIRED_PLUGIN_FILES.map((filename) => integrityFile(root, join(pluginDir, filename))),
    },
    notices: [integrityFile(root, noticeDestination), integrityFile(root, licenseDestination)],
  };
  writeFileSync(join(root, DISTRIBUTION_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function refreshDistributionManifest(root: string): DistributionManifest {
  const manifestPath = join(root, DISTRIBUTION_MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DistributionManifest;
  const refreshed: DistributionManifest = {
    ...manifest,
    cli: { ...manifest.cli, file: integrityFile(root, join(root, manifest.cli.file.path)) },
    opencode: { ...manifest.opencode, file: integrityFile(root, join(root, manifest.opencode.file.path)) },
    plugins: {
      ...manifest.plugins,
      files: manifest.plugins.files.map((file) => integrityFile(root, join(root, file.path))),
    },
    notices: manifest.notices.map((file) => integrityFile(root, join(root, file.path))),
  };
  writeFileSync(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`);
  return refreshed;
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
  const buildTargets = targets.length ? targets : [undefined];
  for (const target of buildTargets) {
    const result = spawnSync("bun", [
      "build", join(packageRoot, "src", "cli.ts"), "--compile", "--outfile", join(outdir, outputName(target)),
      ...(target ? ["--target", target] : []),
    ], { stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  stagePluginAssets(pluginSource, outdir);
  if (sidecarRoot) {
    for (const target of buildTargets) {
      if (!target || !isDistributionTarget(target)) {
        throw new Error("--sidecar-dir requires explicit supported --target values");
      }
      stageDistribution({
        target,
        root: join(outdir, "distributions", target),
        cliBinary: join(outdir, outputName(target)),
        opencodeBinary: join(sidecarRoot, target, OPENCODE_DISTRIBUTION.targets[target].executable),
        pluginSource,
      });
    }
  }
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

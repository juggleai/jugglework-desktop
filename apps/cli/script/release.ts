import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../../server/package.json" with { type: "json" };
import { refreshDistributionManifest } from "./build.js";
import {
  isDistributionTarget,
  OPENCODE_VERSION,
  REQUIRED_PLUGIN_FILES,
  sha256File,
  verifyDistribution,
  type DistributionTarget,
} from "../src/distribution.js";

function run(command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? "unknown"}): ${(result.stderr || result.stdout).trim()}`);
  return `${result.stdout}${result.stderr}`.trim();
}

function exactPackageFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path.slice(root.length + 1).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return result.sort();
}

export async function validateRelease(root: string, target: DistributionTarget, requireSignature = false): Promise<void> {
  const manifest = await verifyDistribution(root, target);
  if (manifest.cli.version !== packageJson.version || manifest.server.version !== serverPackageJson.version) {
    throw new Error("distribution component versions do not match package metadata");
  }
  const expected = [
    "THIRD_PARTY_NOTICES.md", "licenses/OpenCode-LICENSE.txt", "manifest.json",
    manifest.cli.file.path, manifest.opencode.file.path,
    ...REQUIRED_PLUGIN_FILES.map((name) => `opencode-plugins/${name}`),
  ].sort();
  const actual = exactPackageFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`distribution package content mismatch\nexpected: ${expected.join(", ")}\nactual: ${actual.join(", ")}`);
  }
  if (!target.startsWith("bun-windows-")) {
    for (const path of [manifest.cli.file.path, manifest.opencode.file.path]) {
      if ((statSync(join(root, path)).mode & 0o111) === 0) throw new Error(`${path} is not executable`);
    }
  }
  if (!target.startsWith("bun-windows-") || process.platform === "win32") {
    const opencodeVersion = run(join(root, manifest.opencode.file.path), ["--version"]);
    if (!opencodeVersion.includes(OPENCODE_VERSION)) throw new Error(`OpenCode reported incompatible version: ${opencodeVersion}`);
  }
  if (requireSignature) {
    if (target.startsWith("bun-darwin-")) {
      for (const path of [manifest.cli.file.path, manifest.opencode.file.path]) run("codesign", ["--verify", "--strict", "--verbose=2", join(root, path)]);
    } else if (target.startsWith("bun-windows-")) {
      for (const path of [manifest.cli.file.path, manifest.opencode.file.path]) {
        const status = run("powershell", ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${join(root, path).replaceAll("'", "''")}').Status`]);
        if (status.trim() !== "Valid") throw new Error(`${path} does not have a valid Authenticode signature`);
      }
    }
  }
}

export async function smokeRelease(root: string, target: DistributionTarget): Promise<void> {
  const manifest = await verifyDistribution(root, target);
  const temporary = await mkdtemp(join(tmpdir(), "jugglework-cli-smoke-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: join(temporary, "config") };
    delete env.JUGGLEWORK_OPENCODE_BIN;
    delete env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR;
    const cli = join(root, manifest.cli.file.path);
    const version = run(cli, ["--version"], temporary, env);
    if (version.trim() !== packageJson.version) throw new Error(`CLI reported incompatible version: ${version}`);
    run(cli, ["status", "--workspace", temporary, "--timeout", "30000"], temporary, env);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function archiveRelease(root: string, target: DistributionTarget, outdir: string): Promise<string> {
  mkdirSync(outdir, { recursive: true });
  const name = `jugglework-cli-v${packageJson.version}-${target}`;
  const archive = join(resolve(outdir), `${name}${target.startsWith("bun-windows-") ? ".zip" : ".tar.gz"}`);
  if (target.startsWith("bun-windows-")) run("tar", ["-a", "-cf", archive, "."], root);
  else run("tar", ["-czf", archive, "."], root);
  const digest = await sha256File(archive);
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  return archive;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

if (import.meta.main) {
  const command = process.argv[2];
  const root = argument("--root");
  const targetValue = argument("--target");
  if (!root || !targetValue || !isDistributionTarget(targetValue)) {
    console.error("Usage: release.ts <refresh|validate|smoke|archive> --root <distribution> --target <supported-target> [--outdir <directory>] [--require-signature]");
    process.exit(2);
  }
  Promise.resolve(command === "refresh" ? refreshDistributionManifest(resolve(root))
    : command === "validate" ? validateRelease(resolve(root), targetValue, process.argv.includes("--require-signature"))
    : command === "smoke" ? smokeRelease(resolve(root), targetValue)
    : command === "archive" ? archiveRelease(resolve(root), targetValue, resolve(argument("--outdir") ?? "dist/release"))
    : Promise.reject(new Error(`Unknown release command: ${command}`)))
    .then((result) => { if (typeof result === "string") console.log(result); })
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

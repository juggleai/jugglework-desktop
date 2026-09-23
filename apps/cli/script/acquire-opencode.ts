import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import {
  assertDescriptor,
  isDistributionTarget,
  OPENCODE_DISTRIBUTION,
  sha256File,
  type DistributionTarget,
} from "../src/distribution.js";

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

function findFile(root: string, filename: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === filename) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, filename);
      if (nested) return nested;
    }
  }
  return null;
}

export async function acquireOpenCode(input: {
  target: DistributionTarget;
  outdir: string;
  archivePath?: string;
  releaseBaseUrl?: string;
}): Promise<string> {
  assertDescriptor();
  const asset = OPENCODE_DISTRIBUTION.targets[input.target];
  const temporary = await mkdtemp(join(tmpdir(), `jugglework-opencode-${input.target}-`));
  try {
    const archive = join(temporary, asset.archive);
    if (input.archivePath) {
      copyFileSync(resolve(input.archivePath), archive);
    } else {
      const base = input.releaseBaseUrl ?? OPENCODE_DISTRIBUTION.release.replace("/tag/", "/download/");
      const response = await fetch(`${base}/${asset.archive}`, { redirect: "follow" });
      if (!response.ok) throw new Error(`OpenCode download failed with HTTP ${response.status}`);
      await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    }
    const digest = await sha256File(archive);
    if (digest !== asset.sha256) {
      throw new Error(`OpenCode archive checksum mismatch for ${input.target}: expected ${asset.sha256}, received ${digest}`);
    }
    const extracted = join(temporary, "extracted");
    mkdirSync(extracted);
    if (asset.format === "tar.gz") run("tar", ["-xzf", archive, "-C", extracted]);
    else if (process.platform === "win32") run("powershell", ["-NoProfile", "-Command", "Expand-Archive", "-LiteralPath", archive, "-DestinationPath", extracted]);
    else run("unzip", ["-q", archive, "-d", extracted]);
    const source = findFile(extracted, asset.executable);
    if (!source || !statSync(source).isFile()) throw new Error(`OpenCode archive does not contain ${asset.executable}`);
    const targetDir = join(resolve(input.outdir), input.target);
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(targetDir, { recursive: true });
    const destination = join(targetDir, asset.executable);
    copyFileSync(source, destination);
    if (process.platform !== "win32") chmodSync(destination, 0o755);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function argument(name: string): string | undefined {
  const exact = process.argv.indexOf(name);
  if (exact >= 0) return process.argv[exact + 1];
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

if (import.meta.main) {
  const target = argument("--target");
  const outdir = argument("--outdir");
  if (!target || !isDistributionTarget(target) || !outdir) {
    console.error("Usage: acquire-opencode.ts --target <supported-target> --outdir <directory> [--archive <fixture>] [--release-base-url <url>]");
    process.exit(2);
  }
  acquireOpenCode({ target, outdir, archivePath: argument("--archive"), releaseBaseUrl: argument("--release-base-url") })
    .then((path) => console.log(path))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

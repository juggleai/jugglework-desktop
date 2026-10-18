import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeToonFactoryArch, verifyToonFactoryBundle } from "../electron/toonFactoryBundle.mjs";

function fail(message) {
  throw new Error(`[verify-packaged-linux] ${message}`);
}

function readArg(args, name) {
  const inline = args.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() ?? "" : "";
}

export function findPackagedToonFactoryBundle(directory) {
  const root = path.resolve(directory);
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    fail(`Package directory is missing or invalid: ${root}`);
  }

  const candidates = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.name === "toonFactoryV2" && path.basename(current) === "resources") {
        candidates.push(child);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(child);
    }
  }
  visit(root);

  if (candidates.length !== 1) {
    fail(`Expected exactly one resources/toonFactoryV2 in ${root}, found ${candidates.length}`);
  }
  return candidates[0];
}

export function verifyPackagedLinux(directory, arch, trustedRelease) {
  const expectedArch = normalizeToonFactoryArch(arch);
  const packageRoot = path.resolve(directory);
  const toonFactoryRoot = findPackagedToonFactoryBundle(packageRoot);
  const bundle = verifyToonFactoryBundle(toonFactoryRoot, { platform: "linux", arch: expectedArch }, trustedRelease);
  return { ok: true, packageRoot, arch: expectedArch, toonFactoryRoot, bundle };
}

export function main(args = process.argv.slice(2)) {
  const directory = readArg(args, "--dir");
  const arch = readArg(args, "--arch");
  if (!directory) fail("Pass the Linux unpacked directory or extraction staging path with --dir");
  if (!arch) fail("Pass the expected Linux architecture with --arch");
  const result = verifyPackagedLinux(directory, arch);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

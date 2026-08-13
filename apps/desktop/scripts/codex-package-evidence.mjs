#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "dist-electron");
const platform = String(process.argv[3] ?? process.platform);

async function walk(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(target));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

const files = await walk(root);
const codex = files.filter((file) => /^codex-(?:aarch64|x86_64)-(?:apple-darwin|pc-windows-msvc)(?:\.exe)?$/.test(path.basename(file)));
if (codex.length !== 1) throw new Error(`Expected one target-specific Codex executable, found ${codex.length}.`);
const binary = codex[0];
const bytes = await readFile(binary);
const packages = files.filter((file) => /\.(?:dmg|zip|exe|nsis\.7z)$/.test(file));
const output = {
  schemaVersion: 1,
  platform,
  codex: { name: path.basename(binary), installedBytes: (await stat(binary)).size, sha256: createHash("sha256").update(bytes).digest("hex") },
  packages: await Promise.all(packages.map(async (file) => ({ name: path.basename(file), bytes: (await stat(file)).size }))),
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

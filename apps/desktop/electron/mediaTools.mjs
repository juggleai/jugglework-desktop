import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { inspectToonFactoryExecutable, sha256File } from "./toonFactoryBundle.mjs";

export const MEDIA_SOURCES = JSON.parse(readFileSync(new URL("./mediaToolsSources.json", import.meta.url), "utf8"));
export const mediaSourceInputs = () => [...Object.values(MEDIA_SOURCES.sources), ...MEDIA_SOURCES.evidence];
export function requireMediaTarget({ platform, arch }) {
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
    throw new Error(`[media-tools] Unsupported native target ${platform}/${arch}; Windows/Linux source build and release verification are not implemented. No architecture fallback.`);
  }
}
export function mediaInventory(root) {
  function visit(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`[media-tools] Symlink rejected: ${file}`);
      if (entry.isDirectory()) return visit(file);
      if (!entry.isFile()) throw new Error(`[media-tools] Special file rejected: ${file}`);
      const relative = path.relative(root, file).split(path.sep).join("/");
      return relative === "manifest.json" ? [] : [{ path: relative, sha256: sha256File(file), bytes: lstatSync(file).size }];
    });
  }
  return visit(root).sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function mediaRun(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", env: { PATH: "", LANG: "C", LC_ALL: "C" }, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`[media-tools] ${executable}: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout;
}
export function verifyMediaSignature(executable, team) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) throw new Error("[media-tools] Expected Developer ID Team is required");
  mediaRun("/usr/bin/codesign", ["--verify", "--strict", "-R", `=anchor apple generic and certificate leaf[subject.OU] = "${team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`, executable]);
  const details = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", executable], { encoding: "utf8", timeout: 30000 });
  if (details.error || details.status !== 0 || !/flags=.*\bruntime\b/.test(details.stderr) || !/^Timestamp=/m.test(details.stderr)) throw new Error("[media-tools] Hardened runtime and secure timestamp required");
}
/** @param {string} root
 * @param {{platform: string, arch: string}} target
 * @param {{phase?: string, team?: string}} options
 */
export function verifyMediaTools(root, target = process, { phase = "any", team } = {}) {
  requireMediaTarget(target);
  try {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error("Invalid resource root");
    const manifestPath = path.join(root, "manifest.json");
    if (lstatSync(manifestPath).isSymbolicLink()) throw new Error("Manifest symlink rejected");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.platform !== target.platform || manifest.arch !== target.arch || JSON.stringify(manifest.sources) !== JSON.stringify(MEDIA_SOURCES)) throw new Error("Source lock or target mismatch");
    if (!["built", "signed"].includes(manifest.phase) || (phase !== "any" && manifest.phase !== phase)) throw new Error(`Expected ${phase} manifest`);
    if (phase === "signed" && manifest.signingTeam !== team) throw new Error("Signing team mismatch");
    if (JSON.stringify(manifest.files) !== JSON.stringify(mediaInventory(root))) throw new Error("Resource inventory/hash mismatch");
    for (const source of mediaSourceInputs()) {
      if (sha256File(path.join(root, "sources", source.archive)) !== source.sha256) throw new Error(`Source hash mismatch: ${source.archive}`);
    }
    if (JSON.stringify(JSON.parse(readFileSync(path.join(root, "sources/mediaToolsSources.json"), "utf8"))) !== JSON.stringify(MEDIA_SOURCES)) throw new Error("Bundled source lock mismatch");
    for (const file of ["sources/build-media-tools.sh", "sources/media-tools-pkg-config.sh", "sources/mediaToolsSources.json", "NOTICE.txt", "licenses/x264-COPYING", "licenses/COPYING.GPLv2", "licenses/COPYING.LGPLv2.1", "licenses/LICENSE.md", "build-info/compiler.txt", "build-info/sdk.txt", "build-info/ffmpeg-config.mak", "build-info/x264-config.mak"]) {
      if (!manifest.files.some(entry => entry.path === file && entry.bytes > 0)) throw new Error(`Required source/license/build record missing: ${file}`);
    }
    const tools = { ffmpeg: path.join(root, "ffmpeg"), ffprobe: path.join(root, "ffprobe") };
    for (const name of ["ffmpeg", "ffprobe"]) {
      const executable = path.join(root, name);
      const header = inspectToonFactoryExecutable(executable);
      if (header.platform !== target.platform || header.arch !== target.arch || !(lstatSync(executable).mode & 0o111)) throw new Error(`Wrong architecture or mode: ${name}`);
      if (!/^[a-f0-9]{64}$/.test(manifest.buildHashes?.[name] ?? "")) throw new Error("Missing local build receipt");
      if (manifest.phase === "built" && sha256File(executable) !== manifest.buildHashes[name]) throw new Error("Build receipt mismatch");
      if (phase === "signed") verifyMediaSignature(executable, team);
      tools[name] = executable;
    }
    return { ...tools, root, manifest, manifestPath };
  } catch (error) {
    throw new Error(`[media-tools] 随包媒体工具缺失或校验失败，请重新构建（pnpm build:media-tools / build:toon-factory）或重新安装 JuggleWork：${error.message}`, { cause: error });
  }
}
export function verifyMediaExecutables(tools) {
  for (const name of ["ffmpeg", "ffprobe"]) {
    const version = mediaRun(tools[name], ["-version"]);
    if (!version.startsWith(`${name} version ${MEDIA_SOURCES.sources.ffmpeg.version} `) || version.includes("--enable-nonfree") || !["--disable-network", "--enable-gpl", "--disable-nonfree", "--enable-libx264", "--disable-shared"].every(flag => version.includes(flag))) throw new Error(`[media-tools] Unexpected version/license/configuration: ${name}`);
    const license = mediaRun(tools[name], ["-L"]);
    if (!license.includes("GNU General Public License") || /nonfree|not legally redistributable/i.test(license)) throw new Error("[media-tools] Expected redistributable GPL build configuration");
    const libraries = mediaRun("/usr/bin/otool", ["-L", tools[name]]).split("\n").slice(1).map(line => line.trim()).filter(Boolean);
    if (!libraries.length || libraries.some(line => !line.startsWith("/usr/lib/") && !line.startsWith("/System/Library/"))) throw new Error(`[media-tools] Non-system dynamic dependency: ${libraries.join("\n")}`);
  }
  if (!/\blibx264\b/.test(mediaRun(tools.ffmpeg, ["-hide_banner", "-encoders"]))) throw new Error("[media-tools] libx264 is required");
  const protocols = mediaRun(tools.ffmpeg, ["-hide_banner", "-protocols"]).split("\n").map(line => line.trim()).filter(line => line && !["Supported file protocols:", "Input:", "Output:"].includes(line));
  if (protocols.some(value => !["file", "pipe"].includes(value))) throw new Error(`[media-tools] Unexpected protocol: ${protocols}`);
}

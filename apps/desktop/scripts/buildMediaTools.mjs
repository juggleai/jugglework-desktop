import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { MEDIA_SOURCES, mediaSourceInputs, mediaInventory, requireMediaTarget, verifyMediaTools, verifyMediaExecutables } from "../electron/mediaTools.mjs";
import { resolveToonFactoryBuildTarget, sha256File } from "../electron/toonFactoryBundle.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(scripts, "..");
export async function buildMediaTools({ target = resolveToonFactoryBuildTarget(), output = path.join(desktop, "resources/mediaTools"), cache = path.join(desktop, ".media-tools-cache"), offline = process.env.MEDIA_TOOLS_OFFLINE === "1", force = false } = {}) {
  requireMediaTarget(target);
  if (target.platform !== process.platform || target.arch !== process.arch) throw new Error(`[media-tools] Native ${target.platform}/${target.arch} host required; running ${process.platform}/${process.arch}`);
  // A cached binary is a local build receipt, never an upstream trusted binary hash.
  // Changes to the actual distributed recipe invalidate staging.
  if (!force && existsSync(output)) {
    try {
      const tools = verifyMediaTools(output, target, { phase: "built" });
      for (const name of ["build-media-tools.sh", "media-tools-pkg-config.sh"]) {
        if (sha256File(path.join(scripts, name)) !== sha256File(path.join(output, "sources", name))) throw new Error("Recipe changed");
      }
      verifyMediaExecutables(tools);
      return tools;
    } catch (error) { console.log(`[media-tools] Rebuilding staging: ${error.message}`); }
  }
  mkdirSync(cache, { recursive: true });
  for (const source of mediaSourceInputs()) {
    const file = path.join(cache, source.archive);
    if (!existsSync(file)) {
      if (offline) throw new Error(`[media-tools] Offline source missing: ${file}`);
      console.log(`[media-tools] Downloading official source ${source.url}`);
      const temporary = `${file}.${process.pid}.download`;
      try {
        if (source.commit) {
          const gitRoot = mkdtempSync(path.join(cache, "git-"));
          const git = args => {
            const result = spawnSync("/usr/bin/git", args, { encoding: "utf8", timeout: 180000, env: { PATH: "/usr/bin:/bin", HOME: gitRoot, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
            if (result.error || result.status !== 0) throw new Error(`[media-tools] Official source Git failed: ${result.error?.message || result.stderr}`);
            return result.stdout.trim();
          };
          try {
            const repo = path.join(gitRoot, "repo.git");
            git(["init", "--bare", repo]);
            git(["--git-dir", repo, "fetch", "--depth=1", source.url, source.commit]);
            if (git(["--git-dir", repo, "rev-parse", "FETCH_HEAD"]) !== source.commit || git(["--git-dir", repo, "rev-parse", "FETCH_HEAD^{tree}"]) !== source.tree) throw new Error("[media-tools] Official Git commit/tree mismatch");
            git(["--git-dir", repo, "archive", "--format=tar", "--prefix=x264/", `--output=${temporary}`, source.commit]);
          } finally { rmSync(gitRoot, { recursive: true, force: true }); }
        } else {
          // Ignore user curl configuration; only fixed HTTPS URLs from the source lock.
          const response = spawnSync("/usr/bin/curl", ["-q", "--fail", "--silent", "--show-error", "--proto", "=https", "--max-time", "180", source.url], { timeout: 190000, maxBuffer: 32 * 1024 * 1024, env: { PATH: "/usr/bin:/bin" } });
          if (response.error || response.status !== 0) throw new Error(`[media-tools] Download failed: ${source.url}: ${response.error?.message || response.stderr}`);
          writeFileSync(temporary, response.stdout, { flag: "wx" });
        }
        if (sha256File(temporary) !== source.sha256) throw new Error(`[media-tools] Source SHA-256 mismatch: ${source.archive}`);
        renameSync(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
    }
    if (sha256File(file) !== source.sha256) throw new Error(`[media-tools] Cached source SHA-256 mismatch: ${file}; refusing execution`);
  }
  const work = mkdtempSync(path.join(tmpdir(), "jugglework-media-build-"));
  const stage = path.join(work, "mediaTools");
  const sources = path.join(stage, "sources");
  let completed = false;
  mkdirSync(sources, { recursive: true });
  try {
    for (const source of mediaSourceInputs()) copyFileSync(path.join(cache, source.archive), path.join(sources, source.archive));
    for (const name of ["build-media-tools.sh", "media-tools-pkg-config.sh"]) {
      copyFileSync(path.join(scripts, name), path.join(sources, name));
      chmodSync(path.join(sources, name), 0o755);
    }
    writeFileSync(path.join(sources, "mediaToolsSources.json"), `${JSON.stringify(MEDIA_SOURCES, null, 2)}\n`);
    const log = path.join(work, "build.log");
    const result = spawnSync("/bin/sh", [path.join(sources, "build-media-tools.sh"), sources, path.join(work, "work"), stage, target.arch], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: work, TMPDIR: work }, timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(log, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (result.error || result.status !== 0) throw new Error(`[media-tools] Source build failed (${result.error?.message || result.status}); log: ${log}`);
    writeFileSync(path.join(stage, "NOTICE.txt"), `JuggleWork media tools: FFmpeg ${MEDIA_SOURCES.sources.ffmpeg.version} + x264 ${MEDIA_SOURCES.sources.x264.version}. GPL-2.0-or-later.\nCopyright the FFmpeg developers and x264 authors; see bundled source headers and licenses.\nCorresponding unmodified sources, configuration and build/install script are included in sources/ and build-info/.\nRebuild on native macOS 14+ with Xcode Command Line Tools: /bin/sh sources/build-media-tools.sh ABSOLUTE_SOURCES EMPTY_WORK ABSOLUTE_OUTPUT arm64|x64\nNo source patches; static x264 and FFmpeg libraries, Apple system libraries only. No nonfree components or network protocols.\nThis software is based in part on the work of the Independent JPEG Group.\nSource intake provenance limitations are recorded in sources/mediaToolsSources.json. Binary hashes are local build receipts, not upstream signatures.\nDistribution/source delivery and licensing review remains a release-owner responsibility; this build does not constitute legal approval.\n`);
    const manifest = { schemaVersion: 1, platform: target.platform, arch: target.arch, phase: "built", sources: MEDIA_SOURCES, buildHashes: Object.fromEntries(["ffmpeg", "ffprobe"].map(name => [name, sha256File(path.join(stage, name))])), files: mediaInventory(stage) };
    writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    verifyMediaExecutables(verifyMediaTools(stage, target, { phase: "built" }));
    // Only replace staging after a complete verified build; never package partial output.
    mkdirSync(path.dirname(output), { recursive: true });
    const { cpSync } = await import("node:fs");
    rmSync(output, { recursive: true, force: true });
    cpSync(stage, output, { recursive: true });
    completed = true;
    console.log(`[media-tools] Built ${target.platform}/${target.arch}: ${output}`);
    return verifyMediaTools(output, target, { phase: "built" });
  } finally {
    // Preserve failed build diagnostics; successful build output has all rebuild inputs.
    if (completed) rmSync(work, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildMediaTools({ force: process.argv.includes("--force") });

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BUN_TRUSTED_RELEASE, inspectToonFactoryExecutable, inventoryToonFactoryBundle, resolveToonFactoryBuildTarget, sha256File, trustedBunForTarget } from "../electron/toonFactoryBundle.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = path.join(root, "modules/toonflowV2");
const output = path.join(root, "apps/desktop/resources/toonFactoryV2");
let bun;

function run(args, cwd = source, capture = false) {
  const result = spawnSync(bun, args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (result.error) throw new Error(`Unable to run Bun (${bun} ${args.join(" ")}): ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? result.stderr.trim() : `exit code ${result.status}`;
    throw new Error(`Toonflow command failed (${bun} ${args.join(" ")}): ${detail || "unknown error"}`);
  }
  return capture ? result.stdout.trim() : "";
}

function executableCandidates(command, environment, platform) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return [path.resolve(command)];
  const extensions = platform === "win32"
    ? String(environment.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  return String(environment.PATH || "").split(path.delimiter).filter(Boolean).flatMap((directory) => (
    extensions.map((extension) => path.join(directory, platform === "win32" && !path.extname(command) ? `${command}${extension.toLowerCase()}` : command))
  ));
}

export function resolveTrustedBunBinary(command, target, {
  environment = process.env,
  platform = process.platform,
  trustedRelease = BUN_TRUSTED_RELEASE,
} = {}) {
  const candidate = executableCandidates(command, environment, platform).find((entry) => existsSync(entry) && statSync(entry).isFile());
  if (!candidate) throw new Error(`Unable to locate Bun binary: ${command}`);
  const resolved = realpathSync(candidate);
  const executable = inspectToonFactoryExecutable(resolved);
  if (executable.platform !== target.platform || executable.arch !== target.arch || executable.format !== target.format) {
    throw new Error(`Bun binary is ${executable.platform}/${executable.arch}/${executable.format}, expected ${target.platform}/${target.arch}/${target.format}`);
  }
  const trusted = trustedBunForTarget(target.platform, target.arch, trustedRelease);
  const sha256 = sha256File(resolved);
  if (sha256 !== trusted.binarySha256) {
    throw new Error(`Bun binary SHA-256 is not trusted for Bun ${trusted.version} ${target.platform}/${target.arch}: found ${sha256}`);
  }
  return { path: resolved, sha256, trusted };
}

export function ensureDependencies(sourceDirectory, runInstall = () => run(["install", "--frozen-lockfile"], sourceDirectory)) {
  const dependencySentinels = [
    "node_modules/.bun",
    "apps/server/node_modules/express",
    "apps/web/node_modules/vite",
  ];
  if (dependencySentinels.every((entry) => existsSync(path.join(sourceDirectory, entry)))) return false;
  const lockfile = path.join(sourceDirectory, "bun.lock");
  if (!existsSync(lockfile)) throw new Error(`Toonflow lockfile is missing: ${lockfile}`);
  const lockfileContents = readFileSync(lockfile);
  console.log("Toonflow dependencies are missing; running bun install --frozen-lockfile");
  let installError;
  try {
    runInstall();
  } catch (error) {
    installError = error;
  }
  if (!existsSync(lockfile) || !readFileSync(lockfile).equals(lockfileContents)) {
    writeFileSync(lockfile, lockfileContents);
    throw new Error("bun install modified modules/toonflowV2/bun.lock despite --frozen-lockfile; the original lockfile was restored", { cause: installError });
  }
  if (installError) throw installError;
  const missing = dependencySentinels.filter((entry) => !existsSync(path.join(sourceDirectory, entry)));
  if (missing.length) throw new Error(`bun install completed with missing Toonflow dependencies: ${missing.join(", ")}`);
  return true;
}

export function sourceRevision(sourceDirectory) {
  const hash = createHash("sha256");
  const ignored = new Set([".git", "backup", "build", "coverage", "data", "node_modules", "work"]);
  const ignoredFiles = new Set(["apps/web/src/types/components.d.ts"]);
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isDirectory() && (ignored.has(entry.name) || entry.name.startsWith("node_modules."))) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(sourceDirectory, absolute).split(path.sep).join("/");
        if (ignoredFiles.has(relative)) continue;
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  }
  visit(sourceDirectory);
  return `sha256:${hash.digest("hex")}`;
}

export function main() {
  const target = resolveToonFactoryBuildTarget();
  const trustedBun = resolveTrustedBunBinary(process.env.BUN_BINARY || "bun", target);
  bun = trustedBun.path;
  const packageFile = path.join(source, "package.json");
  const lockfile = path.join(source, "bun.lock");
  if (!existsSync(packageFile)) throw new Error(`Toonflow package manifest is missing: ${packageFile}`);
  if (!existsSync(lockfile)) throw new Error(`Toonflow lockfile is missing: ${lockfile}`);
  const toonflowPackage = JSON.parse(readFileSync(packageFile, "utf8"));
  const expectedBunVersion = /^bun@(\d+\.\d+\.\d+)$/.exec(toonflowPackage.packageManager || "")?.[1];
  if (!expectedBunVersion) throw new Error("modules/toonflowV2/package.json must pin packageManager to an exact bun version");
  if (expectedBunVersion !== trustedBun.trusted.version) throw new Error(`Toonflow requires Bun ${expectedBunVersion}, but the trusted release is ${trustedBun.trusted.version}`);
  const revision = sourceRevision(source);
  const version = toonflowPackage.version || "unversioned";
  const lockfileSha256 = sha256File(lockfile);
  console.log(`Toonflow source: revision=${revision} version=${version} bun=${trustedBun.trusted.version} target=${target.platform}/${target.arch} lockfileSha256=${lockfileSha256}`);

  ensureDependencies(source);
  run(["run", "build:server"]);
  run(["build", "src/jugglework.ts", "--target=bun", "--outdir", "../../build/server"], path.join(source, "apps/server"));
  // Always build from the pinned source tree; never use a developer's external checkout.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  for (const name of ["server", "web", "nodes", "tools", "skills", "mcp"]) cpSync(path.join(source, "build", name), path.join(output, name), { recursive: true });
  for (const name of ["videoNode", "videoGenerationNode", "frameAnalysisNode"]) {
    if (!existsSync(path.join(output, "nodes", `${name}.umd.js`))) throw new Error(`Required local-media node was not built: ${name}`);
  }
  copyFileSync(path.join(source, "LICENSE"), path.join(output, "LICENSE"));
  const runtime = path.join(output, target.executableName);
  copyFileSync(trustedBun.path, runtime);
  chmodSync(runtime, 0o755);

  const executable = inspectToonFactoryExecutable(runtime);
  if (executable.platform !== target.platform || executable.arch !== target.arch || executable.format !== target.format) {
    throw new Error(`Resolved Bun is ${executable.platform}/${executable.arch}/${executable.format}, expected ${target.platform}/${target.arch}/${target.format}`);
  }
  const files = inventoryToonFactoryBundle(output);
  const inventorySha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  writeFileSync(path.join(output, "build-manifest.json"), `${JSON.stringify({
    schemaVersion: 3,
    toonflow: { revision, version, lockfileSha256 },
    target,
    bun: { version: trustedBun.trusted.version, platform: target.platform, arch: target.arch, executableName: target.executableName, format: target.format, bytes: statSync(runtime).size, sha256: trustedBun.sha256, provenance: trustedBun.trusted.provenance },
    inventorySha256,
    files,
  }, null, 2)}\n`);
  console.log(`Toonflow v2 module built: ${output} (${files.length} files, inventorySha256=${inventorySha256})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

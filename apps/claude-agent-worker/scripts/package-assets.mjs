import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(workerRoot, "../..")
const outputRoot = resolve(process.env.JUGGLEWORK_CLAUDE_ASSETS_DIR?.trim() || process.argv[2] || join(workerRoot, "package"))
const target = process.env.TARGET?.trim() || process.env.JUGGLEWORK_CLAUDE_TARGET?.trim() || hostTarget()
const targetInfo = targetDetails(target)
const packageJson = JSON.parse(readFileSync(join(workerRoot, "package.json"), "utf8"))
const sdkVersion = packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"]
const nodeVersion = process.env.JUGGLEWORK_CLAUDE_NODE_VERSION?.trim() || "24.19.0"

if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) throw new Error("Claude Agent SDK dependency must be exact-pinned")
if (!targetInfo) throw new Error(`Unsupported Claude Agent package target: ${target}`)
if (!/^24\.\d+\.\d+$/.test(nodeVersion)) throw new Error(`Claude worker Node must be exact-pinned to Node 24: ${nodeVersion}`)

function hostTarget() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (process.platform === "linux") return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  return "unknown"
}

function targetDetails(value) {
  const targets = {
    "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", sdk: "darwin-arm64", node: "darwin-arm64", archive: "tar.gz", nodeBin: "bin/node" },
    "x86_64-apple-darwin": { platform: "darwin", arch: "x64", sdk: "darwin-x64", node: "darwin-x64", archive: "tar.gz", nodeBin: "bin/node" },
    "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", sdk: "linux-arm64", node: "linux-arm64", archive: "tar.xz", nodeBin: "bin/node" },
    "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", sdk: "linux-x64", node: "linux-x64", archive: "tar.xz", nodeBin: "bin/node" },
    "aarch64-pc-windows-msvc": { platform: "win32", arch: "arm64", sdk: "win32-arm64", node: "win-arm64", archive: "zip", nodeBin: "node.exe" },
    "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", sdk: "win32-x64", node: "win-x64", archive: "zip", nodeBin: "node.exe" },
  }
  return targets[value] || null
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
}

function output(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || result.stderr || "").trim()
}

function walkPackageJson(root, packageName) {
  if (!existsSync(root)) return null
  const parts = packageName.split("/")
  const direct = join(root, "node_modules", ...parts, "package.json")
  if (existsSync(direct)) return direct
  const result = spawnSync(process.execPath, ["-e", `
    const fs = require("node:fs"), path = require("node:path")
    const root = process.argv[1], name = process.argv[2]
    for (const entry of fs.readdirSync(path.join(root, "node_modules", ".pnpm"))) {
      const candidate = path.join(root, "node_modules", ".pnpm", entry, "node_modules", ...name.split("/"), "package.json")
      if (fs.existsSync(candidate)) { process.stdout.write(candidate); break }
    }
  `, root, packageName], { encoding: "utf8" })
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

function fetchOptionalPackage(packageName) {
  const destination = join(outputRoot, ".optional-package")
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  run(npm, ["pack", `${packageName}@${sdkVersion}`, "--pack-destination", destination], destination)
  const archive = readdirSync(destination).find((entry) => entry.endsWith(".tgz"))
  if (!archive) throw new Error(`Could not fetch ${packageName}@${sdkVersion}`)
  run("tar", ["-xzf", join(destination, archive), "-C", destination])
  return join(destination, "package", "package.json")
}

function downloadNode() {
  const nodeRoot = join(outputRoot, "node")
  const nodePath = join(nodeRoot, targetInfo.nodeBin)
  if (existsSync(nodePath)) return nodePath
  const baseName = `node-v${nodeVersion}-${targetInfo.node}`
  const archiveName = `${baseName}.${targetInfo.archive}`
  const archivePath = join(outputRoot, archiveName)
  run(process.platform === "win32" ? "curl.exe" : "curl", ["-fsSL", `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`, "-o", archivePath])
  const extractRoot = join(outputRoot, ".node-extract")
  rmSync(extractRoot, { recursive: true, force: true })
  mkdirSync(extractRoot, { recursive: true })
  if (targetInfo.archive === "zip") {
    run("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractRoot.replaceAll("'", "''")}' -Force`])
  } else {
    run("tar", ["-xf", archivePath, "-C", extractRoot])
  }
  mkdirSync(dirname(nodePath), { recursive: true })
  copyFileSync(join(extractRoot, baseName, targetInfo.nodeBin), nodePath)
  rmSync(extractRoot, { recursive: true, force: true })
  rmSync(archivePath, { force: true })
  chmodSync(nodePath, 0o755)
  return nodePath
}

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
const localBin = join(workerRoot, "node_modules", ".bin")
run(join(localBin, process.platform === "win32" ? "tsc.cmd" : "tsc"), ["-p", "tsconfig.build.json"], workerRoot)
run(process.platform === "win32" ? "bun.exe" : "bun", ["build", "src/cli.ts", "--target", "node", "--format", "esm", "--outfile", "dist/cli.bundle.js"], workerRoot)
const deployRoot = join(outputRoot, "worker")
mkdirSync(join(deployRoot, "dist"), { recursive: true })
copyFileSync(join(workerRoot, "dist", "cli.bundle.js"), join(deployRoot, "dist", "cli.js"))
const sdkPackagePath = walkPackageJson(workerRoot, "@anthropic-ai/claude-agent-sdk")
if (!sdkPackagePath) throw new Error("Installed Claude worker is missing @anthropic-ai/claude-agent-sdk")
const sdkPackage = JSON.parse(readFileSync(sdkPackagePath, "utf8"))
if (sdkPackage.version !== sdkVersion) throw new Error(`Deployed SDK version ${sdkPackage.version} does not match ${sdkVersion}`)
writeFileSync(join(deployRoot, "sdk-package.json"), `${JSON.stringify({
  name: sdkPackage.name,
  version: sdkPackage.version,
  claudeCodeVersion: sdkPackage.claudeCodeVersion,
}, null, 2)}\n`)
const cliPackageName = `@anthropic-ai/claude-agent-sdk-${targetInfo.sdk}`
const cliPackagePath = walkPackageJson(repoRoot, cliPackageName) || fetchOptionalPackage(cliPackageName)
const cliPackage = JSON.parse(readFileSync(cliPackagePath, "utf8"))
if (cliPackage.version !== sdkVersion) throw new Error(`Claude CLI package version ${cliPackage.version} does not match SDK ${sdkVersion}`)
const sourceCli = join(dirname(cliPackagePath), targetInfo.platform === "win32" ? "claude.exe" : "claude")
if (!existsSync(sourceCli) || !statSync(sourceCli).isFile()) throw new Error(`Claude CLI binary is missing: ${sourceCli}`)
const cliPath = join(outputRoot, "claude", targetInfo.platform === "win32" ? "claude.exe" : "claude")
mkdirSync(dirname(cliPath), { recursive: true })
copyFileSync(sourceCli, cliPath)
chmodSync(cliPath, 0o755)
for (const name of ["LICENSE.md", "README.md"]) {
  const source = join(dirname(cliPackagePath), name)
  if (existsSync(source)) copyFileSync(source, join(dirname(cliPath), name))
}
rmSync(join(outputRoot, ".optional-package"), { recursive: true, force: true })

const nodePath = downloadNode()
const cliVersion = target === hostTarget() ? output(cliPath, ["--version"]) : `Claude Code ${sdkPackage.claudeCodeVersion}`
writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  target,
  platform: targetInfo.platform,
  arch: targetInfo.arch,
  sdkVersion,
  cliVersion: sdkPackage.claudeCodeVersion,
  nodeVersion,
  paths: {
    worker: "worker/dist/cli.js",
    node: `node/${targetInfo.nodeBin}`,
    claude: `claude/${targetInfo.platform === "win32" ? "claude.exe" : "claude"}`,
  },
}, null, 2)}\n`)

process.stdout.write(`${JSON.stringify({ ok: true, target, outputRoot, nodePath, cliPath, cliVersion })}\n`)

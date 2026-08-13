import { constants, existsSync, readFileSync, statSync } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(process.argv[2] || process.env.JUGGLEWORK_CLAUDE_ASSETS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "package"))
const manifestPath = join(root, "manifest.json")
if (!existsSync(manifestPath)) throw new Error(`Missing Claude runtime manifest: ${manifestPath}`)
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const expectedSdkVersion = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).dependencies["@anthropic-ai/claude-agent-sdk"]
if (manifest.sdkVersion !== expectedSdkVersion) throw new Error(`Packaged SDK version ${manifest.sdkVersion} does not match ${expectedSdkVersion}`)
for (const key of ["worker", "node", "claude"]) {
  const relativePath = manifest.paths?.[key]
  if (!relativePath || relativePath.includes("..")) throw new Error(`Invalid Claude runtime ${key} path`)
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) throw new Error(`Missing Claude runtime ${key}: ${absolutePath}`)
  await access(absolutePath, key === "worker" ? constants.R_OK : constants.R_OK | constants.X_OK)
}
const sdkPackage = join(root, "worker", "sdk-package.json")
if (!existsSync(sdkPackage)) throw new Error(`Worker package is missing exact SDK content: ${sdkPackage}`)
if (JSON.parse(readFileSync(sdkPackage, "utf8")).version !== expectedSdkVersion) throw new Error("Worker package SDK version is not exact-pinned")
process.stdout.write(`${JSON.stringify({ ok: true, target: manifest.target, sdkVersion: manifest.sdkVersion, cliVersion: manifest.cliVersion, nodeVersion: manifest.nodeVersion })}\n`)

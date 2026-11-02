import type { RequestHandler } from "express";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { error } from "@/lib/responseFormat";

type ManagedResource = "tools" | "nodes" | "skills";
type ManagedResourceRoots = Record<ManagedResource, string>;

let managedResourceRoots: ManagedResourceRoots | undefined;

const managedBuiltInToolAllowlist = new Set(["askUser", "canvas", "mediaGeneration", "skillOperator", "webSearch", "workspace"]);
const managedBuiltInToolDenylist = new Set(["webFetch"]);
const managedBuiltInNodes = new Set(["textNode", "imageNode", "videoNode", "audioNode", "imageGenerationNode", "videoGenerationNode", "director3dNode", "frameAnalysisNode"]);
const managedDirectoryGrants = new Set<string>();

const deniedExactPaths = new Set([
  "/api/agents/connect",
  "/api/desktop/devtools",
  "/api/desktop/openurl",
  "/api/desktop/plugins/install",
  "/api/plugins/export",
  "/api/providers/models",
]);

const deniedPathPrefixes = [
  "/a2a",
  "/mcp",
  "/mobilelink",
  "/api/mobilelink",
  "/api/mcp",
  "/api/agents/a2a",
  "/api/desktop/providerfile",
  "/api/desktop/update",
  "/api/ffmpeg",
  "/api/providers/debug",
  "/api/providers/media",
];

const deniedManagedActions = new Map([
  ["/api/agents", new Set(["install", "save", "setenabled", "uninstall"])],
  ["/api/nodes", new Set(["install", "save", "setenabled", "uninstall"])],
  ["/api/skills", new Set(["create", "install", "move", "order", "save", "uninstall"])],
  ["/api/tools", new Set(["install", "save", "setenabled", "uninstall"])],
]);

export const managedSettingsKeys = new Set(["general", "personalization", "stores", "ui"]);

export function isManagedMode(env: NodeJS.ProcessEnv = process.env) {
  return env.JUGGLEWORK_MANAGED === "1";
}

function directoryGrantKey(directory: string) {
  const key = resolve(directory);
  return process.platform === "win32" ? key.toLowerCase() : key;
}

export async function authorizeManagedDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new Error("工作目录授权必须是绝对路径");
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) throw new Error("工作目录授权必须是文件夹");
  managedDirectoryGrants.add(directoryGrantKey(canonical));
  return canonical;
}

export function clearManagedDirectoryGrants() {
  managedDirectoryGrants.clear();
}

export function requireManagedDirectoryGrant(directory: string, managed = isManagedMode()) {
  if (!managed) return;
  if (!managedDirectoryGrants.has(directoryGrantKey(directory))) {
    throw Object.assign(new Error("工作目录尚未授权，请重新选择文件夹"), { status: 403, code: "DIRECTORY_GRANT_REQUIRED" });
  }
}

function isWithin(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function configureManagedResources({
  resourcesRoot,
  dataDirectory,
  toolsRoot,
  nodesRoot,
  skillsRoot,
  manifestPath,
  pluginRevision,
}: {
  resourcesRoot: string;
  dataDirectory?: string;
  toolsRoot: string;
  nodesRoot: string;
  skillsRoot: string;
  manifestPath?: string;
  pluginRevision?: string;
}) {
  const distributionPath = resolve(resourcesRoot);
  const distributionInfo = await lstat(distributionPath);
  if (!distributionInfo.isDirectory() || distributionInfo.isSymbolicLink()) throw new Error("managed 构建资源根目录无效");
  const distributionRoot = await realpath(distributionPath);
  const dataRoot = dataDirectory ? await realpath(resolve(dataDirectory)) : undefined;
  const configuredRoots = { tools: resolve(toolsRoot), nodes: resolve(nodesRoot), skills: resolve(skillsRoot) };
  const roots = {} as ManagedResourceRoots;
  for (const [name, configuredRoot] of Object.entries(configuredRoots) as [ManagedResource, string][]) {
    const info = await lstat(configuredRoot);
    const root = await realpath(configuredRoot);
    if (!isWithin(distributionRoot, root) || (dataRoot && isWithin(dataRoot, root))) {
      throw new Error(`managed ${name} 目录必须位于只读构建资源中`);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`managed ${name} 目录无效`);
    roots[name] = root;
  }

  let inventorySha256: string | undefined;
  if (manifestPath) {
    const manifest = await readFile(manifestPath, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return "";
      throw cause;
    });
    if (manifest) {
      const parsed: unknown = JSON.parse(manifest);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("managed build manifest 无效");
      const record = parsed as { inventorySha256?: unknown; files?: unknown };
      if (typeof record.inventorySha256 !== "string" || !Array.isArray(record.files)) throw new Error("managed build manifest 缺少资源清单");
      const files = record.files.flatMap(item => item && typeof item === "object" && !Array.isArray(item) && typeof (item as { path?: unknown }).path === "string"
        ? [(item as { path: string }).path] : []);
      for (const directory of ["server", "web", "tools", "nodes", "skills"]) {
        if (!files.some(path => path.startsWith(`${directory}/`))) throw new Error(`managed build manifest 缺少 ${directory} 目录`);
      }
      inventorySha256 = record.inventorySha256;
    }
  }
  managedResourceRoots = roots;
  return { pluginRevision, inventorySha256 };
}

export function managedResourceDirectory(resource: ManagedResource, fallback: string, managed = isManagedMode()) {
  if (!managed) return fallback;
  const root = managedResourceRoots?.[resource];
  if (!root) throw new Error(`managed ${resource} 资源目录尚未配置`);
  return root;
}

export function managedToolConfig(name: string, config: Record<string, unknown>, managed = isManagedMode()) {
  if (!managed) return config;
  if (name === "mediaGeneration") return { ...config, allowAudio: false };
  if (name === "skillOperator") return { ...config, allowCreate: false, allowUpdate: false };
  return config;
}

export function managedBuiltInToolAllowed(name: string, managed = isManagedMode()) {
  return !managed || (managedBuiltInToolAllowlist.has(name) && !managedBuiltInToolDenylist.has(name));
}

export function managedBuiltInNodeAllowed(name: string, managed = isManagedMode()) {
  return !managed || managedBuiltInNodes.has(name);
}

function matchesPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isManagedRouteDenied(path: string) {
  try { path = decodeURIComponent(path); } catch { return true; }
  path = posix.normalize(path.toLowerCase().replaceAll("\\", "/").replace(/\/{2,}/g, "/")).replace(/\/+$/, "") || "/";
  if (deniedExactPaths.has(path) || deniedPathPrefixes.some(prefix => matchesPrefix(path, prefix))) return true;
  for (const [prefix, actions] of deniedManagedActions) {
    if (actions.has(path.slice(prefix.length + 1)) && path.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

export function managedGuard(managed = isManagedMode()): RequestHandler {
  return (req, res, next) => {
    if (!managed || !isManagedRouteDenied(req.path)) { next(); return; }
    res.status(403).json(error("JuggleWork managed 模式不允许此操作", null, 403));
  };
}

export function managedSettings(settings: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => managedSettingsKeys.has(key)));
}

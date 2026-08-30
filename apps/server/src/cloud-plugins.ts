import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ServerConfig } from "./types.js";
import { ApiError } from "./errors.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { readRuntimeOpencodeConfig, runtimeMcpMap, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "./runtime-db.js";

const OPENCODE_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const OPENCODE_MCP_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const OPENCODE_MCP_IMPORT_PATH_PREFIX = "opencode.jsonc#mcp.";

type CloudPluginConfigObjectType = "skill" | "agent" | "command" | "tool" | "mcp" | "hook" | "context" | "custom";

type CloudPluginConfigObjectVersion = {
  id: string;
  rawSourceText: string | null;
  normalizedPayloadJson: Record<string, unknown> | null;
};

type CloudPluginConfigObject = {
  id: string;
  objectType: CloudPluginConfigObjectType;
  title: string;
  description: string | null;
  currentRelativePath: string | null;
  status: string;
  updatedAt: string | null;
  latestVersion: CloudPluginConfigObjectVersion | null;
};

type CloudPluginMembership = {
  configObjectId: string;
  configObject?: CloudPluginConfigObject;
};

type CloudPluginCloudReadinessState = "ready" | "needs_signin" | "needs_admin_setup" | "desktop_only" | "not_synced";

type CloudPluginCloudReadiness = {
  state: CloudPluginCloudReadinessState;
  hasInstructional: boolean;
  connections: Array<{
    id: string | null;
    name: string;
    url: string;
    configObjectId?: string;
    serverName?: string;
    credentialMode?: "shared" | "per_member";
    connectedForMe?: boolean;
  }>;
  components: Array<{
    configObjectId: string;
    serverName: string;
    delivery: "cloud" | "desktop";
    url?: string;
    command?: string[];
    connectionId?: string | null;
    credentialMode?: "shared" | "per_member";
    connectedForMe?: boolean;
  }>;
};

export type CloudPluginResolved = {
  plugin: {
    id: string;
    name: string;
    description: string | null;
    updatedAt: string | null;
    cloudReadiness?: CloudPluginCloudReadiness;
  };
  memberships: CloudPluginMembership[];
};

export type CloudImportedPluginFile = {
  configObjectId: string;
  componentKey?: string;
  serverName?: string;
  versionId: string | null;
  objectType: string;
  title: string;
  path: string;
  updatedAt: string | null;
  delivery?: "local_file" | "runtime_mcp" | "cloud";
  outcome?: "installed_local" | "available_cloud" | "needs_signin" | "needs_admin_setup" | "unsupported" | "failed";
  ownerPluginId?: string;
  ownerConfigObjectId?: string;
  digest?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type CloudImportedPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  name: string;
  description: string | null;
  updatedAt: string | null;
  files: CloudImportedPluginFile[];
  importedAt: number | null;
  resolvedRevision?: string;
  status?: CloudPluginOperationStatus;
  repair?: CloudPluginRepairDetails;
};

export type CloudPluginOperationStatus = "installed" | "partial" | "failed" | "repair_required";
export type CloudPluginOperation = "install" | "sync" | "remove";

export type CloudPluginRollbackFailure = {
  stage: string;
  message: string;
};

export type CloudPluginRepairDetails = {
  operation: CloudPluginOperation;
  cause: string;
  conflicts: CloudPluginConflict[];
  rollbackFailures: CloudPluginRollbackFailure[];
  recordedAt: number;
};

export type CloudPluginEngineMutation = {
  upsertNames: string[];
  removeNames: string[];
};

export type CloudPluginConflict = {
  code: "file_ownership_conflict" | "mcp_ownership_conflict";
  configObjectId: string;
  resource: string;
  message: string;
};

export type CloudPluginInstallResult = {
  item: CloudImportedPlugin;
  changed: boolean;
  current: CloudImportedPlugin | null;
  operation: Exclude<CloudPluginOperation, "remove">;
  mutations: CloudPluginMutations;
  refreshHints: string[];
  warnings: string[];
  status: CloudPluginOperationStatus;
  outcomes: CloudImportedPluginFile[];
  conflicts: CloudPluginConflict[];
  cause?: string;
  rollbackFailures?: CloudPluginRollbackFailure[];
};

export type CloudPluginMutations = {
  filesWritten: string[];
  filesRemoved: string[];
  mcpUpserted: string[];
  mcpRemoved: string[];
  installationRecordChanged: boolean;
  engineSynchronized: boolean;
};

export type CloudPluginRemoveResult = {
  item: CloudImportedPlugin;
  changed: true;
  current: null;
  operation: "remove";
  mutations: CloudPluginMutations;
  refreshHints: string[];
  warnings: string[];
  status: "installed";
  outcomes: CloudImportedPluginFile[];
  conflicts: [];
};

type CloudPluginFileWrite = {
  path: string;
  content: string;
  ledger: CloudImportedPluginFile;
};

type CloudPluginMcpUpsert = {
  name: string;
  config: Record<string, unknown>;
  ledger: CloudImportedPluginFile;
};

export type CloudPluginDeliveryPlan = {
  fileWrites: CloudPluginFileWrite[];
  fileRemovals: string[];
  mcpUpserts: CloudPluginMcpUpsert[];
  mcpRemovals: string[];
  outcomes: CloudImportedPluginFile[];
  warnings: string[];
  conflicts: CloudPluginConflict[];
};

type WorkspaceCloudImports = {
  skills: Record<string, unknown>;
  providers: Record<string, unknown>;
  marketplaces: Record<string, { marketplaceId: string; name: string; updatedAt: string | null; pluginIds: string[]; importedAt: number | null }>;
  plugins: Record<string, CloudImportedPlugin>;
};

const cloudPluginInstallConfigs = sqliteTable("cloud_plugin_install_configs", {
  workspaceId: text("workspace_id").primaryKey(),
  configJson: text("config_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

type CloudPluginDb = {
  get: (workspaceId: string) => { configJson: string } | undefined;
  upsert: (value: { workspaceId: string; configJson: string; updatedAt: number }) => void;
};

type CloudPluginInstallInput = {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  marketplaceId: string | null;
  marketplace?: { id: string; name: string; updatedAt: string | null } | null;
  resolved: CloudPluginResolved;
  /**
   * 远程 MCP 是否由 JuggleWork Connect 网关承载。组织云端插件传 true（远程组件不落盘）；
   * GitHub Claude bundle 保持默认 false，其远程 MCP 仍写入本地配置。
   */
  cloudGatewayHosted?: boolean;
  /** 将受影响的 MCP 精确同步到实时引擎；抛错会触发整个操作回滚。 */
  synchronizeEngine?: (mutation: CloudPluginEngineMutation) => Promise<void>;
  /** 仅供事务测试注入指定阶段失败。 */
  failAfterStage?: "files" | "mcp" | "record" | "engine";
  /** 仅供事务测试注入回滚失败。 */
  failRollbackStage?: "files" | "mcp" | "record" | "engine";
};

type CloudPluginRemoveInput = {
  serverConfig: ServerConfig;
  workspaceId: string;
  workspaceRoot: string;
  pluginId: string;
  /** 将受影响的 MCP 精确同步到实时引擎；抛错会触发整个操作回滚。 */
  synchronizeEngine?: (mutation: CloudPluginEngineMutation) => Promise<void>;
  /** 仅供事务测试注入指定阶段失败。 */
  failAfterStage?: "files" | "mcp" | "record" | "engine";
  /** 仅供事务测试注入回滚失败。 */
  failRollbackStage?: "files" | "mcp" | "record" | "engine";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const text = readString(entry);
    return text ? [text] : [];
  }) : [];
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = readString(entry);
    if (text) output[key] = text;
  }
  return Object.keys(output).length ? output : null;
}

function readDelivery(value: unknown): CloudImportedPluginFile["delivery"] {
  return value === "local_file" || value === "runtime_mcp" || value === "cloud" ? value : undefined;
}

function readOutcome(value: unknown): CloudImportedPluginFile["outcome"] {
  return value === "installed_local" || value === "available_cloud" || value === "needs_signin"
    || value === "needs_admin_setup" || value === "unsupported" || value === "failed"
    ? value
    : undefined;
}

function readOperationStatus(value: unknown): CloudPluginOperationStatus | undefined {
  return value === "installed" || value === "partial" || value === "failed" || value === "repair_required"
    ? value
    : undefined;
}

function readRepairDetails(value: unknown): CloudPluginRepairDetails | undefined {
  if (!isRecord(value) || (value.operation !== "install" && value.operation !== "sync" && value.operation !== "remove")) return undefined;
  const cause = readString(value.cause);
  const recordedAt = typeof value.recordedAt === "number" && Number.isFinite(value.recordedAt) ? value.recordedAt : null;
  if (!cause || recordedAt === null || !Array.isArray(value.rollbackFailures)) return undefined;
  const rollbackFailures = value.rollbackFailures.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const stage = readString(entry.stage);
    const message = readString(entry.message);
    return stage && message ? [{ stage, message }] : [];
  });
  const conflicts: CloudPluginConflict[] = Array.isArray(value.conflicts) ? value.conflicts.flatMap((entry): CloudPluginConflict[] => {
    if (!isRecord(entry) || (entry.code !== "file_ownership_conflict" && entry.code !== "mcp_ownership_conflict")) return [];
    const configObjectId = readString(entry.configObjectId);
    const resource = readString(entry.resource);
    const message = readString(entry.message);
    return configObjectId && resource && message ? [{ code: entry.code, configObjectId, resource, message }] : [];
  }) : [];
  return { operation: value.operation, cause, conflicts, rollbackFailures, recordedAt };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)) ?? "undefined").digest("hex");
}

/**
 * 计算 resolved 插件图的确定性版本标识。
 *
 * TIPS：成员顺序和 JSON 对象键顺序不属于发布身份；组件图、版本 ID、原始内容、规范化载荷
 * 以及 Cloud 投递绑定才属于。这样相同发布无论上游返回顺序如何都得到同一个 revision。
 *
 * @param resolved 已解析的插件图
 * @returns SHA-256 resolved revision
 */
export function resolveCloudPluginRevision(resolved: CloudPluginResolved): string {
  const memberships = resolved.memberships.map((membership) => ({
    configObjectId: membership.configObjectId,
    configObject: membership.configObject ? {
      id: membership.configObject.id,
      objectType: membership.configObject.objectType,
      title: membership.configObject.title,
      description: membership.configObject.description,
      currentRelativePath: membership.configObject.currentRelativePath,
      status: membership.configObject.status,
      latestVersion: membership.configObject.latestVersion ? {
        id: membership.configObject.latestVersion.id,
        rawSourceText: membership.configObject.latestVersion.rawSourceText,
        normalizedPayloadJson: membership.configObject.latestVersion.normalizedPayloadJson,
      } : null,
    } : null,
  })).sort((left, right) => left.configObjectId.localeCompare(right.configObjectId)
    || digestValue(left).localeCompare(digestValue(right)));
  const readiness = resolved.plugin.cloudReadiness ? {
    ...resolved.plugin.cloudReadiness,
    connections: [...resolved.plugin.cloudReadiness.connections].sort((left, right) =>
      `${left.id ?? ""}\0${left.configObjectId ?? ""}\0${left.serverName ?? ""}`
        .localeCompare(`${right.id ?? ""}\0${right.configObjectId ?? ""}\0${right.serverName ?? ""}`)
      || digestValue(left).localeCompare(digestValue(right))),
    components: [...resolved.plugin.cloudReadiness.components].sort((left, right) =>
      `${left.configObjectId}\0${left.serverName}`.localeCompare(`${right.configObjectId}\0${right.serverName}`)
      || digestValue(left).localeCompare(digestValue(right))),
  } : null;
  return digestValue({
    plugin: {
      id: resolved.plugin.id,
      name: resolved.plugin.name,
      description: resolved.plugin.description,
      updatedAt: resolved.plugin.updatedAt,
      cloudReadiness: readiness,
    },
    memberships,
  });
}

function mcpOwnershipDigest(config: Record<string, unknown>): string {
  const { enabled: _memberPreference, ...ownedConfig } = config;
  return digestValue(ownedConfig);
}

function parseJsonRecord(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeConfigObjectType(value: unknown): CloudPluginConfigObjectType | null {
  switch (value) {
    case "skill":
    case "agent":
    case "command":
    case "tool":
    case "mcp":
    case "hook":
    case "context":
    case "custom":
      return value;
    default:
      return null;
  }
}

function normalizeConfigObjectVersion(value: unknown): CloudPluginConfigObjectVersion | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    rawSourceText: typeof value.rawSourceText === "string" ? value.rawSourceText : null,
    normalizedPayloadJson: isRecord(value.normalizedPayloadJson) ? value.normalizedPayloadJson : null,
  };
}

function normalizeConfigObject(value: unknown): CloudPluginConfigObject | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  const objectType = normalizeConfigObjectType(value.objectType);
  if (!objectType) return null;
  return {
    id: value.id,
    objectType,
    title: value.title,
    description: typeof value.description === "string" ? value.description : null,
    currentRelativePath: typeof value.currentRelativePath === "string" ? value.currentRelativePath : null,
    status: typeof value.status === "string" ? value.status : "active",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    latestVersion: normalizeConfigObjectVersion(value.latestVersion),
  };
}

function normalizeCloudReadinessState(value: unknown): CloudPluginCloudReadinessState | null {
  return value === "ready" || value === "needs_signin" || value === "needs_admin_setup"
    || value === "desktop_only" || value === "not_synced"
    ? value
    : null;
}

function normalizeCloudReadiness(value: unknown): CloudPluginCloudReadiness | null {
  if (!isRecord(value) || typeof value.hasInstructional !== "boolean" || !Array.isArray(value.connections)) return null;
  const state = normalizeCloudReadinessState(value.state);
  if (!state) return null;
  const connections = value.connections.flatMap<CloudPluginCloudReadiness["connections"][number]>((entry) => {
    if (!isRecord(entry) || (entry.id !== null && typeof entry.id !== "string")
      || typeof entry.name !== "string" || typeof entry.url !== "string") return [];
    const credentialMode: "shared" | "per_member" | undefined = entry.credentialMode === "shared" || entry.credentialMode === "per_member"
      ? entry.credentialMode
      : undefined;
    return [{
      id: entry.id,
      name: entry.name,
      url: entry.url,
      ...(typeof entry.configObjectId === "string" ? { configObjectId: entry.configObjectId } : {}),
      ...(typeof entry.serverName === "string" ? { serverName: entry.serverName } : {}),
      ...(credentialMode ? { credentialMode } : {}),
      ...(typeof entry.connectedForMe === "boolean" ? { connectedForMe: entry.connectedForMe } : {}),
    }];
  });
  const components = Array.isArray(value.components)
    ? value.components.flatMap<CloudPluginCloudReadiness["components"][number]>((entry) => {
    if (!isRecord(entry) || typeof entry.configObjectId !== "string"
      || (entry.delivery !== "cloud" && entry.delivery !== "desktop")) return [];
    const command = readStringArray(entry.command);
    const credentialMode: "shared" | "per_member" | undefined = entry.credentialMode === "shared" || entry.credentialMode === "per_member"
      ? entry.credentialMode
      : undefined;
    return [{
      configObjectId: entry.configObjectId,
      serverName: typeof entry.serverName === "string" ? entry.serverName : "",
      delivery: entry.delivery,
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      ...(command.length > 0 ? { command } : {}),
      ...(entry.connectionId === null || typeof entry.connectionId === "string" ? { connectionId: entry.connectionId } : {}),
      ...(credentialMode ? { credentialMode } : {}),
      ...(typeof entry.connectedForMe === "boolean" ? { connectedForMe: entry.connectedForMe } : {}),
    }];
    })
    : [];
  return { state, hasInstructional: value.hasInstructional, connections, components };
}

function normalizeCloudPluginResolved(value: unknown): CloudPluginResolved | null {
  if (!isRecord(value) || !isRecord(value.plugin) || !Array.isArray(value.memberships)) return null;
  if (typeof value.plugin.id !== "string" || typeof value.plugin.name !== "string") return null;
  const memberships = value.memberships.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.configObjectId !== "string") return [];
    const configObject = normalizeConfigObject(entry.configObject);
    return [{ configObjectId: entry.configObjectId, ...(configObject ? { configObject } : {}) }];
  });
  return {
    plugin: {
      id: value.plugin.id,
      name: value.plugin.name,
      description: typeof value.plugin.description === "string" ? value.plugin.description : null,
      updatedAt: typeof value.plugin.updatedAt === "string" ? value.plugin.updatedAt : null,
      ...(normalizeCloudReadiness(value.plugin.cloudReadiness)
        ? { cloudReadiness: normalizeCloudReadiness(value.plugin.cloudReadiness)! }
        : {}),
    },
    memberships,
  };
}

export function readCloudPluginResolved(value: unknown): CloudPluginResolved {
  const resolved = normalizeCloudPluginResolved(value);
  if (!resolved) throw new ApiError(400, "invalid_cloud_plugin", "resolved cloud plugin is required");
  return resolved;
}

function extractSkillBodyMarkdown(skillText: string): string {
  const trimmed = skillText.trim();
  if (!trimmed.startsWith("---")) return trimmed;
  const rest = trimmed.slice(3);
  const end = rest.indexOf("\n---");
  if (end === -1) return trimmed;
  return rest.slice(end + 4).replace(/^\s*\n?/, "");
}

function slugifyConfigObjectName(title: string, fallback: string): string {
  let base = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "skill";
  if (base.length > 64) base = base.slice(0, 64).replace(/-+$/g, "");
  if (!OPENCODE_SKILL_NAME_RE.test(base)) base = "skill";
  if (base === "skill" && fallback) return slugifyConfigObjectName(fallback, "");
  return base;
}

function pluginNamespace(pluginName: string, pluginId: string): string {
  const base = slugifyConfigObjectName(pluginName, pluginId);
  return `${base.replace(/-plugin$/, "")}-plugin`;
}

function normalizePluginSourcePath(path: string, objectType: string, namespace: string): string {
  // Marketplace paths are portable POSIX-style paths. Normalize Windows separators first so
  // traversal and duplicate-destination checks cannot be bypassed on Windows hosts.
  const parts = path.trim().replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === ".." || part === ".")) return "";

  const folderByType: Record<string, string> = {
    agent: "agents",
    command: "commands",
    context: "context",
    hook: "hooks",
    mcp: "mcps",
    skill: "skills",
    tool: "tools",
  };
  const folder = folderByType[objectType];
  if (!folder) return "";
  const opencodeIndex = parts.findIndex((part) => part === ".opencode");
  const searchParts = opencodeIndex >= 0 ? parts.slice(opencodeIndex + 1) : parts;
  const folderIndex = searchParts.findIndex((part) => part === folder);
  if (folderIndex < 0 || folderIndex === searchParts.length - 1) return "";
  const rest = searchParts.slice(folderIndex + 1);
  if (rest[0] === namespace) return [".opencode", folder, ...rest].join("/");
  return [".opencode", folder, namespace, ...rest].join("/");
}

function getPluginObjectInstallPath(object: CloudPluginConfigObject, namespace: string): string {
  const existing = normalizePluginSourcePath(object.currentRelativePath ?? "", object.objectType, namespace);
  if (existing) {
    if (object.objectType === "skill") {
      const parts = existing.split("/").filter(Boolean);
      const lastPart = parts.at(-1) ?? "";
      const skillName = /^SKILL\.md$/i.test(lastPart)
        ? parts.at(-2) ?? slugifyConfigObjectName(object.title, object.id)
        : lastPart || slugifyConfigObjectName(object.title, object.id);
      return `.opencode/skills/${namespace}/${skillName}/SKILL.md`;
    }
    return existing;
  }
  const name = slugifyConfigObjectName(object.title, object.id);
  switch (object.objectType) {
    case "skill":
      return `.opencode/skills/${namespace}/${name}/SKILL.md`;
    case "agent":
      return `.opencode/agents/${namespace}/${name}.md`;
    case "command":
      return `.opencode/commands/${namespace}/${name}.md`;
    case "mcp":
      return `.opencode/mcps/${namespace}/${name}.json`;
    case "hook":
      return `.opencode/hooks/${namespace}/${name}.json`;
    case "tool":
      return `.opencode/tools/${namespace}/${name}.ts`;
    case "context":
      return `.opencode/context/${namespace}/${name}.md`;
    default:
      return `.opencode/plugins/${namespace}/${name}.txt`;
  }
}

function buildCloudSkillContent(name: string, description: string, body: string): string {
  const safeDescription = description.replace(/\s+/g, " ").trim();
  const normalizedBody = body.replace(/^\s*\n?/, "");
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(safeDescription)}`,
    "---",
    "",
    normalizedBody,
  ].join("\n");
}

const OPENCODE_MODEL_ID_RE = /^[^\s/]+\/[^\s]+$/;

function translateClaudeTools(value: unknown): Record<string, boolean> | null {
  const names = typeof value === "string"
    ? value.split(",")
    : Array.isArray(value)
      ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
      : null;
  if (names) {
    const tools: Record<string, boolean> = {};
    for (const raw of names) {
      const name = raw.trim().toLowerCase();
      if (name) tools[name] = true;
    }
    return Object.keys(tools).length ? tools : null;
  }
  if (isRecord(value)) {
    const tools: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(value)) {
      const name = key.trim().toLowerCase();
      if (name && typeof entry === "boolean") tools[name] = entry;
    }
    return Object.keys(tools).length ? tools : null;
  }
  return null;
}

function translateClaudeModel(value: unknown): string | null {
  const model = readString(value);
  return model && OPENCODE_MODEL_ID_RE.test(model) ? model : null;
}

function cloudConfigObjectDescription(object: CloudPluginConfigObject): string {
  const rawDesc = (object.description?.trim() || object.title).trim();
  return rawDesc.slice(0, 1024) || object.title.slice(0, 1024);
}

function buildCloudAgentContent(description: string, rawSourceText: string): string {
  const { data, body } = parseFrontmatter(rawSourceText.trim());
  const safeDescription = (readString(data.description) ?? description).replace(/\s+/g, " ").trim();
  const model = translateClaudeModel(data.model);
  const tools = translateClaudeTools(data.tools);
  const frontmatter = buildFrontmatter({
    description: safeDescription,
    ...(model ? { model } : {}),
    ...(tools ? { tools } : {}),
  });
  return frontmatter + "\n" + body.replace(/^\s*\n?/, "");
}

function buildCloudCommandContent(name: string, description: string, rawSourceText: string): string {
  const { data, body } = parseFrontmatter(rawSourceText.trim());
  const safeDescription = (readString(data.description) ?? description).replace(/\s+/g, " ").trim();
  const model = translateClaudeModel(data.model);
  const agent = readString(data.agent);
  const frontmatter = buildFrontmatter({
    name,
    description: safeDescription,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(typeof data.subtask === "boolean" ? { subtask: data.subtask } : {}),
  });
  return frontmatter + "\n" + body.replace(/^\s*\n?/, "");
}

function pluginMcpName(rawName: string, namespace: string, fallback: string, namespaceName: boolean): string {
  const trimmed = rawName.trim();
  const base = OPENCODE_MCP_NAME_RE.test(trimmed) ? trimmed : slugifyConfigObjectName(trimmed || fallback, fallback);
  if (!namespaceName) return base;
  const namespaced = base.startsWith(`${namespace}-`) ? base : `${namespace}-${base}`;
  return OPENCODE_MCP_NAME_RE.test(namespaced) ? namespaced : slugifyConfigObjectName(namespaced, fallback);
}

function mcpCommandFromConfig(config: Record<string, unknown>): string[] {
  if (Array.isArray(config.command)) return readStringArray(config.command);
  const command = readString(config.command);
  if (!command) return [];
  return [command, ...readStringArray(config.args)];
}

/**
 * 把插件载荷里的一个 MCP 服务配置规范化成工作区可用的形状。
 *
 * TIPS：这里是白名单——没有显式搬运的键会在投递时被丢掉，且丢得静默：管理员在控制台
 * 明明填了超时/工作目录，成员机器上却没有。`timeout` / `cwd` / `transport` 与 OAuth
 * 客户端都是控制台表单已经能编辑的字段，必须一并落地。
 */
function normalizePluginMcpConfig(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : typeof input.disabled === "boolean"
      ? !input.disabled
      : true;
  const timeout = typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
    ? Math.round(input.timeout)
    : null;
  const url = readString(input.url);
  if (url) {
    const config: Record<string, unknown> = { type: "remote", url, enabled };
    const transport = readString(input.transport);
    if (transport === "streamable-http" || transport === "sse") config.transport = transport;
    const headers = readStringRecord(input.headers);
    if (headers) config.headers = headers;
    if (isRecord(input.oauth)) config.oauth = input.oauth;
    if (input.oauth === true) config.oauth = {};
    if (input.oauth === false) config.oauth = false;
    if (timeout !== null) config.timeout = timeout;
    return config;
  }

  const command = mcpCommandFromConfig(input);
  if (command.length > 0) {
    const config: Record<string, unknown> = { type: "local", command, enabled };
    const environment = readStringRecord(input.environment) ?? readStringRecord(input.env);
    if (environment) config.environment = environment;
    const cwd = readString(input.cwd);
    if (cwd) config.cwd = cwd;
    if (timeout !== null) config.timeout = timeout;
    return config;
  }

  return null;
}

/**
 * 从 MCP 配置对象解析出要写进工作区的 server 配置。
 *
 * TIPS: 是否分流取决于插件来源。组织云端插件的远程 MCP 由 JuggleWork Connect 网关承载，
 * 再写一份本地副本会把组织统一的凭据摊给每台机器，也会和会话列表的去重语义冲突；而
 * GitHub Claude bundle 没有任何网关兜底，它的远程 MCP 必须落到本地配置才能用。
 *
 * @param object MCP 配置对象
 * @param namespace 插件命名空间
 * @param cloudGatewayHosted 远程组件是否由云端网关承载（组织云端插件为 true）
 * @returns 需落盘的 server 配置，以及被判为云端承载而跳过的数量
 */
function pluginMcpConfigsFromPayload(
  object: CloudPluginConfigObject,
  namespace: string,
  cloudGatewayHosted: boolean,
) {
  const version = object.latestVersion;
  const payload = version?.normalizedPayloadJson ?? parseJsonRecord(version?.rawSourceText ?? null);
  if (!payload) return { configs: [], cloudHostedNames: [] };

  const configs: Array<{ name: string; config: Record<string, unknown>; path: string }> = [];
  // 云端承载的独立 server 不落盘，但每个 server 仍需单独进入组件账本。
  const cloudHostedNames: string[] = [];
  const addConfig = (rawName: string, rawConfig: unknown, namespaceName: boolean) => {
    const config = normalizePluginMcpConfig(rawConfig);
    if (!config) return;
    const name = pluginMcpName(rawName, namespace, object.id, namespaceName);
    // TIPS: 只有 stdio 组件需要落到本工作区配置——远程 MCP 由云端网关承载，
    // 再写一份本地副本会让组织统一的凭据退化成各机器各自持有，也会和会话列表里的
    // 去重语义打架（同一个能力出现两条）。
    if (cloudGatewayHosted && config.type !== "local") {
      cloudHostedNames.push(name);
      return;
    }
    configs.push({
      name,
      config,
      path: `${OPENCODE_MCP_IMPORT_PATH_PREFIX}${name}`,
    });
  };

  if (isRecord(payload.mcp)) {
    for (const [name, config] of Object.entries(payload.mcp)) addConfig(name, config, false);
  }
  if (isRecord(payload.mcpServers)) {
    for (const [name, config] of Object.entries(payload.mcpServers)) addConfig(name, config, false);
  }
  if (configs.length === 0 && cloudHostedNames.length === 0) addConfig(object.title, payload, true);

  return { configs, cloudHostedNames: [...new Set(cloudHostedNames)].sort() };
}

function mcpNoConfigWarning(title: string): string {
  return `MCP component "${title}" could not be installed: no server config with a "url" or "command" was found.`;
}

function mcpInactiveWarning(title: string): string {
  return `MCP component "${title}" could not be installed because it is not active.`;
}

function readCloudImports(config: Record<string, unknown>): WorkspaceCloudImports {
  const root = isRecord(config.cloudImports) ? config.cloudImports : {};
  const marketplaces = isRecord(root.marketplaces) ? Object.fromEntries(Object.entries(root.marketplaces).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const marketplaceId = readString(value.marketplaceId) ?? key.trim();
    const name = readString(value.name) ?? marketplaceId;
    if (!marketplaceId || !name) return [];
    return [[marketplaceId, {
      marketplaceId,
      name,
      updatedAt: readString(value.updatedAt),
      pluginIds: readStringArray(value.pluginIds),
      importedAt: typeof value.importedAt === "number" && Number.isFinite(value.importedAt) ? value.importedAt : null,
    }]];
  })) : {};
  const plugins = isRecord(root.plugins) ? Object.fromEntries(Object.entries(root.plugins).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const pluginId = readString(value.pluginId) ?? key.trim();
    const name = readString(value.name) ?? pluginId;
    if (!pluginId || !name) return [];
    const files = Array.isArray(value.files) ? value.files.flatMap((file) => {
      if (!isRecord(file)) return [];
      const configObjectId = readString(file.configObjectId);
      const objectType = readString(file.objectType);
      const title = readString(file.title) ?? configObjectId;
      const path = readString(file.path);
      if (!configObjectId || !objectType || !title || !path) return [];
      return [{
        configObjectId,
        ...(readString(file.componentKey) ? { componentKey: readString(file.componentKey)! } : {}),
        ...(readString(file.serverName) ? { serverName: readString(file.serverName)! } : {}),
        versionId: readString(file.versionId),
        objectType,
        title,
        path,
        updatedAt: readString(file.updatedAt),
        ...(readDelivery(file.delivery) ? { delivery: readDelivery(file.delivery) } : {}),
        ...(readOutcome(file.outcome) ? { outcome: readOutcome(file.outcome) } : {}),
        ...(readString(file.ownerPluginId) ? { ownerPluginId: readString(file.ownerPluginId)! } : {}),
        ...(readString(file.ownerConfigObjectId) ? { ownerConfigObjectId: readString(file.ownerConfigObjectId)! } : {}),
        ...(readString(file.digest) ? { digest: readString(file.digest) } : {}),
        ...(readString(file.errorCode) ? { errorCode: readString(file.errorCode) } : {}),
        ...(readString(file.errorMessage) ? { errorMessage: readString(file.errorMessage) } : {}),
      }];
    }) : [];
    return [[pluginId, {
      pluginId,
      marketplaceId: readString(value.marketplaceId),
      name,
      description: readString(value.description),
      updatedAt: readString(value.updatedAt),
      files,
      importedAt: typeof value.importedAt === "number" && Number.isFinite(value.importedAt) ? value.importedAt : null,
      ...(readString(value.resolvedRevision) ? { resolvedRevision: readString(value.resolvedRevision)! } : {}),
      ...(readOperationStatus(value.status) ? { status: readOperationStatus(value.status) } : {}),
      ...(readRepairDetails(value.repair) ? { repair: readRepairDetails(value.repair) } : {}),
    }]];
  })) : {};
  return {
    skills: isRecord(root.skills) ? root.skills : {},
    providers: isRecord(root.providers) ? root.providers : {},
    marketplaces,
    plugins,
  };
}

async function openCloudPluginDb(path: string): Promise<CloudPluginDb> {
  const runtimeDb = await openRuntimeSqliteDatabase(path);
  if (runtimeDb.kind === "bun") {
    const sqlite = runtimeDb.sqlite;
    sqlite.run("CREATE TABLE IF NOT EXISTS cloud_plugin_install_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    const db = runtimeDb.db;
    return {
      get: (workspaceId) => db
        .select()
        .from(cloudPluginInstallConfigs)
        .where(eq(cloudPluginInstallConfigs.workspaceId, workspaceId))
        .get(),
      upsert: ({ workspaceId, configJson, updatedAt }) => {
        db
          .insert(cloudPluginInstallConfigs)
          .values({ workspaceId, configJson, updatedAt })
          .onConflictDoUpdate({
            target: cloudPluginInstallConfigs.workspaceId,
            set: { configJson, updatedAt },
          })
          .run();
      },
    };
  }
  const sqlite = runtimeDb.sqlite;
  sqlite.exec("CREATE TABLE IF NOT EXISTS cloud_plugin_install_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const get = sqlite.prepare("SELECT config_json AS configJson FROM cloud_plugin_install_configs WHERE workspace_id = ?");
  const upsert = sqlite.prepare("INSERT INTO cloud_plugin_install_configs (workspace_id, config_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at");
  return {
    get: (workspaceId) => {
      const row = get.get(workspaceId);
      if (!isRecord(row) || typeof row.configJson !== "string") return undefined;
      return { configJson: row.configJson };
    },
    upsert: ({ workspaceId, configJson, updatedAt }) => {
      upsert.run(workspaceId, configJson, updatedAt);
    },
  };
}

const dbByPath = new Map<string, Promise<CloudPluginDb>>();
const workspaceMutationTails = new Map<string, Promise<void>>();

async function cloudPluginDb(config: ServerConfig): Promise<CloudPluginDb> {
  const path = runtimeDbPath(config);
  const existing = dbByPath.get(path);
  if (existing) return existing;
  const db = openCloudPluginDb(path);
  dbByPath.set(path, db);
  return db;
}

/**
 * 串行执行同一运行时数据库、同一工作区的插件变更。
 *
 * TIPS：锁覆盖快照读取、文件/配置/账本写入、引擎同步和补偿回滚的完整生命周期，
 * 否则第二个操作仍可能读取旧快照并在稍后覆盖第一个操作的结果。
 *
 * @param config 服务端配置
 * @param workspaceId 工作区 ID
 * @param mutation 需要串行执行的插件变更
 * @returns 变更结果
 */
async function serializeWorkspacePluginMutation<T>(
  config: ServerConfig,
  workspaceId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const key = `${runtimeDbPath(config)}\0${workspaceId}`;
  const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceMutationTails.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await mutation();
  } finally {
    release();
    if (workspaceMutationTails.get(key) === current) workspaceMutationTails.delete(key);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runRollbackStep(
  failures: CloudPluginRollbackFailure[],
  stage: string,
  action: () => Promise<void>,
  injectedStage?: string,
): Promise<void> {
  try {
    if (injectedStage === stage) throw new Error(`Injected cloud plugin ${stage} rollback failure`);
    await action();
  } catch (error) {
    failures.push({ stage, message: errorMessage(error) });
  }
}

function engineMutationForSnapshot(
  affectedNames: string[],
  runtimeMcps: Record<string, Record<string, unknown>>,
): CloudPluginEngineMutation {
  return {
    upsertNames: affectedNames.filter((name) => runtimeMcps[name] !== undefined),
    removeNames: affectedNames.filter((name) => runtimeMcps[name] === undefined),
  };
}

const CLOUD_PLUGIN_REFRESH_HINTS = [
  "cloudPlugins",
  "marketplace",
  "skills",
  "mcp",
  "commands",
  "agents",
  "sessionCapabilities",
] as const;

function emptyCloudPluginMutations(): CloudPluginMutations {
  return {
    filesWritten: [],
    filesRemoved: [],
    mcpUpserted: [],
    mcpRemoved: [],
    installationRecordChanged: false,
    engineSynchronized: false,
  };
}

function sameStableValue(left: unknown, right: unknown): boolean {
  return digestValue(left) === digestValue(right);
}

async function restoreAffectedRuntimeMcps(
  config: ServerConfig,
  workspaceId: string,
  affectedNames: string[],
  snapshot: Record<string, Record<string, unknown>>,
): Promise<void> {
  if (affectedNames.length === 0) return;
  await writeRuntimeOpencodeConfig(config, workspaceId, (current) => {
    const mcp = { ...runtimeMcpMap(current) };
    for (const name of affectedNames) {
      const previous = snapshot[name];
      if (previous === undefined) delete mcp[name];
      else mcp[name] = previous;
    }
    if (Object.keys(mcp).length > 0) return { ...current, mcp };
    const { mcp: _mcp, ...withoutMcp } = current;
    return withoutMcp;
  });
}

export async function readInstalledCloudPlugins(config: ServerConfig, workspaceId: string): Promise<WorkspaceCloudImports> {
  const db = await cloudPluginDb(config);
  const row = db.get(workspaceId);
  if (!row) return readCloudImports({});
  try {
    return readCloudImports({ cloudImports: JSON.parse(row.configJson) });
  } catch {
    return readCloudImports({});
  }
}

async function writeInstalledCloudPlugins(
  config: ServerConfig,
  workspaceId: string,
  updater: (current: WorkspaceCloudImports) => WorkspaceCloudImports,
): Promise<WorkspaceCloudImports> {
  const db = await cloudPluginDb(config);
  const next = updater(await readInstalledCloudPlugins(config, workspaceId));
  db.upsert({ workspaceId, configJson: JSON.stringify(next), updatedAt: Date.now() });
  return next;
}

function resolveWorkspaceInstallPath(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.trim().replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!normalized.startsWith(".opencode/") || parts.some((part) => part === "." || part === "..")) {
    throw new ApiError(400, "invalid_cloud_plugin_path", `Invalid cloud plugin path: ${relativePath}`);
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, normalized);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new ApiError(400, "invalid_cloud_plugin_path", `Invalid cloud plugin path: ${relativePath}`);
  }
  return candidate;
}

async function resolveSafeWorkspaceInstallPath(workspaceRoot: string, relativePath: string): Promise<string> {
  const absolutePath = resolveWorkspaceInstallPath(workspaceRoot, relativePath);
  const root = resolve(workspaceRoot);
  const pathParts = relative(root, absolutePath).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < pathParts.length; index += 1) {
    current = join(current, pathParts[index]!);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || (index < pathParts.length - 1 && !stats.isDirectory())) {
        throw new ApiError(400, "invalid_cloud_plugin_path", `Cloud plugin path traverses an unsafe filesystem entry: ${relativePath}`);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") break;
      throw error;
    }
  }
  return absolutePath;
}

async function removeEmptyPluginDirectories(workspaceRoot: string, absolutePath: string): Promise<void> {
  const stop = resolve(workspaceRoot, ".opencode");
  let current = dirname(absolutePath);
  while (current !== stop && current.startsWith(`${stop}${sep}`)) {
    const relativePath = relative(resolve(workspaceRoot), current).split(sep).join("/");
    await resolveSafeWorkspaceInstallPath(workspaceRoot, relativePath);
    try {
      await rmdir(current);
    } catch (error) {
      if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST")) return;
      throw error;
    }
    current = dirname(current);
  }
}

async function writePluginWorkspaceFile(workspaceRoot: string, path: string, content: string): Promise<void> {
  const absolutePath = await resolveSafeWorkspaceInstallPath(workspaceRoot, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await resolveSafeWorkspaceInstallPath(workspaceRoot, path);
  const temporaryPath = `${absolutePath}.jugglework-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporaryPath, content.endsWith("\n") ? content : `${content}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, absolutePath).catch(async (error) => {
    await rm(temporaryPath, { force: true });
    throw error;
  });
}

async function removePluginWorkspaceFile(workspaceRoot: string, path: string): Promise<void> {
  if (!path.startsWith(".opencode/")) return;
  const absolutePath = await resolveSafeWorkspaceInstallPath(workspaceRoot, path);
  try {
    await unlink(absolutePath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  await removeEmptyPluginDirectories(workspaceRoot, absolutePath);
}

function cloudPluginMcpNameFromPath(path: string): string | null {
  if (!path.startsWith(OPENCODE_MCP_IMPORT_PATH_PREFIX)) return null;
  const name = path.slice(OPENCODE_MCP_IMPORT_PATH_PREFIX.length).trim();
  return OPENCODE_MCP_NAME_RE.test(name) ? name : null;
}

function localFileLedger(input: {
  pluginId: string;
  object: CloudPluginConfigObject;
  path: string;
  content: string;
}): CloudImportedPluginFile {
  return {
    configObjectId: input.object.id,
    componentKey: input.object.id,
    versionId: input.object.latestVersion?.id ?? null,
    objectType: input.object.objectType,
    title: input.object.title,
    path: input.path,
    updatedAt: input.object.updatedAt,
    delivery: "local_file",
    outcome: "installed_local",
    ownerPluginId: input.pluginId,
    ownerConfigObjectId: input.object.id,
    digest: digestValue(input.content.endsWith("\n") ? input.content : `${input.content}\n`),
  };
}

function mcpLedger(input: {
  pluginId: string;
  object: CloudPluginConfigObject;
  name: string;
  sourceServerName?: string;
  config: Record<string, unknown>;
}): CloudImportedPluginFile {
  return {
    configObjectId: input.object.id,
    componentKey: `${input.object.id}:${input.sourceServerName ?? input.name}`,
    serverName: input.sourceServerName ?? input.name,
    versionId: input.object.latestVersion?.id ?? null,
    objectType: input.object.objectType,
    title: input.object.title,
    path: `${OPENCODE_MCP_IMPORT_PATH_PREFIX}${input.name}`,
    updatedAt: input.object.updatedAt,
    delivery: "runtime_mcp",
    outcome: "installed_local",
    ownerPluginId: input.pluginId,
    ownerConfigObjectId: input.object.id,
    digest: mcpOwnershipDigest(input.config),
  };
}

function outcomeLedger(input: {
  pluginId: string;
  membership: CloudPluginMembership;
  outcome: NonNullable<CloudImportedPluginFile["outcome"]>;
  errorCode?: string;
  errorMessage?: string;
  serverName?: string;
}): CloudImportedPluginFile {
  const object = input.membership.configObject;
  const componentId = object?.id ?? input.membership.configObjectId;
  return {
    configObjectId: componentId,
    componentKey: input.serverName ? `${componentId}:${input.serverName}` : componentId,
    ...(input.serverName ? { serverName: input.serverName } : {}),
    versionId: object?.latestVersion?.id ?? null,
    objectType: object?.objectType ?? "custom",
    title: object?.title ?? input.membership.configObjectId,
    path: input.serverName ? `cloud://${componentId}/${encodeURIComponent(input.serverName)}` : `cloud://${componentId}`,
    updatedAt: object?.updatedAt ?? null,
    delivery: "cloud",
    outcome: input.outcome,
    ownerPluginId: input.pluginId,
    ownerConfigObjectId: object?.id ?? input.membership.configObjectId,
    digest: object?.latestVersion ? digestValue(object.latestVersion) : null,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
  };
}

function cloudOutcomeForComponent(
  resolved: CloudPluginResolved,
  configObjectId: string,
  serverName?: string,
): Pick<CloudImportedPluginFile, "outcome" | "errorCode" | "errorMessage"> {
  const readiness = resolved.plugin.cloudReadiness;
  const components = readiness?.components.filter((component) =>
    component.configObjectId === configObjectId
    && component.delivery === "cloud"
    && (!serverName || !component.serverName || component.serverName === serverName)
  ) ?? [];
  if (components.some((component) => !component.connectedForMe && !component.connectionId)) {
    return {
      outcome: "needs_admin_setup",
      errorCode: "cloud_needs_admin_setup",
      errorMessage: "An organization administrator must configure this Cloud component.",
    };
  }
  if (components.some((component) => !component.connectedForMe && Boolean(component.connectionId))) {
    return {
      outcome: "needs_signin",
      errorCode: "cloud_needs_signin",
      errorMessage: "Sign in to use this Cloud component.",
    };
  }
  if (components.length > 0) return { outcome: "available_cloud" };
  if (readiness?.state === "needs_admin_setup") {
    return {
      outcome: "needs_admin_setup",
      errorCode: "cloud_needs_admin_setup",
      errorMessage: "An organization administrator must configure this Cloud component.",
    };
  }
  if (readiness?.state === "needs_signin") {
    return {
      outcome: "needs_signin",
      errorCode: "cloud_needs_signin",
      errorMessage: "Sign in to use this Cloud component.",
    };
  }
  return { outcome: "available_cloud" };
}

function ledgerOwns(entry: CloudImportedPluginFile, pluginId: string): boolean {
  return entry.ownerPluginId === pluginId && entry.ownerConfigObjectId === entry.configObjectId;
}

function isSameOwnedMcp(
  entry: CloudImportedPluginFile | undefined,
  pluginId: string,
  configObjectId: string,
  currentConfig: Record<string, unknown>,
): boolean {
  if (!entry || !ledgerOwns(entry, pluginId) || entry.configObjectId !== configObjectId) return false;
  return Boolean(entry.digest) && entry.digest === mcpOwnershipDigest(currentConfig);
}

/**
 * 为一个工作区插件构建稳定、无副作用的投递计划。
 *
 * TIPS：所有集合按资源键排序，冲突在写入前一次性收集；这样同一插件图重复执行会得到
 * 相同计划，也不会先覆盖用户资源再发现后续冲突。
 *
 * @param input 插件图、已有账本和当前运行时 MCP 快照
 * @returns 文件、MCP、Cloud outcome、清理项及冲突组成的确定性计划
 */
export function buildCloudPluginDeliveryPlan(input: {
  resolved: CloudPluginResolved;
  existing?: CloudImportedPlugin;
  runtimeMcps: Record<string, Record<string, unknown>>;
  cloudGatewayHosted?: boolean;
}): CloudPluginDeliveryPlan {
  const pluginId = input.resolved.plugin.id;
  const namespace = pluginNamespace(input.resolved.plugin.name, pluginId);
  let fileWrites: CloudPluginFileWrite[] = [];
  const mcpUpserts: CloudPluginMcpUpsert[] = [];
  const mcpCandidates: CloudPluginMcpUpsert[] = [];
  let outcomes: CloudImportedPluginFile[] = [];
  const warnings: string[] = [];
  const conflicts: CloudPluginConflict[] = [];
  const failedComponentIds = new Set<string>();
  const previousByPath = new Map((input.existing?.files ?? []).map((entry) => [entry.path, entry]));

  for (const membership of [...input.resolved.memberships].sort((a, b) => a.configObjectId.localeCompare(b.configObjectId))) {
    const object = membership.configObject;
    if (!object) {
      failedComponentIds.add(membership.configObjectId);
      outcomes.push(outcomeLedger({ pluginId, membership, outcome: "failed", errorCode: "component_missing", errorMessage: "Component details are unavailable." }));
      continue;
    }
    if (object.status !== "active") {
      failedComponentIds.add(object.id);
      const message = object.objectType === "mcp" ? mcpInactiveWarning(object.title) : `Component "${object.title}" is not active.`;
      warnings.push(message);
      outcomes.push(outcomeLedger({ pluginId, membership, outcome: "unsupported", errorCode: "component_inactive", errorMessage: message }));
      continue;
    }
    if (object.objectType === "mcp") {
      const parsed = pluginMcpConfigsFromPayload(object, namespace, input.cloudGatewayHosted === true);
      if (parsed.configs.length === 0 && parsed.cloudHostedNames.length === 0) {
        failedComponentIds.add(object.id);
        const message = mcpNoConfigWarning(object.title);
        warnings.push(message);
        outcomes.push(outcomeLedger({ pluginId, membership, outcome: "failed", errorCode: "mcp_config_missing", errorMessage: message }));
      }
      for (const serverName of parsed.cloudHostedNames) {
        const cloudOutcome = cloudOutcomeForComponent(input.resolved, object.id, serverName);
        outcomes.push(outcomeLedger({
          pluginId,
          membership,
          serverName,
          outcome: cloudOutcome.outcome!,
          ...(cloudOutcome.errorCode ? { errorCode: cloudOutcome.errorCode } : {}),
          ...(cloudOutcome.errorMessage ? { errorMessage: cloudOutcome.errorMessage } : {}),
        }));
      }
      for (const config of parsed.configs) {
        const name = pluginMcpName(config.name, namespace, object.id, true);
        const ledger = mcpLedger({ pluginId, object, name, sourceServerName: config.name, config: config.config });
        mcpCandidates.push({ name, config: config.config, ledger });
      }
      continue;
    }
    if (object.latestVersion?.rawSourceText == null) {
      failedComponentIds.add(object.id);
      outcomes.push(outcomeLedger({ pluginId, membership, outcome: "failed", errorCode: "component_payload_missing", errorMessage: "Component payload is unavailable." }));
      continue;
    }
    const path = getPluginObjectInstallPath(object, namespace);
    let content = object.latestVersion.rawSourceText;
    if (object.objectType === "skill") {
      const installName = path.match(/^\.opencode\/skills\/[^/]+\/([^/]+)\/SKILL\.md$/)?.[1] ?? slugifyConfigObjectName(object.title, object.id);
      content = buildCloudSkillContent(installName, cloudConfigObjectDescription(object) || "Skill", extractSkillBodyMarkdown(content));
    } else if (object.objectType === "agent") {
      content = buildCloudAgentContent(cloudConfigObjectDescription(object), content);
    } else if (object.objectType === "command") {
      const fileName = path.match(/\/([^/]+)\.md$/)?.[1] ?? object.title;
      content = buildCloudCommandContent(slugifyConfigObjectName(fileName, object.id), cloudConfigObjectDescription(object), content);
    }
    const ledger = localFileLedger({ pluginId, object, path, content });
    fileWrites.push({ path, content, ledger });
    outcomes.push(ledger);
  }

  // TIPS：目的地冲突必须基于完整投递图一次性判定。不能在遍历时用 Map 或顺序写入取最后一个，
  // 否则结果取决于成员顺序，账本还会让同一资源出现两个所有者。
  const duplicateFilePaths = new Set<string>();
  const fileWritesByPath = new Map<string, CloudPluginFileWrite[]>();
  const fileCollisionKey = (path: string) => process.platform === "win32" || process.platform === "darwin" ? path.toLocaleLowerCase("en-US") : path;
  for (const write of fileWrites) {
    const key = fileCollisionKey(write.path);
    fileWritesByPath.set(key, [...(fileWritesByPath.get(key) ?? []), write]);
  }
  for (const [, writes] of [...fileWritesByPath].sort(([a], [b]) => a.localeCompare(b))) {
    if (writes.length < 2) continue;
    const paths = [...new Set(writes.map((write) => write.path))].sort();
    for (const path of paths) duplicateFilePaths.add(path);
    const path = paths[0]!;
    const configObjectIds = [...new Set(writes.map((write) => write.ledger.configObjectId))].sort();
    const message = `File destination "${path}" is declared by multiple plugin components: ${configObjectIds.join(", ")}.`;
    conflicts.push({ code: "file_ownership_conflict", configObjectId: configObjectIds[0]!, resource: path, message });
    for (const configObjectId of configObjectIds) {
      failedComponentIds.add(configObjectId);
      const membership = input.resolved.memberships.find((entry) => entry.configObjectId === configObjectId)!;
      outcomes.push(outcomeLedger({ pluginId, membership, outcome: "failed", errorCode: "duplicate_file_destination", errorMessage: message }));
    }
  }
  if (duplicateFilePaths.size > 0) {
    fileWrites = fileWrites.filter((write) => !duplicateFilePaths.has(write.path));
    outcomes = outcomes.filter((entry) => entry.delivery !== "local_file" || !duplicateFilePaths.has(entry.path));
  }

  const duplicateMcpNames = new Set<string>();
  const mcpCandidatesByName = new Map<string, CloudPluginMcpUpsert[]>();
  for (const candidate of mcpCandidates) {
    mcpCandidatesByName.set(candidate.name, [...(mcpCandidatesByName.get(candidate.name) ?? []), candidate]);
  }
  for (const [name, candidates] of [...mcpCandidatesByName].sort(([a], [b]) => a.localeCompare(b))) {
    if (candidates.length < 2) continue;
    duplicateMcpNames.add(name);
    const configObjectIds = [...new Set(candidates.map((candidate) => candidate.ledger.configObjectId))].sort();
    const message = `MCP destination "${name}" is declared by multiple plugin components: ${configObjectIds.join(", ")}.`;
    conflicts.push({ code: "mcp_ownership_conflict", configObjectId: configObjectIds[0]!, resource: name, message });
    for (const configObjectId of configObjectIds) {
      failedComponentIds.add(configObjectId);
      const membership = input.resolved.memberships.find((entry) => entry.configObjectId === configObjectId)!;
      outcomes.push(outcomeLedger({ pluginId, membership, outcome: "failed", errorCode: "duplicate_mcp_destination", errorMessage: message }));
    }
  }

  for (const candidate of mcpCandidates) {
    if (duplicateMcpNames.has(candidate.name)) continue;
    const current = input.runtimeMcps[candidate.name];
    const previous = previousByPath.get(candidate.ledger.path);
    if (current && !isSameOwnedMcp(previous, pluginId, candidate.ledger.configObjectId, current)) {
      conflicts.push({
        code: "mcp_ownership_conflict",
        configObjectId: candidate.ledger.configObjectId,
        resource: candidate.name,
        message: `MCP "${candidate.name}" already exists and is not owned by plugin "${input.resolved.plugin.name}".`,
      });
      continue;
    }
    const effectiveConfig = current && typeof current.enabled === "boolean"
      ? { ...candidate.config, enabled: current.enabled }
      : candidate.config;
    const ledger = { ...candidate.ledger, digest: mcpOwnershipDigest(effectiveConfig) };
    mcpUpserts.push({ name: candidate.name, config: effectiveConfig, ledger });
    outcomes.push(ledger);
  }

  // TIPS：解析失败不代表上游删除了组件。保留此前可工作的本地投递，直到拿到有效替代品。
  for (const previous of input.existing?.files ?? []) {
    if (previous.delivery !== "cloud" && failedComponentIds.has(previous.configObjectId)) outcomes.push(previous);
  }

  const nextPaths = new Set(outcomes.filter((entry) => entry.delivery !== "cloud").map((entry) => entry.path));
  const obsolete = (input.existing?.files ?? []).filter((entry) => entry.delivery !== "cloud" && !nextPaths.has(entry.path));
  const fileRemovals = obsolete.filter((entry) => !cloudPluginMcpNameFromPath(entry.path)).map((entry) => entry.path);
  const mcpRemovals = obsolete.flatMap((entry) => {
    const name = cloudPluginMcpNameFromPath(entry.path);
    if (!name) return [];
    const current = input.runtimeMcps[name];
    if (!current) return [];
    if (isSameOwnedMcp(entry, pluginId, entry.configObjectId, current)) return [name];
    conflicts.push({
      code: "mcp_ownership_conflict",
      configObjectId: entry.configObjectId,
      resource: name,
      message: `MCP "${name}" has uncertain or modified ownership and will not be removed.`,
    });
    return [];
  });
  const sortByPath = <T extends { path: string }>(a: T, b: T) => a.path.localeCompare(b.path);
  fileWrites.sort(sortByPath);
  mcpUpserts.sort((a, b) => a.name.localeCompare(b.name));
  outcomes.sort(sortByPath);
  warnings.sort();
  conflicts.sort((a, b) => a.resource.localeCompare(b.resource));
  return {
    fileWrites,
    fileRemovals: [...new Set(fileRemovals)].sort(),
    mcpUpserts,
    mcpRemovals: [...new Set(mcpRemovals)].sort(),
    outcomes,
    warnings,
    conflicts,
  };
}

async function installCloudPluginLocked(input: CloudPluginInstallInput): Promise<CloudPluginInstallResult> {
  const cloudImports = await readInstalledCloudPlugins(input.serverConfig, input.workspaceId);
  const existing = cloudImports.plugins[input.resolved.plugin.id];
  const operation: CloudPluginInstallResult["operation"] = existing ? "sync" : "install";
  const runtimeBefore = await readRuntimeOpencodeConfig(input.serverConfig, input.workspaceId);
  const plan = buildCloudPluginDeliveryPlan({
    resolved: input.resolved,
    existing,
    runtimeMcps: runtimeMcpMap(runtimeBefore),
    cloudGatewayHosted: input.cloudGatewayHosted,
  });

  // 已有账本的文件若被成员修改，不再静默覆盖或删除。
  const previousByPath = new Map((existing?.files ?? []).map((entry) => [entry.path, entry]));
  const actualFileContent = new Map<string, string | null>();
  for (const path of [...plan.fileWrites.map((entry) => entry.path), ...plan.fileRemovals]) {
    const previous = previousByPath.get(path);
    try {
      const current = await readFile(await resolveSafeWorkspaceInstallPath(input.workspaceRoot, path), "utf8");
      actualFileContent.set(path, current);
      if (!previous || !ledgerOwns(previous, input.resolved.plugin.id) || !previous.digest || digestValue(current) !== previous.digest) {
        plan.conflicts.push({
          code: "file_ownership_conflict",
          configObjectId: previous?.configObjectId ?? plan.fileWrites.find((entry) => entry.path === path)?.ledger.configObjectId ?? "unknown",
          resource: path,
          message: previous
            ? `File "${path}" has uncertain or modified ownership and will not be overwritten or removed.`
            : `File "${path}" already exists and is not owned by plugin "${input.resolved.plugin.name}".`,
        });
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      actualFileContent.set(path, null);
    }
  }
  plan.conflicts.sort((a, b) => a.resource.localeCompare(b.resource));

  const failedOutcomes = plan.outcomes.filter((entry) => entry.outcome === "failed" || entry.outcome === "unsupported");
  const readinessOutcomes = plan.outcomes.filter((entry) => entry.outcome === "needs_signin" || entry.outcome === "needs_admin_setup");
  const initialStatus: CloudPluginOperationStatus = plan.conflicts.length > 0
    ? "failed"
    : failedOutcomes.length > 0
      ? (plan.outcomes.some((entry) => entry.outcome === "installed_local" || entry.outcome === "available_cloud") ? "partial" : "failed")
      : readinessOutcomes.length > 0 ? "partial" : "installed";
  const imported: CloudImportedPlugin = {
    pluginId: input.resolved.plugin.id,
    marketplaceId: input.marketplaceId,
    name: input.resolved.plugin.name,
    description: input.resolved.plugin.description,
    updatedAt: input.resolved.plugin.updatedAt,
    files: plan.outcomes,
    importedAt: existing?.importedAt ?? Date.now(),
    resolvedRevision: resolveCloudPluginRevision(input.resolved),
    status: initialStatus,
  };

  if (plan.conflicts.length > 0) {
    return {
      item: imported,
      changed: false,
      current: existing ?? null,
      operation,
      mutations: emptyCloudPluginMutations(),
      refreshHints: [],
      warnings: plan.warnings,
      status: "failed",
      outcomes: plan.outcomes,
      conflicts: plan.conflicts,
      cause: "Plugin resources conflict with existing or modified workspace resources.",
      rollbackFailures: [],
    };
  }

  const nextPlugins = {
    ...cloudImports.plugins,
    [input.resolved.plugin.id]: imported,
  };

  let nextMarketplaces = cloudImports.marketplaces;
  if (input.marketplaceId) {
    const existingMarketplace = cloudImports.marketplaces[input.marketplaceId];
    const pluginIds = new Set(existingMarketplace?.pluginIds ?? []);
    pluginIds.add(input.resolved.plugin.id);
    nextMarketplaces = {
      ...cloudImports.marketplaces,
      [input.marketplaceId]: {
        marketplaceId: input.marketplaceId,
        name: input.marketplace?.name ?? existingMarketplace?.name ?? input.marketplaceId,
        updatedAt: input.marketplace?.updatedAt ?? existingMarketplace?.updatedAt ?? null,
        pluginIds: [...pluginIds].sort(),
        importedAt: existingMarketplace?.importedAt ?? Date.now(),
      },
    };
  }

  // TIPS：所有权校验完成后才允许把计划收缩成实际变更。仅比较版本号会漏掉成员编辑，
  // 仅比较账本会漏掉文件丢失；这里同时比较实际文件内容和含成员 enabled 偏好的 MCP 配置。
  plan.fileWrites = plan.fileWrites.filter((write) => {
    const current = actualFileContent.get(write.path);
    return current === null || current === undefined || digestValue(current) !== write.ledger.digest;
  });
  plan.fileRemovals = plan.fileRemovals.filter((path) => actualFileContent.get(path) !== null);
  plan.mcpUpserts = plan.mcpUpserts.filter((upsert) => !sameStableValue(runtimeMcpMap(runtimeBefore)[upsert.name], upsert.config));

  const affectedPaths = [...new Set([...plan.fileWrites.map((entry) => entry.path), ...plan.fileRemovals])];
  const affectedMcpNames = [...new Set([...plan.mcpUpserts.map((entry) => entry.name), ...plan.mcpRemovals])].sort();
  const nextCloudImports: WorkspaceCloudImports = {
    ...cloudImports,
    marketplaces: nextMarketplaces,
    plugins: nextPlugins,
  };
  const installationRecordChanged = !sameStableValue(cloudImports, nextCloudImports);
  const changed = affectedPaths.length > 0 || affectedMcpNames.length > 0 || installationRecordChanged;
  const mutations: CloudPluginMutations = {
    filesWritten: plan.fileWrites.map((entry) => entry.path),
    filesRemoved: plan.fileRemovals,
    mcpUpserted: plan.mcpUpserts.map((entry) => entry.name),
    mcpRemoved: plan.mcpRemovals,
    installationRecordChanged,
    engineSynchronized: false,
  };
  if (!changed) {
    return {
      item: existing!,
      changed: false,
      current: existing!,
      operation,
      mutations,
      refreshHints: [],
      warnings: plan.warnings,
      status: initialStatus,
      outcomes: plan.outcomes,
      conflicts: [],
    };
  }
  const fileSnapshots = new Map<string, string | null>();
  let engineMutationAttempted = false;
  for (const path of affectedPaths) {
    try {
      fileSnapshots.set(path, await readFile(await resolveSafeWorkspaceInstallPath(input.workspaceRoot, path), "utf8"));
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") fileSnapshots.set(path, null);
      else throw error;
    }
  }

  try {
    for (const write of plan.fileWrites) await writePluginWorkspaceFile(input.workspaceRoot, write.path, write.content);
    for (const path of plan.fileRemovals) await removePluginWorkspaceFile(input.workspaceRoot, path);
    if (input.failAfterStage === "files") throw new Error("Injected cloud plugin file stage failure");

    if (plan.mcpRemovals.length > 0 || plan.mcpUpserts.length > 0) {
      await writeRuntimeOpencodeConfig(input.serverConfig, input.workspaceId, (current) => {
        const mcp = { ...runtimeMcpMap(current) };
        for (const name of plan.mcpRemovals) delete mcp[name];
        for (const upsert of plan.mcpUpserts) mcp[upsert.name] = upsert.config;
        return { ...current, mcp };
      });
    }
    if (input.failAfterStage === "mcp") throw new Error("Injected cloud plugin MCP stage failure");

    if (installationRecordChanged) {
      await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, () => nextCloudImports);
    }
    if (input.failAfterStage === "record") throw new Error("Injected cloud plugin record stage failure");

    if (input.synchronizeEngine && affectedMcpNames.length > 0) {
      engineMutationAttempted = true;
      await input.synchronizeEngine({
        upsertNames: plan.mcpUpserts.map((entry) => entry.name),
        removeNames: plan.mcpRemovals,
      });
      mutations.engineSynchronized = true;
    }
    if (input.failAfterStage === "engine") throw new Error("Injected cloud plugin engine stage failure");
  } catch (error) {
    const rollbackFailures: CloudPluginRollbackFailure[] = [];
    for (const [path, content] of fileSnapshots) {
      await runRollbackStep(rollbackFailures, `files:${path}`, async () => {
        if (input.failRollbackStage === "files") throw new Error("Injected cloud plugin files rollback failure");
        if (content === null) await removePluginWorkspaceFile(input.workspaceRoot, path);
        else await writePluginWorkspaceFile(input.workspaceRoot, path, content);
      });
    }
    await runRollbackStep(rollbackFailures, "mcp", async () => {
      await restoreAffectedRuntimeMcps(
        input.serverConfig,
        input.workspaceId,
        affectedMcpNames,
        runtimeMcpMap(runtimeBefore),
      );
    }, input.failRollbackStage);
    await runRollbackStep(rollbackFailures, "record", async () => {
      await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, () => cloudImports);
    }, input.failRollbackStage);
    if (input.synchronizeEngine && engineMutationAttempted) {
      await runRollbackStep(rollbackFailures, "engine", async () => {
        await input.synchronizeEngine!(engineMutationForSnapshot(affectedMcpNames, runtimeMcpMap(runtimeBefore)));
      }, input.failRollbackStage);
    }

    if (rollbackFailures.length > 0) {
      const repair: CloudPluginRepairDetails = {
        operation,
        cause: errorMessage(error),
        conflicts: [],
        rollbackFailures,
        recordedAt: Date.now(),
      };
      // TIPS：回滚不完整时不能用“计划中的新账本”覆盖旧所有权；否则已经恢复的旧资源
      // 会失去归属。保留旧账本，只附加修复状态；首次安装则只记录仍可能残留的新资源。
      const repairItem: CloudImportedPlugin = existing
        ? { ...existing, status: "repair_required", repair }
        : { ...imported, status: "repair_required", repair };
      try {
        await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
          ...current,
          plugins: { ...current.plugins, [repairItem.pluginId]: repairItem },
        }));
      } catch (persistError) {
        rollbackFailures.push({ stage: "repair_record", message: errorMessage(persistError) });
      }
      throw new ApiError(500, "cloud_plugin_repair_required", "Plugin installation failed and rollback was incomplete.", {
        status: "repair_required",
        operation,
        current: repairItem,
        outcomes: plan.outcomes,
        cause: errorMessage(error),
        conflicts: [],
        rollbackFailures,
      });
    }
    throw new ApiError(500, "cloud_plugin_install_failed", "Plugin installation failed and the previous state was restored.", {
      status: "failed",
      operation,
      current: existing ?? null,
      outcomes: plan.outcomes,
      cause: errorMessage(error),
      conflicts: [],
      rollbackFailures: [],
    });
  }

  return {
    item: imported,
    changed: true,
    current: imported,
    operation,
    mutations,
    refreshHints: [...CLOUD_PLUGIN_REFRESH_HINTS],
    warnings: plan.warnings,
    status: initialStatus,
    outcomes: plan.outcomes,
    conflicts: [],
  };
}

/**
 * 安装或更新工作区插件，并在同一工作区内串行完成文件、配置、账本和引擎同步。
 *
 * @param input 插件投递上下文和实时引擎同步器
 * @returns 与实际持久化和引擎状态一致的安装结果
 */
export async function installCloudPlugin(input: CloudPluginInstallInput): Promise<CloudPluginInstallResult> {
  return serializeWorkspacePluginMutation(input.serverConfig, input.workspaceId, () => installCloudPluginLocked(input));
}

async function removeCloudPluginLocked(input: CloudPluginRemoveInput): Promise<CloudPluginRemoveResult> {
  const cloudImports = await readInstalledCloudPlugins(input.serverConfig, input.workspaceId);
  const imported = cloudImports.plugins[input.pluginId];
  if (!imported) throw new ApiError(404, "cloud_plugin_not_installed", "Marketplace package is not installed in this workspace.");

  const runtimeBefore = await readRuntimeOpencodeConfig(input.serverConfig, input.workspaceId);
  const runtimeMcps = runtimeMcpMap(runtimeBefore);
  const fileSnapshots = new Map<string, string>();
  const removableFiles: string[] = [];
  const removableMcps: string[] = [];
  const conflicts: CloudPluginConflict[] = [];
  let engineMutationAttempted = false;
  for (const file of imported.files) {
    if (file.delivery === "cloud") continue;
    const mcpName = cloudPluginMcpNameFromPath(file.path);
    if (mcpName) {
      const current = runtimeMcps[mcpName];
      if (!current) continue;
      if (isSameOwnedMcp(file, input.pluginId, file.configObjectId, current)) removableMcps.push(mcpName);
      else conflicts.push({
        code: "mcp_ownership_conflict",
        configObjectId: file.configObjectId,
        resource: mcpName,
        message: `MCP "${mcpName}" has uncertain or modified ownership and will not be removed.`,
      });
      continue;
    }
    try {
      const content = await readFile(await resolveSafeWorkspaceInstallPath(input.workspaceRoot, file.path), "utf8");
      if (ledgerOwns(file, input.pluginId) && file.digest && digestValue(content) === file.digest) {
        removableFiles.push(file.path);
        fileSnapshots.set(file.path, content);
      } else {
        conflicts.push({
          code: "file_ownership_conflict",
          configObjectId: file.configObjectId,
          resource: file.path,
          message: `File "${file.path}" has uncertain or modified ownership and will not be removed.`,
        });
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }

  if (conflicts.length > 0) {
    conflicts.sort((a, b) => a.resource.localeCompare(b.resource));
    const repairItem = {
      ...imported,
      status: "repair_required" as const,
      repair: {
        operation: "remove" as const,
        cause: "Plugin-owned resources were modified after installation.",
        conflicts,
        rollbackFailures: [],
        recordedAt: Date.now(),
      },
    };
    await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
      ...current,
      plugins: { ...current.plugins, [input.pluginId]: repairItem },
    }));
    throw new ApiError(409, "cloud_plugin_ownership_conflict", "Plugin removal requires repair because some resources have uncertain or modified ownership.", {
      status: "repair_required",
      operation: "remove",
      current: repairItem,
      conflicts,
      cause: repairItem.repair.cause,
      rollbackFailures: [],
    });
  }

  const nextPlugins = { ...cloudImports.plugins };
  delete nextPlugins[input.pluginId];
  const nextMarketplaces = Object.fromEntries(Object.entries(cloudImports.marketplaces).flatMap(([marketplaceId, marketplace]) => {
    const pluginIds = marketplace.pluginIds.filter((id) => id !== input.pluginId);
    if (pluginIds.length === 0) return [];
    return [[marketplaceId, { ...marketplace, pluginIds }]];
  }));

  try {
    for (const path of removableFiles) await removePluginWorkspaceFile(input.workspaceRoot, path);
    if (input.failAfterStage === "files") throw new Error("Injected cloud plugin removal file stage failure");
    if (removableMcps.length > 0) {
      await writeRuntimeOpencodeConfig(input.serverConfig, input.workspaceId, (current) => {
        const mcp = { ...runtimeMcpMap(current) };
        for (const name of removableMcps) delete mcp[name];
        if (Object.keys(mcp).length > 0) return { ...current, mcp };
        const { mcp: _mcp, ...withoutMcp } = current;
        return withoutMcp;
      });
    }
    if (input.failAfterStage === "mcp") throw new Error("Injected cloud plugin removal MCP stage failure");
    await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
      ...current,
      marketplaces: nextMarketplaces,
      plugins: nextPlugins,
    }));
    if (input.failAfterStage === "record") throw new Error("Injected cloud plugin removal record stage failure");
    if (input.synchronizeEngine && removableMcps.length > 0) {
      engineMutationAttempted = true;
      await input.synchronizeEngine({ upsertNames: [], removeNames: removableMcps });
    }
    if (input.failAfterStage === "engine") throw new Error("Injected cloud plugin removal engine stage failure");
  } catch (error) {
    const rollbackFailures: CloudPluginRollbackFailure[] = [];
    for (const [path, content] of fileSnapshots) {
      await runRollbackStep(rollbackFailures, `files:${path}`, async () => {
        if (input.failRollbackStage === "files") throw new Error("Injected cloud plugin removal files rollback failure");
        await writePluginWorkspaceFile(input.workspaceRoot, path, content);
      });
    }
    await runRollbackStep(rollbackFailures, "mcp", async () => {
      await restoreAffectedRuntimeMcps(
        input.serverConfig,
        input.workspaceId,
        removableMcps,
        runtimeMcps,
      );
    }, input.failRollbackStage);
    await runRollbackStep(rollbackFailures, "record", async () => {
      await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, () => cloudImports);
    }, input.failRollbackStage);
    if (input.synchronizeEngine && engineMutationAttempted) {
      await runRollbackStep(rollbackFailures, "engine", async () => {
        await input.synchronizeEngine!(engineMutationForSnapshot(removableMcps, runtimeMcps));
      }, input.failRollbackStage);
    }

    if (rollbackFailures.length > 0) {
      const repair: CloudPluginRepairDetails = {
        operation: "remove",
        cause: errorMessage(error),
        conflicts: [],
        rollbackFailures,
        recordedAt: Date.now(),
      };
      const repairItem = { ...imported, status: "repair_required" as const, repair };
      try {
        await writeInstalledCloudPlugins(input.serverConfig, input.workspaceId, (current) => ({
          ...current,
          plugins: { ...current.plugins, [input.pluginId]: repairItem },
        }));
      } catch (persistError) {
        rollbackFailures.push({ stage: "repair_record", message: errorMessage(persistError) });
      }
      throw new ApiError(500, "cloud_plugin_repair_required", "Plugin removal failed and rollback was incomplete.", {
        status: "repair_required",
        operation: "remove",
        current: repairItem,
        cause: errorMessage(error),
        conflicts: [],
        rollbackFailures,
      });
    }
    throw new ApiError(500, "cloud_plugin_remove_failed", "Plugin removal failed and the previous state was restored.", {
      status: "failed",
      operation: "remove",
      current: imported,
      cause: errorMessage(error),
      conflicts: [],
      rollbackFailures: [],
    });
  }

  return {
    item: imported,
    changed: true,
    current: null,
    operation: "remove",
    mutations: {
      filesWritten: [],
      filesRemoved: [...removableFiles].sort(),
      mcpUpserted: [],
      mcpRemoved: [...removableMcps].sort(),
      installationRecordChanged: true,
      engineSynchronized: Boolean(input.synchronizeEngine && removableMcps.length > 0),
    },
    refreshHints: [...CLOUD_PLUGIN_REFRESH_HINTS],
    warnings: [],
    status: "installed",
    outcomes: imported.files,
    conflicts: [],
  };
}

/**
 * 移除工作区插件，并在同一工作区内串行完成本地资源、账本和实时引擎协调。
 *
 * @param input 插件移除上下文和实时引擎同步器
 * @returns 已移除插件的原安装记录
 */
export async function removeCloudPlugin(input: CloudPluginRemoveInput): Promise<CloudPluginRemoveResult> {
  return serializeWorkspacePluginMutation(input.serverConfig, input.workspaceId, () => removeCloudPluginLocked(input));
}

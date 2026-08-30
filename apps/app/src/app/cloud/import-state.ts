export type CloudImportedProvider = {
  cloudProviderId: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  modelIds: string[];
  importedAt: number | null;
  /**
   * How the provider block was written, independent of what Den published.
   * Bumped when the desktop changes the shape it writes so an existing import
   * is rewritten once — Den's `updatedAt` and model list are unchanged in that
   * case, so nothing else would mark it out of sync.
   * `null` is a pre-versioning baseline.
   */
  metadataVersion: number | null;
};

export type CloudImportedMarketplace = {
  marketplaceId: string;
  name: string;
  updatedAt: string | null;
  pluginIds: string[];
  importedAt: number | null;
};

export type CloudImportedPluginFile = {
  configObjectId: string;
  componentKey?: string | null;
  serverName?: string | null;
  externalMcpConnectionId?: string | null;
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

export type CloudImportedPluginRepair = {
  operation: "install" | "sync" | "remove";
  cause: string;
  conflicts: Array<{
    code: "file_ownership_conflict" | "mcp_ownership_conflict";
    configObjectId: string;
    resource: string;
    message: string;
  }>;
  rollbackFailures: Array<{ stage: string; message: string }>;
  recordedAt: number;
};

export type CloudImportedPluginReadinessOutcome = Extract<
  NonNullable<CloudImportedPluginFile["outcome"]>,
  "needs_signin" | "needs_admin_setup"
>;

/**
 * 从已持久化的插件文件结果中解析当前 Cloud 就绪状态。
 * @param files 工作区插件文件结果
 */
export function resolveCloudImportedPluginReadiness(
  files: CloudImportedPluginFile[],
): CloudImportedPluginReadinessOutcome | null {
  // TIPS: 管理员配置是组织级阻塞，优先于成员登录提示，避免给成员不可执行的操作入口。
  if (files.some((file) => file.outcome === "needs_admin_setup")) return "needs_admin_setup";
  if (files.some((file) => file.outcome === "needs_signin")) return "needs_signin";
  return null;
}

export type CloudImportedPlugin = {
  pluginId: string;
  marketplaceId: string | null;
  name: string;
  description: string | null;
  updatedAt: string | null;
  files: CloudImportedPluginFile[];
  importedAt: number | null;
  status?: "installed" | "partial" | "failed" | "repair_required";
  resolvedRevision?: string;
  repair?: CloudImportedPluginRepair;
};

export type WorkspaceCloudImports = {
  providers: Record<string, CloudImportedProvider>;
  marketplaces: Record<string, CloudImportedMarketplace>;
  plugins: Record<string, CloudImportedPlugin>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const readOptionalString = (value: unknown): string | null | undefined =>
  typeof value === "string" ? value.trim() || null : value === null ? null : undefined;

/**
 * 读取插件修复信息，并忽略旧服务端不存在或格式不完整的可选字段。
 * @param value 待解析的修复信息
 */
export function readCloudImportedPluginRepair(value: unknown): CloudImportedPluginRepair | undefined {
  if (!isRecord(value) || (value.operation !== "install" && value.operation !== "sync" && value.operation !== "remove")) return undefined;
  const cause = typeof value.cause === "string" ? value.cause.trim() : "";
  const recordedAt = typeof value.recordedAt === "number" && Number.isFinite(value.recordedAt)
    ? value.recordedAt
    : null;
  if (!cause || recordedAt === null || !Array.isArray(value.rollbackFailures)) return undefined;
  const rollbackFailures = value.rollbackFailures.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const stage = typeof entry.stage === "string" ? entry.stage.trim() : "";
    const message = typeof entry.message === "string" ? entry.message.trim() : "";
    return stage && message ? [{ stage, message }] : [];
  });
  const conflicts = Array.isArray(value.conflicts) ? value.conflicts.flatMap((entry) => {
    if (!isRecord(entry) || (entry.code !== "file_ownership_conflict" && entry.code !== "mcp_ownership_conflict")) return [];
    const code: CloudImportedPluginRepair["conflicts"][number]["code"] = entry.code;
    const configObjectId = typeof entry.configObjectId === "string" ? entry.configObjectId.trim() : "";
    const resource = typeof entry.resource === "string" ? entry.resource.trim() : "";
    const message = typeof entry.message === "string" ? entry.message.trim() : "";
    return configObjectId && resource && message
      ? [{ code, configObjectId, resource, message }]
      : [];
  }) : [];
  return { operation: value.operation, cause, conflicts, rollbackFailures, recordedAt };
}

/**
 * 读取插件组件账本，兼容没有组件键、MCP 服务名和投递结果的历史记录。
 * @param value 待解析的组件数组
 */
export function readCloudImportedPluginFiles(value: unknown): CloudImportedPluginFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    if (!isRecord(file)) return [];
    const configObjectId = typeof file.configObjectId === "string" ? file.configObjectId.trim() : "";
    const objectType = typeof file.objectType === "string" ? file.objectType.trim() : "";
    const title = typeof file.title === "string" ? file.title.trim() : configObjectId;
    const path = typeof file.path === "string" ? file.path.trim() : "";
    const externalMcpConnectionId = readOptionalString(file.externalMcpConnectionId);
    if (!configObjectId || !objectType || !title || !path) return [];
    return [{
      configObjectId,
      componentKey: readOptionalString(file.componentKey),
      serverName: readOptionalString(file.serverName),
      externalMcpConnectionId,
      versionId: readOptionalString(file.versionId) ?? null,
      objectType,
      title,
      path,
      updatedAt: readOptionalString(file.updatedAt) ?? null,
      delivery: file.delivery === "local_file" || file.delivery === "runtime_mcp" || file.delivery === "cloud"
        ? file.delivery
        : undefined,
      outcome: file.outcome === "installed_local" || file.outcome === "available_cloud"
        || file.outcome === "needs_signin" || file.outcome === "needs_admin_setup"
        || file.outcome === "unsupported" || file.outcome === "failed"
        ? file.outcome
        : undefined,
      ownerPluginId: typeof file.ownerPluginId === "string" ? file.ownerPluginId.trim() || undefined : undefined,
      ownerConfigObjectId: typeof file.ownerConfigObjectId === "string" ? file.ownerConfigObjectId.trim() || undefined : undefined,
      digest: typeof file.digest === "string" ? file.digest : file.digest === null ? null : undefined,
      errorCode: readOptionalString(file.errorCode),
      errorMessage: readOptionalString(file.errorMessage),
    } satisfies CloudImportedPluginFile];
  });
}

/**
 * 读取单个工作区插件安装记录。
 * @param value 待解析的安装记录
 * @param fallbackPluginId 旧记录缺少 pluginId 时使用的映射键
 */
export function readCloudImportedPlugin(
  value: unknown,
  fallbackPluginId = "",
): CloudImportedPlugin | null {
  if (!isRecord(value)) return null;
  const pluginId = typeof value.pluginId === "string" ? value.pluginId.trim() : fallbackPluginId.trim();
  const name = typeof value.name === "string" ? value.name.trim() : pluginId;
  if (!pluginId || !name) return null;
  return {
    pluginId,
    marketplaceId: typeof value.marketplaceId === "string" ? value.marketplaceId.trim() || null : null,
    name,
    description: typeof value.description === "string" ? value.description.trim() || null : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt.trim() || null : null,
    files: readCloudImportedPluginFiles(value.files),
    importedAt: typeof value.importedAt === "number" && Number.isFinite(value.importedAt)
      ? value.importedAt
      : null,
    status: value.status === "installed" || value.status === "partial" || value.status === "failed" || value.status === "repair_required"
      ? value.status
      : undefined,
    resolvedRevision: typeof value.resolvedRevision === "string" ? value.resolvedRevision.trim() || undefined : undefined,
    repair: readCloudImportedPluginRepair(value.repair),
  };
}

export function readWorkspaceCloudImports(value: unknown): WorkspaceCloudImports {
  const root = isRecord(value) ? value : {};
  const cloudImports = isRecord(root.cloudImports) ? root.cloudImports : {};
  const rawProviders = isRecord(cloudImports.providers) ? cloudImports.providers : {};
  const rawMarketplaces = isRecord(cloudImports.marketplaces) ? cloudImports.marketplaces : {};
  const rawPlugins = isRecord(cloudImports.plugins) ? cloudImports.plugins : {};

  const providers = Object.fromEntries(
    Object.entries(rawProviders).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const cloudProviderId = typeof entry.cloudProviderId === "string"
        ? entry.cloudProviderId.trim()
        : key.trim();
      const providerId = typeof entry.providerId === "string" ? entry.providerId.trim() : "";
      const sourceProviderId = typeof entry.sourceProviderId === "string"
        ? entry.sourceProviderId.trim()
        : providerId;
      const name = typeof entry.name === "string" ? entry.name.trim() : providerId || cloudProviderId;
      if (!cloudProviderId || !providerId || !sourceProviderId || !name) return [];
      const imported = {
        cloudProviderId,
        providerId,
        sourceProviderId,
        name,
        source: typeof entry.source === "string" ? entry.source.trim() || null : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        modelIds: readStringArray(entry.modelIds),
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
        metadataVersion:
          typeof entry.metadataVersion === "number" && Number.isFinite(entry.metadataVersion)
            ? entry.metadataVersion
            : null,
      } satisfies CloudImportedProvider;
      return [[cloudProviderId, imported] as const];
    }),
  );

  const marketplaces = Object.fromEntries(
    Object.entries(rawMarketplaces).flatMap(([key, entry]) => {
      if (!isRecord(entry)) return [];
      const marketplaceId = typeof entry.marketplaceId === "string"
        ? entry.marketplaceId.trim()
        : key.trim();
      const name = typeof entry.name === "string" ? entry.name.trim() : marketplaceId;
      if (!marketplaceId || !name) return [];
      const imported = {
        marketplaceId,
        name,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        pluginIds: readStringArray(entry.pluginIds),
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
      } satisfies CloudImportedMarketplace;
      return [[marketplaceId, imported] as const];
    }),
  );

  const plugins = Object.fromEntries(
    Object.entries(rawPlugins).flatMap(([key, entry]) => {
      const imported = readCloudImportedPlugin(entry, key);
      return imported ? [[imported.pluginId, imported] as const] : [];
    }),
  );

  return { providers, marketplaces, plugins };
}

export function withWorkspaceCloudImports(
  config: Record<string, unknown>,
  cloudImports: WorkspaceCloudImports,
) {
  return {
    ...config,
    cloudImports: {
      providers: cloudImports.providers,
      marketplaces: cloudImports.marketplaces,
      plugins: cloudImports.plugins,
    },
  };
}

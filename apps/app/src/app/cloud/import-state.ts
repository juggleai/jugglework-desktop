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
      if (!isRecord(entry)) return [];
      const pluginId = typeof entry.pluginId === "string" ? entry.pluginId.trim() : key.trim();
      const name = typeof entry.name === "string" ? entry.name.trim() : pluginId;
      if (!pluginId || !name) return [];
      const files = Array.isArray(entry.files)
        ? entry.files.flatMap((file) => {
            if (!isRecord(file)) return [];
            const configObjectId = typeof file.configObjectId === "string" ? file.configObjectId.trim() : "";
            const objectType = typeof file.objectType === "string" ? file.objectType.trim() : "";
            const title = typeof file.title === "string" ? file.title.trim() : configObjectId;
            const path = typeof file.path === "string" ? file.path.trim() : "";
            const externalMcpConnectionId = typeof file.externalMcpConnectionId === "string"
              ? file.externalMcpConnectionId.trim() || null
              : null;
            if (!configObjectId || !objectType || !title || !path) return [];
            return [
              {
                configObjectId,
                externalMcpConnectionId,
                versionId: typeof file.versionId === "string" ? file.versionId.trim() || null : null,
                objectType,
                title,
                path,
                updatedAt: typeof file.updatedAt === "string" ? file.updatedAt.trim() || null : null,
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
                errorCode: typeof file.errorCode === "string" ? file.errorCode.trim() || null : file.errorCode === null ? null : undefined,
                errorMessage: typeof file.errorMessage === "string" ? file.errorMessage.trim() || null : file.errorMessage === null ? null : undefined,
              } satisfies CloudImportedPluginFile,
            ];
          })
        : [];
      const imported = {
        pluginId,
        marketplaceId: typeof entry.marketplaceId === "string" ? entry.marketplaceId.trim() || null : null,
        name,
        description: typeof entry.description === "string" ? entry.description.trim() || null : null,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt.trim() || null : null,
        files,
        importedAt: typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : null,
        status: entry.status === "installed" || entry.status === "partial" || entry.status === "failed" || entry.status === "repair_required"
          ? entry.status
          : undefined,
      } satisfies CloudImportedPlugin;
      return [[pluginId, imported] as const];
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

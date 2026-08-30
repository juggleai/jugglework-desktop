import type { CloudImportedPlugin, CloudImportedPluginFile } from "@/app/cloud/import-state";
import type { DenOrgPlugin, DenPluginMcpComponent } from "@/app/lib/den";
import type { PendingCloudPluginChange } from "@/app/cloud/desktop-cloud-sync";

export type MarketplacePluginLifecycleState =
  | "not_installed"
  | "installing"
  | "current"
  | "update_available"
  | "partial"
  | "needs_signin"
  | "needs_admin"
  | "failed"
  | "repair_required"
  | "removing";

export type MarketplacePluginDelivery = "cloud_only" | "desktop_only" | "mixed";

export type MarketplacePluginComponentState = "current" | "not_installed" | "needs_signin" | "needs_admin" | "failed";

export type MarketplacePluginComponentAvailability = DenPluginMcpComponent & {
  state: MarketplacePluginComponentState;
};

export type MarketplacePluginOperation = "installing" | "removing" | "failed" | null;

export type MarketplaceDetailResolutionState = "loading" | "refreshing" | "current" | "stale" | "unknown";

export type MarketplacePluginActionKind =
  | "install"
  | "update"
  | "continue"
  | "retry"
  | "sign_in"
  | "repair"
  | "force_resync";

export type MarketplacePluginAction = {
  kind: MarketplacePluginActionKind;
  mutatesWorkspace: boolean;
};

/**
 * 判断详情操作是否应禁用；未解析或陈旧详情只阻止工作区写入，不阻止成员登录。
 * @param action 待执行操作
 * @param input 当前忙碌、权限与详情解析状态
 */
export function isMarketplacePluginActionDisabled(
  action: MarketplacePluginAction,
  input: {
    busy: boolean;
    canMutate: boolean;
    resolutionState: MarketplaceDetailResolutionState;
  },
): boolean {
  if (input.busy) return true;
  if (!action.mutatesWorkspace) return false;
  return !input.canMutate || input.resolutionState !== "current";
}

export type MarketplacePluginLifecycle = {
  state: MarketplacePluginLifecycleState;
  delivery: MarketplacePluginDelivery;
  components: MarketplacePluginComponentAvailability[];
  primaryAction: MarketplacePluginAction | null;
  secondaryAction: MarketplacePluginAction | null;
  hasLocalLedger: boolean;
  error: string | null;
  failedOperation: "install" | "remove" | null;
};

export type ResolveMarketplacePluginLifecycleInput = {
  plugin: Pick<DenOrgPlugin, "updatedAt" | "memberCount" | "cloudReadiness">;
  imported: CloudImportedPlugin | null;
  pendingChange?: PendingCloudPluginChange;
  components: DenPluginMcpComponent[];
  resolvedConfigObjectIds?: string[] | null;
  operation?: MarketplacePluginOperation;
  operationError?: string | null;
  failedOperation?: "install" | "remove" | null;
};

function filesForComponent(files: CloudImportedPluginFile[], component: DenPluginMcpComponent) {
  const objectFiles = files.filter((file) => file.configObjectId === component.configObjectId);
  const expectedComponentKey = component.serverName
    ? `${component.configObjectId}:${component.serverName}`
    : component.configObjectId;
  const componentFiles = objectFiles.filter((file) =>
    file.componentKey === expectedComponentKey
    || (Boolean(component.serverName) && file.serverName === component.serverName),
  );
  if (componentFiles.length > 0) return componentFiles;

  // TIPS: 一旦同一配置对象有逐 server 账本，不能再回退到 configObjectId，
  // 否则一个 sibling server 的失败会污染同对象下的其他 server。
  if (objectFiles.some((file) =>
    Boolean(file.serverName)
    || (Boolean(file.componentKey) && file.componentKey !== file.configObjectId),
  )) return [];
  return objectFiles;
}

function cloudComponentState(component: DenPluginMcpComponent, files: CloudImportedPluginFile[]): MarketplacePluginComponentState {
  const matchingFiles = filesForComponent(files, component);
  if (matchingFiles.some((file) => file.outcome === "failed" || Boolean(file.errorMessage))) return "failed";
  if (matchingFiles.some((file) => file.outcome === "needs_admin_setup")) return "needs_admin";
  if (matchingFiles.some((file) => file.outcome === "needs_signin")) return "needs_signin";
  if (component.connectionId === null) return "needs_admin";
  if (component.connectedForMe === false) {
    return component.credentialMode === "per_member" || Boolean(component.connectionId)
      ? "needs_signin"
      : "needs_admin";
  }
  return "current";
}

/**
 * 从当前上下文的最新行中重新解析详情选择。
 * @param rows 当前组织与工作区渲染出的行
 * @param selection 已保存的稳定行标识及上下文
 * @param context 当前组织与工作区
 * @param getRowKey 行稳定标识读取函数
 */
export function resolveMarketplaceDetailSelection<T>(
  rows: T[],
  selection: { rowKey: string; organizationId: string; workspaceKey: string } | null,
  context: { organizationId: string; workspaceKey: string },
  getRowKey: (row: T) => string,
): T | null {
  if (!selection) return null;
  if (selection.organizationId !== context.organizationId || selection.workspaceKey !== context.workspaceKey) return null;
  return rows.find((row) => getRowKey(row) === selection.rowKey) ?? null;
}

function desktopComponentState(component: DenPluginMcpComponent, files: CloudImportedPluginFile[]): MarketplacePluginComponentState {
  const matchingFiles = filesForComponent(files, component);
  if (matchingFiles.some((file) => file.outcome === "failed" || Boolean(file.errorMessage))) return "failed";
  const installed = matchingFiles.some((file) =>
    file.outcome === "installed_local"
    || file.delivery === "local_file"
    || file.delivery === "runtime_mcp"
    // Legacy records predate delivery/outcome metadata and represent local files.
    || (file.outcome === undefined && file.delivery === undefined),
  );
  return installed ? "current" : "not_installed";
}

/**
 * 解析当前已发布版本中每个 MCP 组件的实际可用性。
 * @param components 当前 resolved 版本的 MCP 组件
 * @param imported 当前工作区的导入结果
 */
export function resolveMarketplacePluginComponentAvailability(
  components: DenPluginMcpComponent[],
  imported: CloudImportedPlugin | null,
): MarketplacePluginComponentAvailability[] {
  const files = imported?.files ?? [];
  return components.map((component) => ({
    ...component,
    state: component.delivery === "cloud"
      ? cloudComponentState(component, files)
      : desktopComponentState(component, files),
  }));
}

/**
 * 解析市场包的当前投递形态。
 * @param components 当前 resolved 版本的 MCP 组件
 */
export function resolveMarketplacePluginDelivery(
  components: DenPluginMcpComponent[],
  resolvedConfigObjectIds: string[] | null = null,
  memberCount = 0,
): MarketplacePluginDelivery {
  const mcpObjectIds = new Set(components.map((component) => component.configObjectId));
  const hasWorkspaceComponents = resolvedConfigObjectIds
    ? resolvedConfigObjectIds.some((id) => !mcpObjectIds.has(id))
    : memberCount > mcpObjectIds.size;
  const cloudCount = components.filter((component) => component.delivery === "cloud").length;
  const hasDesktopComponents = hasWorkspaceComponents || components.some((component) => component.delivery === "desktop");
  if (cloudCount > 0 && !hasDesktopComponents) return "cloud_only";
  if (cloudCount === 0) return "desktop_only";
  return "mixed";
}

/**
 * 判断工作区是否存在可移除或可重同步的本地插件账本。
 * @param imported 当前工作区导入记录
 */
export function hasMarketplacePluginLocalLedger(imported: CloudImportedPlugin | null): boolean {
  return imported?.files.some((file) =>
    file.delivery === "local_file"
    || file.delivery === "runtime_mcp"
    || file.outcome === "installed_local"
    // 旧账本没有 delivery/outcome 字段，其记录本身代表已写入的本地资源。
    || (file.delivery === undefined && file.outcome === undefined),
  ) ?? false;
}

/**
 * 按规范状态返回唯一主操作；仅 current 状态提供次要的强制重新同步操作。
 * @param state 插件生命周期状态
 */
export function resolveMarketplacePluginActions(
  state: MarketplacePluginLifecycleState,
  options: { hasLocalLedger?: boolean } = {},
): {
  primaryAction: MarketplacePluginAction | null;
  secondaryAction: MarketplacePluginAction | null;
} {
  switch (state) {
    case "not_installed":
      return { primaryAction: { kind: "install", mutatesWorkspace: true }, secondaryAction: null };
    case "update_available":
      return { primaryAction: { kind: "update", mutatesWorkspace: true }, secondaryAction: null };
    case "partial":
      return { primaryAction: { kind: "continue", mutatesWorkspace: true }, secondaryAction: null };
    case "failed":
      return { primaryAction: { kind: "retry", mutatesWorkspace: true }, secondaryAction: null };
    case "needs_signin":
      return { primaryAction: { kind: "sign_in", mutatesWorkspace: false }, secondaryAction: null };
    case "needs_admin":
      return { primaryAction: null, secondaryAction: null };
    case "repair_required":
      return { primaryAction: { kind: "repair", mutatesWorkspace: true }, secondaryAction: null };
    case "current":
      return {
        primaryAction: null,
        secondaryAction: options.hasLocalLedger
          ? { kind: "force_resync", mutatesWorkspace: true }
          : null,
      };
    case "installing":
    case "removing":
      return { primaryAction: null, secondaryAction: null };
  }
}

/**
 * 解析市场包的规范生命周期状态。
 *
 * TIPS: 优先级固定为进行中操作 > 需修复 > 失败 > 组织配置 > 成员登录 > 部分完成
 * > 可更新 > 未安装 > 当前。可执行的就绪阻塞必须覆盖泛化的 partial，避免出现无效的“继续”入口。
 *
 * @param input 当前发布版本、工作区导入结果与进行中操作
 */
export function resolveMarketplacePluginLifecycle(
  input: ResolveMarketplacePluginLifecycleInput,
): MarketplacePluginLifecycle {
  const { plugin, imported, components } = input;
  const availability = resolveMarketplacePluginComponentAvailability(components, imported);
  const delivery = resolveMarketplacePluginDelivery(
    components,
    input.resolvedConfigObjectIds ?? null,
    plugin.memberCount,
  );
  const hasLocalLedger = hasMarketplacePluginLocalLedger(imported);
  let state: MarketplacePluginLifecycleState;

  if (input.operation === "removing") state = "removing";
  else if (input.operation === "installing") state = "installing";
  else if (imported?.status === "repair_required") state = "repair_required";
  else if (
    input.operation === "failed"
    || imported?.status === "failed"
    || availability.some((component) => component.state === "failed")
  ) state = "failed";
  else {
    const resolvedIds = input.resolvedConfigObjectIds ?? null;
    const mcpObjectIds = new Set(components.map((component) => component.configObjectId));
    const workspaceObjectIds = resolvedIds?.filter((id) => !mcpObjectIds.has(id)) ?? [];
    const importedObjectIds = new Set(imported?.files.map((file) => file.configObjectId) ?? []);
    const missingWorkspaceObject = workspaceObjectIds.some((id) => !importedObjectIds.has(id));
    const missingDesktopComponent = availability.some((component) =>
      component.delivery === "desktop" && component.state === "not_installed",
    );
    const hasWorkspaceObjects = resolvedIds
      ? workspaceObjectIds.length > 0
      : plugin.memberCount > mcpObjectIds.size;
    const requiresWorkspaceInstall = hasWorkspaceObjects || components.some((component) => component.delivery === "desktop");
    const versionChanged = Boolean(imported) && imported?.updatedAt !== plugin.updatedAt;
    // 新发布版本新增的组件属于 update_available；只有同一发布版本缺项才是 partial。
    const structurallyPartial = Boolean(imported) && !versionChanged && (missingWorkspaceObject || missingDesktopComponent);

    if (
      availability.some((component) => component.state === "needs_admin")
      || imported?.files.some((file) => file.outcome === "needs_admin_setup")
      || plugin.cloudReadiness?.state === "needs_admin_setup"
    ) state = "needs_admin";
    else if (
      availability.some((component) => component.state === "needs_signin")
      || imported?.files.some((file) => file.outcome === "needs_signin")
      || plugin.cloudReadiness?.state === "needs_signin"
    ) state = "needs_signin";
    else if (imported?.status === "partial" || structurallyPartial) state = "partial";
    else if (
      input.pendingChange === "modified"
      || versionChanged
    ) state = "update_available";
    else if (!imported && requiresWorkspaceInstall) state = "not_installed";
    else state = "current";
  }

  return {
    state,
    delivery,
    components: availability,
    hasLocalLedger,
    error: input.operation === "failed" ? input.operationError ?? null : null,
    failedOperation: input.operation === "failed" ? input.failedOperation ?? "install" : null,
    ...resolveMarketplacePluginActions(state, { hasLocalLedger }),
  };
}

/**
 * 生成 resolved 插件缓存键，隔离组织和发布版本。
 * @param organizationId 组织 ID
 * @param plugin 插件稳定 ID 与版本时间
 */
export function marketplaceResolvedCacheKey(
  organizationId: string,
  plugin: Pick<DenOrgPlugin, "id" | "updatedAt">,
): string {
  return `${organizationId}:${plugin.id}:${plugin.updatedAt ?? "unversioned"}`;
}

/**
 * 从按版本隔离的详情缓存中读取当前版本，并在当前版本失败时保留最近一次成功内容。
 * @param cache resolved 详情缓存
 * @param organizationId 组织 ID
 * @param plugin 插件稳定 ID 与版本时间
 */
export function resolveMarketplaceResolvedCache<T>(
  cache: Record<string, T>,
  organizationId: string,
  plugin: Pick<DenOrgPlugin, "id" | "updatedAt">,
): { current: T | null; lastKnownGood: T | null } {
  const currentKey = marketplaceResolvedCacheKey(organizationId, plugin);
  const current = cache[currentKey] ?? null;
  if (current) return { current, lastKnownGood: current };

  const prefix = `${organizationId}:${plugin.id}:`;
  const previous = Object.entries(cache)
    .reverse()
    .find(([key]) => key.startsWith(prefix))?.[1] ?? null;
  return { current: null, lastKnownGood: previous };
}

/**
 * 解析详情加载展示状态；失败时仅把已有成功内容标为陈旧，不将失败结果写入缓存。
 * @param input 当前版本、最近成功内容、请求与错误状态
 */
export function resolveMarketplaceDetailResolution(input: {
  hasCurrent: boolean;
  hasLastKnownGood: boolean;
  resolving: boolean;
  hasError: boolean;
}): MarketplaceDetailResolutionState {
  if (input.resolving) return input.hasLastKnownGood ? "refreshing" : "loading";
  if (input.hasError) return input.hasLastKnownGood ? "stale" : "unknown";
  if (input.hasCurrent) return "current";
  return input.hasLastKnownGood ? "stale" : "unknown";
}

type OpenCodeContext = { directory?: string; worktree?: string; workspaceId?: string; sessionId?: string };

type WorkspaceRequestIdentity = {
  directory?: string;
  workspaceId?: string;
  sessionId?: string;
};

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (typeof record[name] === "string" && record[name].trim()) return record[name];
  }
  return undefined;
}

function contextFrom(value: unknown): OpenCodeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const nested = record.context && typeof record.context === "object" && !Array.isArray(record.context)
    ? record.context as Record<string, unknown>
    : {};
  return {
    directory: stringField(record, "directory") ?? stringField(nested, "directory"),
    worktree: stringField(record, "worktree") ?? stringField(nested, "worktree"),
    workspaceId: stringField(record, "workspaceId", "workspaceID") ?? stringField(nested, "workspaceId", "workspaceID"),
    sessionId: stringField(record, "sessionID", "sessionId") ?? stringField(nested, "sessionID", "sessionId"),
  };
}

function normalizeWorkspacePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

async function resolveWorkspaceIdentity(serverUrl: string, token: string, directory: string | undefined, explicitWorkspaceId: string | undefined) {
  if (!directory) return explicitWorkspaceId;
  try {
    const response = await fetch(`${serverUrl}/workspaces`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return undefined;
    const payload = await response.json() as { items?: Array<{ id?: unknown; path?: unknown; root?: unknown; directory?: unknown; workspaceType?: unknown; opencode?: { directory?: unknown } }> };
    const normalized = normalizeWorkspacePath(directory);
    return (payload.items ?? [])
      .flatMap((entry) => typeof entry.id === "string" && entry.workspaceType !== "remote"
        ? [entry.path, entry.root, entry.directory, entry.opencode?.directory]
          .flatMap((value) => typeof value === "string" && value.trim() ? [{ id: entry.id as string, path: normalizeWorkspacePath(value) }] : [])
        : [])
      .filter((entry) => normalized === entry.path || normalized.startsWith(`${entry.path}/`))
      .sort((left, right) => right.path.length - left.path.length)[0]?.id;
  } catch {
    return undefined;
  }
}

async function requestIdentityFrom(
  serverUrl: string,
  token: string,
  context: OpenCodeContext,
  fallbackWorkspaceId?: string,
): Promise<WorkspaceRequestIdentity> {
  const rawDirectory = context.worktree?.trim() || context.directory?.trim();
  const directory = rawDirectory === "/" ? undefined : rawDirectory;
  const sessionId = context.sessionId?.trim() || undefined;
  if (directory) {
    return {
      directory,
      workspaceId: await resolveWorkspaceIdentity(serverUrl, token, directory, context.workspaceId?.trim()),
      sessionId,
    };
  }
  // TIPS: sessionID 是每次工具调用的真实会话身份；共享引擎中不能同时携带启动工作区 ID，
  // 否则服务端会优先按旧工作区 ID 检查，造成跨工作区误放行。
  if (sessionId) return { sessionId };
  return { workspaceId: context.workspaceId?.trim() || fallbackWorkspaceId };
}

/** 常驻执行拦截器：策略更新后无需重新加载 OpenCode。 */
export const JuggleWorkMcpWorkspacePolicy = async (factoryInput?: unknown) => {
  const factoryContext = contextFrom(factoryInput);
  const knownMcpPrefixes = new Set<string>();
  const serverUrl = String(process.env.JUGGLEWORK_SERVER_URL || "").replace(/\/$/, "");
  const token = String(process.env.JUGGLEWORK_SERVER_TOKEN || "");
  const fallbackWorkspaceId = String(process.env.JUGGLEWORK_WORKSPACE_ID || "").trim() || undefined;
  const factoryIdentity = await requestIdentityFrom(serverUrl, token, factoryContext, fallbackWorkspaceId);
  const refreshInventory = async (identity: WorkspaceRequestIdentity) => {
    if ((!identity.directory && !identity.workspaceId && !identity.sessionId) || !serverUrl || !token) return false;
    try {
      const response = await fetch(`${serverUrl}/internal/mcp-tool-policy/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...identity, operation: "inventory" }),
      });
      if (response.ok) {
        const inventory = await response.json() as { serverNames?: unknown };
        if (Array.isArray(inventory.serverNames)) {
          for (const name of inventory.serverNames) {
            if (typeof name === "string") knownMcpPrefixes.add(`${name.replace(/[^a-zA-Z0-9_-]/g, "_")}_`);
          }
          return true;
        }
      }
    } catch {
      // Plugin remains loaded; generic resource tools still fail closed. The UI only exposes
      // soft policy on managed local engines, and a later engine restart retries inventory.
    }
    return false;
  };
  await refreshInventory(factoryIdentity);
  return {
    "tool.execute.before": async (input: {
      tool?: unknown;
      callID?: unknown;
      sessionID?: unknown;
      sessionId?: unknown;
      directory?: unknown;
      worktree?: unknown;
      workspaceId?: unknown;
      workspaceID?: unknown;
      context?: unknown;
    }, output: { args?: unknown }) => {
      if (typeof input.tool !== "string") return;
      const toolId = input.tool;
      const callContext = contextFrom(input);
      const hasCallIdentity = Boolean(
        callContext.worktree?.trim()
        || callContext.directory?.trim()
        || callContext.sessionId?.trim()
        || callContext.workspaceId?.trim(),
      );
      const identity = hasCallIdentity
        ? await requestIdentityFrom(serverUrl, token, callContext)
        : factoryIdentity;
      const isGenericResourceTool = toolId === "list_mcp_resources"
        || toolId === "list_mcp_resource_templates"
        || toolId === "read_mcp_resource";
      // 非 MCP 工具必须快速放行，不能让策略服务成为整个 Agent 的单点故障。
      // 已确认的 MCP 前缀由成功策略检查逐步学习；generic resources 始终检查。
      let mayBeMcp = isGenericResourceTool || [...knownMcpPrefixes].some((prefix) => toolId.startsWith(prefix));
      // 新安装或启动时 inventory 失败的 MCP 不能因缓存为空而永久绕过。未知工具先
      // 刷新 inventory；策略服务可用时由完整 serverName 集合准确判定，服务不可用
      // 时仅放行尚未被确认属于 MCP 的普通工具。
      if (!mayBeMcp && await refreshInventory(identity)) mayBeMcp = [...knownMcpPrefixes].some((prefix) => toolId.startsWith(prefix));
      if (!mayBeMcp) return;
      if (!identity.directory && !identity.workspaceId && !identity.sessionId) {
        if (mayBeMcp) throw new Error("mcp_workspace_identity_unavailable");
        return;
      }
      if (!serverUrl || !token) throw new Error("mcp_workspace_policy_unavailable");
      const response = await fetch(`${serverUrl}/internal/mcp-tool-policy/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...identity, toolId, args: output.args }),
      });
      if (!response.ok) throw new Error("mcp_workspace_policy_unavailable");
      const decision = await response.json() as { allowed?: boolean; code?: string; serverName?: string | null };
      if (decision.serverName) knownMcpPrefixes.add(`${decision.serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}_`);
      if (decision.allowed === false) {
        throw new Error(`${decision.code ?? "mcp_disabled_in_workspace"}${decision.serverName ? `:${decision.serverName}` : ""}`);
      }
    },
  };
};

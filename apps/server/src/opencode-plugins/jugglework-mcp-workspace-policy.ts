type OpenCodeContext = { directory?: string; worktree?: string };

function contextFrom(value: unknown): OpenCodeContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    directory: typeof record.directory === "string" ? record.directory : undefined,
    worktree: typeof record.worktree === "string" ? record.worktree : undefined,
  };
}

/** 常驻执行拦截器：策略更新后无需重新加载 OpenCode。 */
export const JuggleWorkMcpWorkspacePolicy = async (factoryInput?: unknown) => {
  const context = contextFrom(factoryInput);
  const knownMcpPrefixes = new Set<string>();
  const directory = context.worktree?.trim() || context.directory?.trim();
  const serverUrl = String(process.env.JUGGLEWORK_SERVER_URL || "").replace(/\/$/, "");
  const token = String(process.env.JUGGLEWORK_SERVER_TOKEN || "");
  const refreshInventory = async () => {
    if (!directory || !serverUrl || !token) return false;
    try {
      const response = await fetch(`${serverUrl}/internal/mcp-tool-policy/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ directory, operation: "inventory" }),
      });
      if (response.ok) {
        const inventory = await response.json() as { serverNames?: unknown };
        if (Array.isArray(inventory.serverNames)) {
          knownMcpPrefixes.clear();
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
  await refreshInventory();
  return {
    "tool.execute.before": async (input: { tool?: unknown }, output: { args?: unknown }) => {
      if (typeof input.tool !== "string") return;
      const toolId = input.tool;
      const isGenericResourceTool = toolId === "list_mcp_resources"
        || toolId === "list_mcp_resource_templates"
        || toolId === "read_mcp_resource";
      // 非 MCP 工具必须快速放行，不能让策略服务成为整个 Agent 的单点故障。
      // 已确认的 MCP 前缀由成功策略检查逐步学习；generic resources 始终检查。
      let mayBeMcp = isGenericResourceTool || [...knownMcpPrefixes].some((prefix) => toolId.startsWith(prefix));
      // 新安装的 MCP 可能在 plugin 启动后才出现。未知工具只刷新一次 inventory；
      // 刷新失败时普通工具继续可用，已知 MCP 仍按缓存 fail closed。
      if (!mayBeMcp && await refreshInventory()) {
        mayBeMcp = [...knownMcpPrefixes].some((prefix) => toolId.startsWith(prefix));
      }
      if (!mayBeMcp) return;
      if (!directory) {
        if (mayBeMcp) throw new Error("mcp_workspace_identity_unavailable");
        return;
      }
      if (!serverUrl || !token) throw new Error("mcp_workspace_policy_unavailable");
      const response = await fetch(`${serverUrl}/internal/mcp-tool-policy/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ directory, toolId, args: output.args }),
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

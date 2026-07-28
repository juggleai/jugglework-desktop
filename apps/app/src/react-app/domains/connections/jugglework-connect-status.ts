import type { SessionCloudMcpMaintenanceState } from "./use-session-mcp-maintenance";

export type JuggleWorkConnectStatus = {
  state: "checking" | "ready" | "needs_attention";
  label: "Checking" | "Ready" | "Needs attention";
  description: string;
};

export function juggleWorkConnectAttentionTitle(description: string): string {
  return `One possible issue: ${description}`;
}

export function resolveJuggleWorkConnectStatus(
  signedIn: boolean,
  maintenance: SessionCloudMcpMaintenanceState | undefined,
): JuggleWorkConnectStatus | null {
  if (!signedIn) return null;

  if (maintenance?.status === "ready") {
    return {
      state: "ready",
      label: "Ready",
      description: "Connected service tools are available.",
    };
  }

  if (maintenance?.status === "failed" || maintenance?.status === "skipped") {
    return {
      state: "needs_attention",
      label: "Needs attention",
      description: maintenance.issue?.message
        ?? "JuggleWork Connect could not verify connected service tools. Run diagnostics for details.",
    };
  }

  return {
    state: "checking",
    label: "Checking",
    description: maintenance?.status === "retrying"
      ? `Restoring connected service tools (${maintenance.attempt}/${maintenance.maxAttempts}).`
      : "Checking connected service tools in the background.",
  };
}

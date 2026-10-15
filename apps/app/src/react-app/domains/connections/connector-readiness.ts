import type { McpServerConfig, McpStatus } from "@/app/types";
import { t } from "@/i18n";

/** Never derive user-facing hints from provider error strings or credential values. */
export function connectorReadiness(config: McpServerConfig, status?: McpStatus) {
  const state = config.enabled === false ? "disabled" : status?.status ?? "pending";
  const tokenAuth = config.type === "remote" && (config.oauth === false || Boolean(config.headers?.Authorization || config.headers?.authorization));
  const canAuthorize = config.type === "remote" && !tokenAuth && state === "needs_auth";
  switch (state) {
    case "connected": return { state, label: t("mcp.status_connected"), hint: null, canAuthorize };
    case "disabled": return { state, label: t("mcp.disabled_label"), hint: t("mcp.readiness_disabled_hint"), canAuthorize: false };
    case "failed": return { state, label: t("mcp.readiness_disconnected"), hint: null, canAuthorize: false };
    case "needs_auth": return { state, label: t(tokenAuth ? "mcp.readiness_credentials" : "mcp.status_needs_auth"), hint: t(tokenAuth ? "mcp.readiness_token_hint" : "mcp.readiness_auth_hint"), canAuthorize };
    case "needs_client_registration": return { state, label: t("connect.diagnostics_sync_status_needs_client_registration"), hint: t("mcp.readiness_registration_hint"), canAuthorize: false };
    default: return { state: "pending" as const, label: t("mcp.readiness_unverified"), hint: t("mcp.readiness_pending_hint"), canAuthorize: false };
  }
}

import { getMcpServerName, type McpDirectoryInfo } from "@/app/constants";
import type { GlobalMcpEntry } from "../state/global-mcp-config";

const RETIRED_PUBLIC_CONNECTOR_IDS = new Set([
  "github",
  "notion",
  "linear",
  "sentry",
  "stripe",
  "context7",
]);

/** Retired directory installs remain usable as personal connectors, but no longer appear under Public. */
function isRetiredPublicConnector(connector: GlobalMcpEntry): boolean {
  return connector.catalogSource === "public"
    && typeof connector.catalogId === "string"
    && RETIRED_PUBLIC_CONNECTOR_IDS.has(connector.catalogId.trim().toLowerCase());
}

/** Prefer stored provenance; legacy entries require exact name and endpoint identity. */
export function matchPublicConnector(
  connector: GlobalMcpEntry,
  entries: readonly McpDirectoryInfo[],
): McpDirectoryInfo | undefined {
  if (isRetiredPublicConnector(connector)) return undefined;
  if (connector.catalogSource === "personal") return undefined;
  if (connector.catalogSource === "public" && connector.catalogId !== undefined) {
    return entries.find((entry) => (entry.id ?? getMcpServerName(entry)) === connector.catalogId);
  }
  return entries.find((entry) => {
    if (connector.name !== getMcpServerName(entry)) return false;
    if (connector.config.type === "remote" && (entry.type ?? "remote") === "remote") {
      const url = entry.url?.trim();
      return Boolean(url) && connector.config.url?.trim() === url;
    }
    if (connector.config.type === "local" && entry.type === "local" && entry.command?.length) {
      const command = connector.config.command;
      return command?.length === entry.command.length
        && entry.command.every((argument, index) => argument === command[index]);
    }
    return false;
  });
}

export function resolveConnectorCatalogSource(
  connector: GlobalMcpEntry,
  entries: readonly McpDirectoryInfo[],
): "public" | "personal" {
  if (isRetiredPublicConnector(connector)) return "personal";
  return connector.catalogSource ?? (matchPublicConnector(connector, entries) ? "public" : "personal");
}

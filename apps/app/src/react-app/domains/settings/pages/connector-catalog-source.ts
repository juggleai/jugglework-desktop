import { getMcpServerName, type McpDirectoryInfo } from "@/app/constants";
import type { GlobalMcpEntry } from "../state/global-mcp-config";

/** Prefer stored provenance; legacy entries require exact name and endpoint identity. */
export function matchPublicConnector(
  connector: GlobalMcpEntry,
  entries: readonly McpDirectoryInfo[],
): McpDirectoryInfo | undefined {
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
  return connector.catalogSource ?? (matchPublicConnector(connector, entries) ? "public" : "personal");
}

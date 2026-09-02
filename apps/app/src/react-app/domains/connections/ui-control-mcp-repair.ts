import type { McpServerEntry } from "../../../app/types";

export const UI_CONTROL_MCP_SERVER_NAME = "jugglework-ui";
export const LEGACY_UI_CONTROL_MCP_COMMAND = ["npx", "-y", "jugglework-ui-mcp"] as const;

export function canAttemptBundledUiControlMcpRepair(input: {
  desktopRuntime: boolean;
  workspaceType: "local" | "remote";
  embeddedServer: boolean;
}): boolean {
  return input.desktopRuntime && input.workspaceType === "local" && input.embeddedServer;
}

export function mergeBundledUiControlMcpEnvironment(
  configured: Record<string, string>,
  required: Record<string, string>,
): Record<string, string> {
  return { ...configured, ...required };
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function isLegacyUiControlMcpCommand(command: unknown): boolean {
  if (!Array.isArray(command) || command.length !== LEGACY_UI_CONTROL_MCP_COMMAND.length) return false;
  const executable = typeof command[0] === "string" ? command[0].replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() : "";
  return (executable === "npx" || executable === "npx.cmd")
    && command[1] === LEGACY_UI_CONTROL_MCP_COMMAND[1]
    && command[2] === LEGACY_UI_CONTROL_MCP_COMMAND[2];
}

function normalizeManagedPath(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() : "";
}

export function isManagedBundledUiControlMcpCommand(command: unknown, desiredCommand: string[]): boolean {
  if (!Array.isArray(command) || command.length !== 2 || desiredCommand.length !== 2) return false;
  const marker = "/runtime/jugglework-ui-mcp/";
  const currentEntry = normalizeManagedPath(command[1]);
  const desiredEntry = normalizeManagedPath(desiredCommand[1]);
  const currentMarker = currentEntry.lastIndexOf(marker);
  const desiredMarker = desiredEntry.lastIndexOf(marker);
  if (currentMarker <= 0 || desiredMarker <= 0) return false;
  if (currentEntry.slice(0, currentMarker) !== desiredEntry.slice(0, desiredMarker)) return false;
  return currentEntry.slice(currentMarker + marker.length).split("/").filter(Boolean).length === 2
    && currentEntry.endsWith("/index.mjs")
    && desiredEntry.endsWith("/index.mjs");
}

export function needsBundledUiControlMcpRepair(
  server: McpServerEntry | undefined,
  desiredCommand: string[],
  desiredEnvironment: Record<string, string>,
): boolean {
  if (!server || server.name !== UI_CONTROL_MCP_SERVER_NAME) return false;
  if (server.config.type !== "local" || server.config.enabled === false) return false;
  if (isLegacyUiControlMcpCommand(server.config.command)) return true;
  if (isManagedBundledUiControlMcpCommand(server.config.command, desiredCommand)
    && !sameStringArray(server.config.command, desiredCommand)) return true;
  if (!sameStringArray(server.config.command, desiredCommand)) return false;

  const currentEnvironment = server.config.environment ?? {};
  return Object.entries(desiredEnvironment).some(([key, value]) => currentEnvironment[key] !== value);
}

export function bundledUiControlMcpMigrationPatch(
  server: McpServerEntry,
  desiredCommand: string[],
  desiredEnvironment: Record<string, string>,
): Record<string, unknown> | null {
  if (!needsBundledUiControlMcpRepair(server, desiredCommand, desiredEnvironment)) return null;
  return {
    command: desiredCommand,
    environment: desiredEnvironment,
  };
}

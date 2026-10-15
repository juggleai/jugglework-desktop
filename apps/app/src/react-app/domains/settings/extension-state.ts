import { getMcpServerName, type McpDirectoryInfo } from "../../../app/constants";

const EXTENSION_DISABLED_KEY_PREFIX = "jugglework.extension.disabled.";
const EXTENSION_ENABLED_KEY_PREFIX = "jugglework.extension.enabled.";
const EXTENSION_HIDDEN_KEY_PREFIX = "jugglework.extension.hidden.";
export const JUGGLEWORK_EXTENSION_STATE_CHANGED = "jugglework:extension-state-changed";

export function getExtensionId(entry: McpDirectoryInfo): string {
  return entry.id ?? entry.serverName ?? getMcpServerName(entry);
}

export function isJuggleWorkExtensionEnabled(entry: McpDirectoryInfo): boolean {
  if (typeof window === "undefined") return Boolean(entry.defaultEnabled);
  const id = getExtensionId(entry);
  if (!entry.defaultEnabled) return window.localStorage.getItem(`${EXTENSION_ENABLED_KEY_PREFIX}${id}`) === "1";
  return window.localStorage.getItem(`${EXTENSION_DISABLED_KEY_PREFIX}${id}`) !== "1";
}

export function setJuggleWorkExtensionEnabled(entry: McpDirectoryInfo, enabled: boolean) {
  if (typeof window === "undefined") return;
  const id = getExtensionId(entry);
  if (entry.defaultEnabled) {
    const disabledKey = `${EXTENSION_DISABLED_KEY_PREFIX}${id}`;
    if (enabled) {
      window.localStorage.removeItem(disabledKey);
    } else {
      window.localStorage.setItem(disabledKey, "1");
    }
  } else {
    const enabledKey = `${EXTENSION_ENABLED_KEY_PREFIX}${id}`;
    if (enabled) {
      window.localStorage.setItem(enabledKey, "1");
    } else {
      window.localStorage.removeItem(enabledKey);
    }
  }
  window.dispatchEvent(new CustomEvent(JUGGLEWORK_EXTENSION_STATE_CHANGED, {
    detail: { id, enabled },
  }));
}

/** Whether the catalog can directly enable or disable this built-in plugin. */
export function canSetJuggleWorkExtensionEnabled(entry: McpDirectoryInfo): boolean {
  const manifest = entry.extensionManifest;
  return Boolean(manifest && manifest.source.origin === "builtin" && manifest.source.trusted);
}

/**
 * Apply the catalog enablement action using the plugin's real lifecycle.
 * Toggle-backed plugins persist a local preference; MCP-backed plugins must
 * add or remove their configured server instead of writing an unused toggle.
 */
export async function setJuggleWorkExtensionEnabledWithLifecycle(
  entry: McpDirectoryInfo,
  enabled: boolean,
  actions: {
    connectMcp: (entry: McpDirectoryInfo) => void | Promise<unknown>;
    removeMcp: (name: string) => void | Promise<unknown>;
  },
) {
  const mcpResource = entry.extensionManifest?.resources.find((resource) => resource.type === "mcp");
  const toggleControlled = entry.extensionManifest?.enablement?.some((condition) => condition.type === "toggle-enabled") === true;
  if (toggleControlled || !mcpResource) {
    setJuggleWorkExtensionEnabled(entry, enabled);
    return;
  }

  if (enabled) {
    await actions.connectMcp(entry);
  } else {
    await actions.removeMcp(mcpResource.mcpServerName ?? getMcpServerName(entry));
  }
}

export function isJuggleWorkExtensionHidden(entryOrId: McpDirectoryInfo | string): boolean {
  const id = typeof entryOrId === "string" ? entryOrId : getExtensionId(entryOrId);
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(`${EXTENSION_HIDDEN_KEY_PREFIX}${id}`);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return typeof entryOrId !== "string" && entryOrId.defaultHidden === true;
}

export function setJuggleWorkExtensionHidden(entryOrId: McpDirectoryInfo | string, hidden: boolean) {
  const id = typeof entryOrId === "string" ? entryOrId : getExtensionId(entryOrId);
  if (typeof window === "undefined") return;
  const key = `${EXTENSION_HIDDEN_KEY_PREFIX}${id}`;
  window.localStorage.setItem(key, hidden ? "1" : "0");
  window.dispatchEvent(new CustomEvent(JUGGLEWORK_EXTENSION_STATE_CHANGED, {
    detail: { id, hidden },
  }));
}

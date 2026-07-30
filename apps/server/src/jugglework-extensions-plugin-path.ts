import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare global {
  namespace NodeJS {
    interface Process {
      resourcesPath?: string;
    }
  }
}

function resourcesPathFromAppAsarPath(path: string): string | null {
  const match = /[\\/]app\.asar(?:[\\/]|$)/.exec(path);
  return match ? path.slice(0, match.index) : null;
}

export function juggleworkPluginPath(name: string, here = dirname(fileURLToPath(import.meta.url))): string {
  const resourcesPath = resourcesPathFromAppAsarPath(here);
  if (resourcesPath) {
    const electronResourcesPath = process.resourcesPath?.includes("app.asar") ? resourcesPath : process.resourcesPath?.trim();
    return join(electronResourcesPath || resourcesPath, "opencode-plugins", `${name}.js`);
  }

  const extension = basename(here) === "dist" ? "js" : "ts";
  return join(here, "opencode-plugins", `${name}.${extension}`);
}

export const juggleworkExtensionsPreviewPluginPath = () => juggleworkPluginPath("jugglework-extensions-preview");
export const juggleworkCapabilitiesKnowledgePluginPath = () => juggleworkPluginPath("jugglework-capabilities-knowledge");
export const juggleworkAnthropicAdaptiveThinkingPluginPath = () => juggleworkPluginPath("jugglework-anthropic-adaptive-thinking");
export const juggleworkAnthropicToolSchemaPluginPath = () => juggleworkPluginPath("jugglework-anthropic-tool-schema");
export const juggleworkOfficeAttachmentsPluginPath = () => juggleworkPluginPath("jugglework-office-attachments");
export const juggleworkSafeGrepPluginPath = () => juggleworkPluginPath("jugglework-safe-grep");

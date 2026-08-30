import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { resolveCloudImportedPluginReadiness } from "../src/app/cloud/import-state";

const modalSource = readFileSync(
  new URL("../src/react-app/domains/settings/pages/marketplace-package-detail-modal.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../src/react-app/domains/settings/state/extensions-store.ts", import.meta.url),
  "utf8",
);
const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");
const scrollAreaSource = readFileSync(new URL("../src/components/ui/scroll-area.tsx", import.meta.url), "utf8");

const canonicalStates = [
  "not_installed",
  "installing",
  "current",
  "update_available",
  "partial",
  "needs_signin",
  "needs_admin",
  "failed",
  "repair_required",
  "removing",
] as const;

describe("workspace marketplace plugin status UX", () => {
  test("renders structured install and Cloud readiness states instead of unconditional connected", () => {
    expect(modalSource).toContain('t(`marketplace.lifecycle_${lifecycle.state}`)');
    expect(modalSource).toContain('component.state === "needs_signin"');
    expect(modalSource).toContain('importedFile?.outcome === "needs_admin_setup"');
    expect(modalSource).toContain("file.errorMessage");
    expect(modalSource).toContain("lifecycle.primaryAction");
    expect(modalSource).toContain("lifecycle.secondaryAction");
  });

  test("uses warning/error toast severity and has English and Chinese copy", () => {
    for (const key of canonicalStates) {
      expect(zh).toContain(`marketplace.lifecycle_${key}`);
      expect(en).toContain(`marketplace.lifecycle_${key}`);
      expect(zh).toContain(`marketplace.summary_${key}`);
      expect(en).toContain(`marketplace.summary_${key}`);
      expect(zh).toContain(`marketplace.footer_${key}`);
      expect(en).toContain(`marketplace.footer_${key}`);
    }
    for (const key of ["install", "update", "continue", "retry", "sign_in", "repair", "force_resync"]) {
      expect(zh).toContain(`marketplace.action_${key}`);
      expect(en).toContain(`marketplace.action_${key}`);
    }
    for (const key of ["cloud_only", "desktop_only", "mixed"]) {
      expect(zh).toContain(`marketplace.delivery_${key}`);
      expect(en).toContain(`marketplace.delivery_${key}`);
    }
  });

  test("restores persisted member and admin readiness outcomes", () => {
    const file = {
      configObjectId: "object-1",
      versionId: null,
      objectType: "mcp",
      title: "Connector",
      path: "cloud:connector",
      updatedAt: null,
    };
    expect(resolveCloudImportedPluginReadiness([{ ...file, outcome: "needs_signin" }])).toBe("needs_signin");
    expect(resolveCloudImportedPluginReadiness([
      { ...file, outcome: "needs_signin" },
      { ...file, configObjectId: "object-2", outcome: "needs_admin_setup" },
    ])).toBe("needs_admin_setup");
    expect(resolveCloudImportedPluginReadiness([{ ...file, outcome: "installed_local" }])).toBeNull();
  });

  test("keeps expanded technical details inside a bounded scroll viewport", () => {
    expect(modalSource).not.toContain('ScrollAreaViewport className="h-auto!');
    expect(modalSource).toContain("<ScrollAreaContent>");
    expect(modalSource).toContain("max-h-[calc(100dvh-2rem)]");
    expect(modalSource).toContain("[overflow-wrap:anywhere]");
    expect(modalSource).toContain('className="min-w-0 break-words"');
    expect(scrollAreaSource).toContain("ScrollAreaPrimitive.Content");
    expect(scrollAreaSource).toContain("style={{ minWidth: 0, ...style }}");
  });

  test("Claude installs use the captured workspace and structured marketplace mutation path", () => {
    expect(storeSource).toContain("async function installClaudePlugin(url: string): Promise<CloudPluginMutationResult>");
    expect(storeSource).toContain("const operation = captureWorkspacePluginOperationContext();");
    expect(storeSource).toContain("operation.client.installClaudePlugin(operation.workspaceId, { url })");
    expect(storeSource).toContain("await refreshWorkspaceAfterCloudPluginMutation(operation, result)");
    expect(storeSource).toContain("mutationResult.ok = isClaudePluginMutationSuccessful({ ...result, warnings })");
  });
});

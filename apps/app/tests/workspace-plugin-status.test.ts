import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { resolveCloudImportedPluginReadiness } from "../src/app/cloud/import-state";

const source = readFileSync(
  new URL("../src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx", import.meta.url),
  "utf8",
);
const storeSource = readFileSync(
  new URL("../src/react-app/domains/settings/state/extensions-store.ts", import.meta.url),
  "utf8",
);
const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("../src/i18n/locales/en.ts", import.meta.url), "utf8");

describe("workspace marketplace plugin status UX", () => {
  test("renders structured install and Cloud readiness states instead of unconditional connected", () => {
    expect(source).toContain('row.imported?.status === "repair_required"');
    expect(source).toContain('row.imported?.status === "partial"');
    expect(source).toContain('case "needs_signin"');
    expect(source).toContain('case "needs_admin_setup"');
    expect(source).toContain("connected={cloudBuiltIn || !readinessLabel}");
    expect(source).toContain("file.errorMessage");
  });

  test("uses warning/error toast severity and has English and Chinese copy", () => {
    expect(source).toContain('result.status === "partial"');
    expect(source).toContain('result.status === "repair_required"');
    for (const key of ["partial", "failed", "repair_required", "needs_signin", "needs_admin", "not_synced"]) {
      expect(zh).toContain(`marketplace.plugin_status_${key}`);
      expect(en).toContain(`marketplace.plugin_status_${key}`);
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

  test("Claude installs use the captured workspace and structured marketplace mutation path", () => {
    expect(storeSource).toContain("async function installClaudePlugin(url: string): Promise<CloudPluginMutationResult>");
    expect(storeSource).toContain("const operation = captureWorkspacePluginOperationContext();");
    expect(storeSource).toContain("operation.client.installClaudePlugin(operation.workspaceId, { url })");
    expect(storeSource).toContain("await refreshWorkspaceAfterCloudPluginMutation(operation)");
    expect(storeSource).toContain("ok: isClaudePluginMutationSuccessful({ ...result, warnings })");
  });
});

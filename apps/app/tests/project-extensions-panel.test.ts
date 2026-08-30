import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const panel = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/project-extensions-panel.tsx", import.meta.url), "utf8");
const connectorModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/connector-picker-modal.tsx", import.meta.url), "utf8");
const skillsModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/skills-manager-modal.tsx", import.meta.url), "utf8");
const skillDetail = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/skill-detail-modal.tsx", import.meta.url), "utf8");
const settingsRoute = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
const extensionsStore = readFileSync(new URL("../src/react-app/domains/settings/state/extensions-store.ts", import.meta.url), "utf8");
const marketplaceView = readFileSync(new URL("../src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx", import.meta.url), "utf8");
const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");

describe("session project settings panel", () => {
  test("uses the concise Settings title", () => {
    expect(zh).toMatch(/"project_extensions\.panel_title": "设置"/);
  });

  test("only shows instructions, connectors and skills", () => {
    expect(panel).toMatch(/project_extensions\.group_instruction/);
    expect(panel).toMatch(/project_extensions\.group_connector/);
    expect(panel).toMatch(/project_extensions\.group_skill/);
    expect(panel).not.toMatch(/project_extensions\.group_expert/);
    expect(panel).not.toMatch(/project_extensions\.group_automation/);
  });

  test("does not render a skill avatar preview row", () => {
    expect(panel).not.toMatch(/SkillAvatar|skillPreview/);
    expect(panel).toMatch(/description=\{t\("project_extensions\.skill_card_desc"\)\}/);
  });

  test("shows the captured workspace installed marketplace plugin count", () => {
    expect(settingsRoute).toContain("installedMarketplacePluginCount={Object.keys(extensionsSnapshot.importedCloudPlugins).length}");
    expect(panel).toContain("count={props.installedMarketplacePluginCount || undefined}");
  });

  test("gates unsupported and read-only marketplace mutations before requests", () => {
    expect(extensionsStore).toContain("if (!operation.access.allowed)");
    expect(extensionsStore).toContain("throw new Error(workspacePluginAccessMessage(operation.access.reason))");
    expect(extensionsStore.indexOf("if (!operation.access.allowed)")).toBeLessThan(
      extensionsStore.indexOf("client.getOrgPluginResolved(orgId, plugin)"),
    );
    expect(marketplaceView).toContain("disabled={actionBusy || !marketplacePluginAccess.allowed}");
    expect(marketplaceView).toContain("row.imported && marketplacePluginAccess.allowed");
  });

  test("fences imported plugin refreshes and mutation completion by workspace context", () => {
    expect(extensionsStore).toContain("const operation = context ?? captureWorkspacePluginOperationContext()");
    expect(extensionsStore).toContain("isCurrentImportedCloudPluginLoad(operation, loadKey)");
    expect(extensionsStore).toContain("await operation.client.installCloudPlugin(operation.workspaceId");
    expect(extensionsStore).toContain("await operation.client.removeCloudPlugin(operation.workspaceId");
    expect(extensionsStore).toContain("if (isCurrentWorkspacePluginContext(operation)) options.setBusy(false)");
  });

  test("shows global and workspace skills while keeping global skills read-only", () => {
    expect(settingsRoute).toContain("const sessionSkills = extensionsSnapshot.skills");
    expect(settingsRoute).toContain("installedSkills={sessionSkills}");
    expect(settingsRoute).not.toContain("const projectSkills = extensionsSnapshot.skills.filter");
    expect(skillsModal).toContain("{!isGlobal ? (");
    expect(skillsModal).toContain('if (target && target.scope !== "global") onUninstall(target.name)');
    expect(skillsModal).not.toContain("project_extensions.uninstall_global_warning");
    expect(skillDetail).toContain('skill.scope === "global" ? "project_extensions.scope_global" : "project_extensions.scope_workspace"');
    expect(panel).toContain("const visibleSkillCount = props.installedSkills.length");
  });

  test("shows connected and workspace-disabled MCP groups without an unconnected group", () => {
    expect(panel).not.toContain("connectorContentSlot");
    expect(connectorModal).not.toContain('value="organization"');
    expect(connectorModal).not.toContain("connector_tab_organization");
    expect(connectorModal).toContain("row.workspaceScope");
    expect(connectorModal).toContain("<Switch");
    expect(connectorModal).toContain('t("connect.workspace_disabled_here")');
    expect(connectorModal).toContain("project_extensions.workspace_disabled_group");
    expect(connectorModal).not.toContain("project_extensions.unconnected_group");
    expect(connectorModal).toContain("row.workspaceScope?.enabled === false");
  });

  test("renders MCP rows in a wide, scroll-safe two-column dialog", () => {
    expect(connectorModal).toContain("sm:max-w-[1000px]");
    expect(connectorModal).toContain("h-[85vh]");
    expect(connectorModal).toContain('data-connector-layout="two-column"');
    expect(connectorModal).toContain("md:grid-cols-[repeat(2,minmax(0,1fr))]");
  });

  test("uses soft workspace policy for runtime MCP switches without calling enabled config", () => {
    expect(settingsRoute).toContain("workspaceMcpToolPolicy.setServerEnabled");
    expect(settingsRoute).toContain('row.mcpSource === "config.global"');
    expect(settingsRoute).toContain('row.mcpSource === "config.project"');
    expect(settingsRoute).not.toContain("workspaceScope: server.source ===");
  });
});

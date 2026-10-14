import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const panel = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/project-extensions-panel.tsx", import.meta.url), "utf8");
const connectorModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/connector-picker-modal.tsx", import.meta.url), "utf8");
const skillsModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/skills-manager-modal.tsx", import.meta.url), "utf8");
const pluginsModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/plugins-manager-modal.tsx", import.meta.url), "utf8");
const panelTypes = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/types.ts", import.meta.url), "utf8");
const skillDetail = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/skill-detail-modal.tsx", import.meta.url), "utf8");
const settingsRoute = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
const extensionsStore = readFileSync(new URL("../src/react-app/domains/settings/state/extensions-store.ts", import.meta.url), "utf8");
const marketplaceView = readFileSync(new URL("../src/react-app/domains/settings/pages/cloud-marketplaces-view.tsx", import.meta.url), "utf8");
const marketplaceModal = readFileSync(new URL("../src/react-app/domains/settings/pages/marketplace-package-detail-modal.tsx", import.meta.url), "utf8");
const zh = readFileSync(new URL("../src/i18n/locales/zh.ts", import.meta.url), "utf8");

describe("session project settings panel", () => {
  test("uses the concise Settings title", () => {
    expect(zh).toMatch(/"project_extensions\.panel_title": "设置"/);
  });

  test("shows instructions, connectors, skills and scoped plugins", () => {
    expect(panel).toMatch(/project_extensions\.group_instruction/);
    expect(panel).toMatch(/project_extensions\.group_connector/);
    expect(panel).toMatch(/project_extensions\.group_skill/);
    expect(panel).toMatch(/project_extensions\.group_plugin/);
    expect(panel).toContain("<PluginsManagerModal");
    expect(panel).not.toMatch(/project_extensions\.group_expert/);
    expect(panel).not.toMatch(/project_extensions\.group_automation/);
  });

  test("does not render a skill avatar preview row", () => {
    expect(panel).not.toMatch(/SkillAvatar|skillPreview/);
    expect(panel).toMatch(/description=\{t\("project_extensions\.skill_card_desc"\)\}/);
  });

  test("keeps marketplace browsing out of workspace settings", () => {
    const embeddedBranch = settingsRoute.slice(
      settingsRoute.indexOf("if (props.embedded)"),
      settingsRoute.indexOf("return (\n          <ExtensionsView", settingsRoute.indexOf("if (props.embedded)")),
    );
    expect(embeddedBranch).not.toContain("installedMarketplacePluginCount");
    expect(embeddedBranch).not.toContain("pluginsSlot");
    expect(embeddedBranch).not.toContain("onRefreshPlugins");
  });

  test("gates unsupported and read-only marketplace mutations before requests", () => {
    expect(extensionsStore).toContain("if (!operation.access.allowed)");
    expect(extensionsStore).toContain("throw new Error(workspacePluginAccessMessage(operation.access.reason))");
    expect(extensionsStore.indexOf("if (!operation.access.allowed)")).toBeLessThan(
      extensionsStore.indexOf("client.getOrgPluginResolved(orgId, plugin)"),
    );
    expect(marketplaceView).toContain("canMutate={!applicationCatalog && marketplacePluginAccess.allowed}");
    expect(marketplaceModal).toContain("isMarketplacePluginActionDisabled(primary");
    expect(marketplaceModal).toContain("lifecycle.hasLocalLedger && !cloudBuiltIn");
  });

  test("fences imported plugin refreshes and mutation completion by workspace context", () => {
    expect(extensionsStore).toContain("const operation = context ?? captureWorkspacePluginOperationContext()");
    expect(extensionsStore).toContain("isCurrentImportedCloudPluginLoad(operation, loadKey)");
    expect(extensionsStore).toContain("await operation.client.installCloudPlugin(operation.workspaceId");
    expect(extensionsStore).toContain("await operation.client.removeCloudPlugin(operation.workspaceId");
    expect(extensionsStore).toContain("if (isCurrentWorkspacePluginContext(operation)) options.setBusy(false)");
  });

  test("preserves scoped last-known-good data and exposes fenced mutation operations", () => {
    expect(extensionsStore).toContain("importedCloudPluginsContextKey === operation.cloudKey");
    expect(extensionsStore).toContain("cloudOrgMarketplacesContextKey === loadKey ? current.cloudOrgMarketplaces : []");
    expect(extensionsStore).toContain("cloudOrgMarketplacesContextKey === loadKey ? current.cloudOrgPlugins : []");
    expect(extensionsStore).toContain("marketplacePluginOperations: state.marketplacePluginOperations");
    expect(extensionsStore).toContain("isWorkspacePluginOperationCurrent({");
    expect(extensionsStore).toContain("applyCloudPluginMutationResult(operation, result");
    expect(extensionsStore).toContain("dismissMarketplacePluginOperation");
  });

  test("uses read-only refreshes for an unchanged graph", () => {
    expect(extensionsStore).toContain('if (result?.changed === false || optionsOverride?.authoritativeReadOnly)');
    expect(extensionsStore).toContain("mutateDesktopCloudSync: false");
    expect(extensionsStore).toContain("refreshCloudOrgMarketplaces({ force: true, refreshImported: false })");
    expect(extensionsStore.indexOf('if (result?.changed === false || optionsOverride?.authoritativeReadOnly)')).toBeLessThan(
      extensionsStore.indexOf("options.refreshWorkspaceCapabilities?.(context.key)"),
    );
  });

  test("clears cloud projections synchronously when workspace or organization context changes", () => {
    expect(extensionsStore).toContain("const cloudKey = getCloudContextKey()");
    expect(extensionsStore).toContain("cloudOrgMarketplaces: []");
    expect(extensionsStore).toContain("cloudOrgPlugins: []");
    expect(extensionsStore).toContain("importedCloudMarketplaces: {}");
    expect(extensionsStore).toContain("importedCloudPlugins: {}");
    expect(extensionsStore).toContain("pendingCloudPluginChanges: {}");
    expect(extensionsStore).toContain("operationContextKey: context.cloudKey");
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

  test("keeps disabled skills visible and provides workspace switches for both scopes only when available", () => {
    expect(panelTypes).toContain("workspaceSkillPolicy?: WorkspaceSkillPolicy");
    expect(panelTypes).toContain('"available" | "disabledSkillNames" | "savingName" | "error" | "setSkillEnabled"');
    expect(skillsModal).toContain("if (!keyword) return skills");
    expect(skillsModal).toContain("disabledSkillNames.includes(skill.name)");
    expect(skillsModal).toContain('t(isGlobal ? "project_extensions.scope_global" : "project_extensions.scope_workspace")');
    expect(skillsModal).toContain('t("connect.workspace_disabled_here")');
    expect(skillsModal).toContain("workspaceSkillPolicy?.available ? (");
    expect(skillsModal).toContain("checked={!disabledHere}");
    expect(skillsModal).toContain("disabled={workspaceSkillPolicy.savingName === skill.name}");
    expect(skillsModal).toContain("workspaceSkillPolicy.setSkillEnabled(skill.name, enabled)");
    expect(skillsModal).toContain('aria-label={t("connect.workspace_toggle_label", { name: skill.name })}');
    expect(skillsModal).toContain('workspaceSkillPolicy?.error ? (');
    expect(skillsModal).toContain('role="alert"');
    expect(skillsModal).toContain("onClick={(event) => event.stopPropagation()}");
    expect(skillsModal).toContain("onKeyDown={(event) => event.stopPropagation()}");
    expect(skillsModal.indexOf("workspaceSkillPolicy?.available ? (")).toBeLessThan(skillsModal.indexOf("{!isGlobal ? ("));
    expect(settingsRoute).toContain("useWorkspaceSkillPolicy({ client: policyClient, workspaceId: runtimeWorkspaceId })");
    expect(settingsRoute).toContain("workspaceSkillPolicy={workspaceSkillPolicy}");
    expect(panel).toContain("workspaceSkillPolicy={props.workspaceSkillPolicy}");
  });

  test("lists global and workspace plugins but only switches runtime-controllable specs", () => {
    expect(settingsRoute).toContain("listPlugins(runtimeWorkspaceId, { includeGlobal: true })");
    expect(settingsRoute).toContain("workspacePluginPolicy={workspacePluginPolicy}");
    expect(settingsRoute).toContain("plugins={workspaceVisiblePlugins}");
    expect(pluginsModal).toContain('plugin.scope === "global"');
    expect(pluginsModal).toContain("policy.controllablePluginSpecs.includes(plugin.spec)");
    expect(pluginsModal).toContain("policy?.setPluginEnabled(plugin.spec!, enabled)");
    expect(pluginsModal).toContain("project_extensions.plugin_policy_unavailable");
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

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const panel = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/project-extensions-panel.tsx", import.meta.url), "utf8");
const connectorModal = readFileSync(new URL("../src/react-app/domains/settings/pages/project-extensions/connector-picker-modal.tsx", import.meta.url), "utf8");
const settingsRoute = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
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
    expect(settingsRoute).toContain('row.mcpSource === "config.project"');
    expect(settingsRoute).not.toContain("workspaceScope: server.source ===");
  });
});

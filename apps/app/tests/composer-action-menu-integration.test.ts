import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const composerPath = fileURLToPath(
  new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url),
);

describe("composer action menus", () => {
  test("anchors the plus and slash surfaces to the full composer width above the input", () => {
    const source = readFileSync(composerPath, "utf8");

    expect(source.match(/bottom-\[calc\(100%\+8px\)\] left-\[-1px\] right-\[-1px\]/g)?.length).toBe(2);
    expect(source).toContain('aria-haspopup="menu"');
    expect(source).not.toContain('left-[18.5rem]');
    expect(source).not.toContain("plusMenuToolEntries");
  });

  test("renders flat Add, Plugins, and MCP groups with direct actions", () => {
    const source = readFileSync(composerPath, "utf8");
    const plusMenu = source.slice(source.indexOf("const renderPlusMenu"), source.indexOf("const renderSlashMenu"));

    expect(plusMenu).toContain('id: "add"');
    expect(plusMenu).toContain('id: "plugins"');
    expect(plusMenu).toContain('id: "mcp"');
    expect(plusMenu).toContain("activatePlusEntry(entry)");
    expect(plusMenu).toContain("entry.description");
  });

  test("keeps add and slash menu rows compact while preserving clear group rhythm", () => {
    const source = readFileSync(composerPath, "utf8");
    const plusMenu = source.slice(source.indexOf("const renderPlusMenu"), source.indexOf("const renderSlashMenu"));
    const slashMenu = source.slice(source.indexOf("const renderSlashMenu"), source.indexOf("const renderMentionMenu"));

    expect(plusMenu).toContain("overflow-y-auto p-1");
    expect(plusMenu).toContain('groupIndex > 0 ? "mt-1"');
    expect(plusMenu).toContain('className="grid gap-0"');
    expect(plusMenu).toContain("min-h-8 w-full min-w-0 items-center gap-1.5 rounded-[13px] px-1.5 py-1");
    expect(plusMenu).toContain('text-[13px] font-medium text-gray-12');
    expect(plusMenu).toContain('truncate text-[13px] text-gray-9');
    expect(slashMenu).toContain("overflow-y-auto p-1");
    expect(slashMenu).toContain('groupIndex > 0 ? "mt-1"');
    expect(slashMenu).toContain('className="grid gap-0"');
    expect(slashMenu).toContain("min-h-8 w-full min-w-0 items-center gap-1.5 rounded-[13px] px-1.5 py-1");
    expect(slashMenu).toContain('text-[13px] font-medium text-gray-12');
    expect(slashMenu).toContain('truncate text-[13px] text-gray-9');
    expect(slashMenu).toContain('text-[11px] text-gray-9');
  });

  test("groups slash results into commands and skills while preserving one keyboard order", () => {
    const source = readFileSync(composerPath, "utf8");
    const slashMenu = source.slice(source.indexOf("const renderSlashMenu"), source.indexOf("const renderMentionMenu"));

    expect(source).toContain("const slashCommandFiltered");
    expect(source).toContain("const slashSkillFiltered");
    expect(source).toContain("() => [...slashCommandFiltered, ...slashSkillFiltered]");
    expect(slashMenu).toContain('id: "commands"');
    expect(slashMenu).toContain('id: "skills"');
    expect(slashMenu).toContain("command.skill?.scope");
    expect(source).toContain("const command = slashFiltered[menuIndex]");
  });

  test("localizes built-in command presentation without changing command execution names", () => {
    const source = readFileSync(composerPath, "utf8");

    expect(source).toContain('type BuiltinSlashCommandName = "new" | "compact" | "init" | "review"');
    expect(source).toContain("slashCommandLabel(command, isSkill)");
    expect(source).toContain("slashCommandDescription(command, isSkill)");
    expect(source).toContain("slashCommandIcon(command, isSkill)");
    expect(source).toContain("props.onDraftChange(`/${command.name} `)");
    expect(source).toContain("<MessageCirclePlus");
    expect(source).toContain("<Minimize2");
    expect(source).toContain("<FileCog");
    expect(source).toContain("<ScanSearch");
  });

  test("keeps installed unavailable connectors visible and uses only localized status text", () => {
    const source = readFileSync(composerPath, "utf8");
    const rows = source.slice(source.indexOf("const activeMcpItems"), source.indexOf("const plusMenuEntries"));
    expect(rows).toContain("mcpServers.map");
    expect(rows).toContain("composerMcpStatus(entry, mcpStatuses)");
    expect(rows).toContain("connectorReadiness(entry.config, mcpStatuses[entry.id ?? entry.name]).hint");
    expect(rows).toContain('t("connect.workspace_disabled_here")');
    expect(rows).not.toContain("entry.config.url");
    expect(rows).not.toContain("entry.config.command");
    expect(source).not.toContain("detail.error");
    expect(source).not.toContain("mcpStatusTooltip");
    expect(source).toContain('case "pending":\n      return t("mcp.friendly_status_pending")');
    expect(source).toContain("title={disabledTitle ?? entry.description}");
    expect(source).toContain("const disabled = unavailableMcp");
    expect(source).toContain("disabled={disabled}");
    expect(source).toContain('if (status !== "connected" || entry.workspaceEnabled === false || entry.config.enabled === false) return;');
  });

  test("routes connector management through the existing settings callback for click and keyboard activation", () => {
    const source = readFileSync(composerPath, "utf8");
    expect(source).toContain('if (props.onOpenSettings) {\n    plusMenuMcpEntries.push({');
    expect(source).toContain('label: t("composer.plus_menu_manage_connectors")');
    expect(source).toContain('if (entry.kind === "mcp-management") {\n      setPlusMenuOpen(false);\n      props.onOpenSettings?.();\n      return;');
    expect(source).toContain("if (entry) activatePlusEntry(entry)");
    expect(source).toContain("onClick={() => activatePlusEntry(entry)}");
    expect(source).toContain('group.entries.every((entry) => entry.kind === "mcp-management")');

    const session = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8");
    expect(session).toContain('onOpenSettings={props.onOpenSettingsSection ? () => props.onOpenSettingsSection?.("mcps") : undefined}');
    expect(session).toContain("servers: selectComposerInstalledMcpEntries(merged.servers)");
    expect(session).toContain("const servers = projected.servers");
    expect(session).not.toContain("selectComposerAvailableMcpEntries");
    expect(session).not.toContain("MCP_QUICK_CONNECT");
    expect(session).toContain("listAssignedConnectCapabilities({ client, organizationId })");
    expect(session).toContain(".getMcpWorkspacePolicy(organizationId, workspaceKey)");

    const route = readFileSync(new URL("../src/react-app/shell/session-route.tsx", import.meta.url), "utf8");
    expect(route).toContain('section === "mcps" ? "/settings/extensions/mcp"');
    const settings = readFileSync(new URL("../src/react-app/shell/settings-route.tsx", import.meta.url), "utf8");
    expect(settings).toContain('if (tail === "mcp") return { tab: "extensions", redirectPath: null, extensionsSection: "mcp" }');
  });
});

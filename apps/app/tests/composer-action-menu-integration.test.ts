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
});

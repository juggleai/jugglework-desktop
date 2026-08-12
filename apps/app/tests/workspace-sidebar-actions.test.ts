import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");

describe("workspace sidebar actions", () => {
  test("keeps workspace actions hidden until hover and creates sessions from the plus button", () => {
    expect(source).toMatch(/data-workspace-actions[\s\S]+<Plus className="size-4"/);
    expect(source).toMatch(/opacity-0[\s\S]+group-hover\/workspace-header:opacity-100/);
    expect(source).toMatch(/ctx\.onCreateTaskInWorkspace\(workspace\.id\)/);
  });

  test("keeps New Session out of the overflow menu and restores Share below Edit name", () => {
    const menu = source.slice(source.indexOf("function WorkspaceActionsMenu"), source.indexOf("function RemoteConnectionIssueCard"));
    expect(menu).not.toMatch(/onCreateTaskInWorkspace|cmd_new_session_title/);
    expect(menu.indexOf('t("workspace_list.edit_name")')).toBeLessThan(menu.indexOf('t("workspace_list.share")'));
    expect(menu).toMatch(/<Share2 className="size-4"/);
  });

  test("locks the restored workspace menu labels to the original text size", () => {
    const menu = source.slice(source.indexOf("function WorkspaceActionsMenu"), source.indexOf("function RemoteConnectionIssueCard"));
    expect(menu).toMatch(/DropdownMenuItem className="text-sm"[\s\S]+workspace_list\.edit_name/);
    expect(menu).toMatch(/DropdownMenuItem className="text-sm"[\s\S]+workspace_list\.share/);
  });
});

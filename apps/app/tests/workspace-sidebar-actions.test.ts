import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");
const progressSource = readFileSync(new URL("../src/react-app/domains/session/sidebar/session-circular-progress.tsx", import.meta.url), "utf8");

describe("workspace sidebar actions", () => {
  test("keeps workspace actions hidden until hover and creates sessions from the plus button", () => {
    expect(source).toMatch(/data-workspace-actions[\s\S]+<Plus className="size-4"/);
    expect(source).toMatch(/opacity-0[\s\S]+group-hover\/workspace-header:opacity-100/);
    expect(source).toMatch(/ctx\.onCreateTaskInWorkspace\(workspace\.id\)/);
    expect(source).toMatch(/group-hover\/workspace-header:pr-10/);
    expect(source).toMatch(/group-has-data-popup-open\/workspace-header:pr-10/);
    expect(source).toMatch(/showActivity \? "pr-6" : "pr-0"/);
    expect(source).not.toMatch(/showActivity \? "pr-14" : "pr-7"/);
  });

  test("swaps collapsed-workspace loading and hover actions in the same trailing slot", () => {
    // 点击行会留下 DOM 焦点，focus-within 曾导致加号/三个点在鼠标移走后常驻 —— 必须只用 :focus-visible。
    expect(source).not.toMatch(/group-focus-within\/workspace-header/);
    // 悬停 / 菜单打开 / 键盘聚焦时：loading 淡出，操作图标淡入并恢复指针事件。
    expect(source).toMatch(/group-hover\/workspace-header:opacity-0/);
    expect(source).toMatch(/group-has-data-popup-open\/workspace-header:opacity-0/);
    expect(source).toMatch(/group-has-\[:focus-visible\]\/workspace-header:opacity-100/);
    expect(source).toMatch(/opacity-0 pointer-events-none transition-opacity[\s\S]+group-hover\/workspace-header:pointer-events-auto/);
    // loading 与操作图标同锚点叠放（绝对定位），切换时行内布局零抖动。
    expect(source).toMatch(/absolute right-1 top-1\/2 -translate-y-1\/2/);
  });

  test("swaps active-session loading and hover actions in the same trailing slot", () => {
    expect(source).not.toMatch(/group-focus-within\/menu-sub-item/);
    expect(source).toMatch(/data-session-loading-indicator/);
    expect(source).toMatch(/data-session-loading-indicator[\s\S]+absolute right-2\.5 top-1\/2/);
    expect(source).toMatch(/data-session-loading-indicator[\s\S]+group-hover\/menu-sub-item:opacity-0/);
    expect(source).toMatch(/data-session-loading-indicator[\s\S]+group-has-data-popup-open\/menu-sub-item:opacity-0/);
    expect(source).toMatch(/data-session-hover-actions[\s\S]+group-hover\/menu-sub-item:opacity-100/);
    expect(source).toMatch(/data-session-hover-actions[\s\S]+group-has-\[:focus-visible\]\/menu-sub-item:pointer-events-auto/);
  });

  test("renders every session/workspace loading indicator in white in dark mode", () => {
    const indicator = source.slice(
      source.indexOf("function SessionLoadingIndicator"),
      source.indexOf("interface SessionOutcomeIndicatorProps"),
    );

    expect(indicator).toMatch(/<SessionCircularProgress className="dark:text-white" \/>/);
    expect(progressSource).toContain("text-dls-accent dark:text-white");
    // The collapsed workspace and rail use the bare shared indicator, so they
    // inherit this dark-mode contrast rule instead of drifting independently.
    expect(source).toMatch(/showWorkspaceActivity[\s\S]+<SessionCircularProgress \/>/);
  });

  test("keeps the empty left lane after moving session loading to the trailing slot", () => {
    expect(source).toMatch(/const LEFT_ACTIVITY_SLOT = "flex size-4 shrink-0 items-center justify-center"/);
    expect(source).toMatch(/const leading = \([\s\S]+aria-hidden="true" className=\{LEFT_ACTIVITY_SLOT\}/);
    expect(source).not.toMatch(/className=\{LEFT_ACTIVITY_SLOT\} role="status"/);
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

  test("uses compact 32px rows, removes workspace session counts, and keeps 2px item gaps", () => {
    const header = source.slice(source.indexOf("type WorkspaceHeaderProps"), source.indexOf("type WorkspaceSidebarGroupProps"));
    expect(header).toMatch(/relative h-8/);
    expect(header).not.toMatch(/sessionCount/);
    expect(source).toMatch(/relative h-8 rounded-\[11px\]/);
    expect(source).toMatch(/flex flex-col gap-0\.5/);
    expect(source).toMatch(/SidebarMenuSub className="[^"]*gap-0\.5/);
  });

  test("does not reopen a manually collapsed workspace during an ordinary rerender", () => {
    expect(source).toMatch(/const autoExpandedWorkspaceIdRef = React\.useRef\(""\)/);
    expect(source).toMatch(/autoExpandedWorkspaceIdRef\.current === id/);
    expect(source).toMatch(/autoExpandedWorkspaceIdRef\.current = id;[\s\S]+expandWorkspace\(id\)/);
  });

  test("keeps completion aggregation limited to accessible main sessions", () => {
    expect(source).toMatch(/const accessibleMainSessionIds = new Set/);
    expect(source).toMatch(/\.reconcile\([\s\S]+accessibleMainSessionIds/);
    expect(source).toMatch(/flatMap\(\(group\) => group\.sessions\.filter\(isMainSession\)\)/);
  });

  test("clears an orange attention marker when the session is opened", () => {
    const menuItem = source.slice(source.indexOf("function SessionMenuItem"), source.indexOf("if (!reorderable) return item"));
    expect(menuItem).toContain("useAcknowledgedAttentionSessionIds()");
    expect(menuItem).toContain("&& !acknowledgedAttentionSessionIds.has(session.id)");
    expect(menuItem).toContain("if (isNeedsAttentionSessionStatus(sessionActivityStatus))");
    expect(menuItem).toContain("acknowledgeAttention(session.id)");
    expect(menuItem).toContain("status={needsAttention ? sessionActivityStatus : undefined}");
  });

  test("keeps automation-managed workspaces out of the local workspace sidebar", () => {
    expect(source).toMatch(/sidebarWorkspaceSessionGroups = React\.useMemo\([\s\S]+!group\.workspace\.automationManaged/);
    expect(source).toMatch(/const inScope = sidebarWorkspaceSessionGroups\.filter/);
    expect(source).toMatch(/resolveWorkspaceSessionIndicator\([\s\S]+sidebarWorkspaceSessionGroups/);
  });
});

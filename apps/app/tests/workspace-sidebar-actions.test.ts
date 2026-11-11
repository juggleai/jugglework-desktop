import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const source = readFileSync(new URL("../src/react-app/domains/session/sidebar/app-sidebar.tsx", import.meta.url), "utf8");
const progressSource = readFileSync(new URL("../src/react-app/domains/session/sidebar/session-circular-progress.tsx", import.meta.url), "utf8");

describe("workspace sidebar actions", () => {
  test("splits local navigation into collapsible projects and a cross-workspace recent list", () => {
    expect(source).toContain("<LocalProjectsSection");
    expect(source).toContain("<LocalRecentSessions");
    expect(source).toContain("entries={recentSessions}");
    expect(source).toContain('taskScope === "local"');
    expect(source).toContain('t("workspace_list.projects")');
    expect(source).toContain('t("workspace_list.recent")');
    expect(source).toMatch(/function LocalProjectsSection[\s\S]+<Collapsible open=\{expanded\} onOpenChange=\{onExpandedChange\}/);
    expect(source).toMatch(/function LocalProjectsSection[\s\S]+<WorkspaceReorderItem/);
    expect(source).toContain("onAddWorkspace={props.onOpenCreateLocalWorkspace}");
    expect(source).toMatch(/function LocalRecentSessionItem[\s\S]+workspaceName=\{workspaceLabel\(entry\.group\.workspace\)\}/);
    expect(source).toMatch(/function LocalRecentSessions[\s\S]+<Collapsible open=\{expanded\} onOpenChange=\{onExpandedChange\}/);
    expect(source).toMatch(/function LocalRecentSessionItem[\s\S]+showWorkspaceIcon=\{false\}[\s\S]+flushLeft/);
  });

  test("opens the existing local workspace dialog from the projects heading hover action", () => {
    const projects = source.slice(source.indexOf("function LocalProjectsSection("), source.indexOf("function LocalRecentSessions("));

    expect(projects).toContain("onAddWorkspace: () => void");
    expect(projects).toContain("data-local-projects-add-workspace");
    expect(projects).toContain('aria-label={t("workspace_list.add_workspace")}');
    expect(projects).toContain("group-hover/projects-heading:opacity-100");
    expect(projects).toMatch(/onClick=\{\(event\) => \{[\s\S]+event\.stopPropagation\(\);[\s\S]+onAddWorkspace\(\);/);
  });

  test("aligns and collapses pinned sessions without a reserved leading lane", () => {
    const pinned = source.slice(source.indexOf("function GlobalPinnedSessions("), source.indexOf("type GlobalArchivedSessionEntry"));
    expect(pinned).toContain('className="shrink-0 px-0 pb-1 pt-2"');
    expect(pinned).toContain('<SidebarMenu data-global-pinned-session-list className="px-2">');
    expect(pinned).toContain("<Collapsible open={expanded} onOpenChange={setExpanded}");
    expect(pinned).toContain('? "rotate-90 opacity-0 group-hover/pinned-heading:opacity-100');
    expect(pinned).toContain(': "opacity-100"');
    expect(source).toMatch(/function GlobalPinnedSessionTree[\s\S]+showWorkspaceIcon=\{false\}[\s\S]+flushLeft/);
  });

  test("uses the project workspace horizontal track for pinned and recent rows", () => {
    const projects = source.slice(source.indexOf("function LocalProjectsSection("), source.indexOf("function LocalRecentSessions("));
    const recent = source.slice(source.indexOf("function LocalRecentSessions("), source.indexOf("function LocalRecentSessionItem("));

    const sessionList = source.slice(source.indexOf("function SidebarSessionList("), source.indexOf("function LocalRecentSessions("));

    expect(projects).toContain('<WorkspaceReorderItem');
    // Recent and user sections share one list component on the same track.
    expect(recent).toContain('dataAttribute={{ "data-local-recent-session-list": "" }}');
    expect(sessionList).toContain('<SidebarMenu className="px-2" {...dataAttribute}>');
    expect(source).toContain('<SidebarMenu data-global-pinned-session-list className="px-2">');
  });

  test("offers chat sort and new section from the projects and recent heading menus", () => {
    const projects = source.slice(source.indexOf("function LocalProjectsSection("), source.indexOf("function LocalRecentSessions("));
    const recent = source.slice(source.indexOf("function LocalRecentSessions("), source.indexOf("function LocalSidebarSection("));
    const menu = source.slice(source.indexOf("function SidebarListOptionsMenu("), source.indexOf("function SidebarSectionNameDialog("));

    expect(projects).toContain("<SidebarListOptionsMenu revealClassName={PROJECTS_HEADING_REVEAL} />");
    expect(recent).toContain("<SidebarListOptionsMenu revealClassName={LIST_HEADING_REVEAL} />");
    expect(menu).toContain('t("sidebar_sections.chat_sort")');
    expect(menu).toContain('(["recent", "manual"] as const');
    expect(menu).toContain("<DropdownMenuRadioGroup");
    expect(menu).toContain("setSortMode(value)");
    expect(menu).toContain("data-sidebar-new-section");
    expect(menu).toContain("dialog?.openCreateSection()");
    // Hidden until hover, keyboard focus, or while its own menu is open.
    expect(source).toMatch(/LIST_HEADING_REVEAL = "pointer-events-none opacity-0[^"]+group-has-data-popup-open\/list-heading:opacity-100/);
  });

  test("chat drag reordering is enabled only in manual sort mode", () => {
    expect(source).toContain("reorderable={manualSort && row.depth === 0}");
    expect(source).not.toMatch(/reorderable=\{row\.depth === 0\}/);
    expect(source).toContain("setManualOrder(listId, next)");
  });

  test("always reorders local project workspaces independently from chat sort mode", () => {
    const projects = source.slice(source.indexOf("function LocalProjectsSection("), source.indexOf("// Heading actions stay hidden"));
    const workspaceItem = source.slice(source.indexOf("function WorkspaceReorderItem("), source.indexOf("type WorkspaceHeaderProps"));

    expect(projects).toContain("<Reorder.Group");
    expect(projects).toContain("values={groups.map((group) => group.workspace.id)}");
    expect(projects).toContain("onReorder={onReorderWorkspaces}");
    expect(projects).toContain("<WorkspaceReorderItem");
    expect(projects).not.toContain("manualSort");
    expect(workspaceItem).toContain("dragControls.start(moveEvent)");
    expect(workspaceItem).toContain("onWorkspaceTitlePointerDown={startDragOnThreshold}");
  });

  test("shows the custom-section hover menu and uses Edit to rename the section", () => {
    const section = source.slice(source.indexOf("function LocalSidebarSection("), source.indexOf("function LocalRecentSessionItem("));

    expect(section).toContain("data-sidebar-section-options");
    expect(section).toContain("LIST_HEADING_REVEAL");
    expect(section).toContain('dialog?.openRenameSection(section)');
    expect(section).toContain('t("common.edit")');
    expect(section).toContain('t("sidebar_sections.mark_all_read")');
    expect(section).toContain('t("sidebar_sections.archive_chats")');
    expect(section).toContain('dialog?.openCreateSection()');
    expect(section).toContain('t("sidebar_sections.remove_section")');
    expect(section).toContain("completionStore.clear(session.id)");
    expect(section).toContain("ctx.onArchiveSession(session.id, true)");
  });

  test("allows sessions to be dragged into a custom section independently from chat sort mode", () => {
    const section = source.slice(source.indexOf("function LocalSidebarSection("), source.indexOf("function LocalRecentSessionItem("));
    const recentItem = source.slice(source.indexOf("function LocalRecentSessionItem("), source.indexOf("type GlobalArchivedSessionEntry"));
    const dropZone = source.slice(source.indexOf("function SidebarSectionDropZone("), source.indexOf("function LocalRecentSessionItem("));

    expect(section).toContain("<SidebarSectionDropZone sectionId={section.id}>");
    expect(dropZone).toContain("data-sidebar-section-drop-zone={sectionId}");
    expect(dropZone).toContain("event.dataTransfer.types.includes(SESSION_DRAG_TYPE)");
    expect(dropZone).toContain("assignSession(payload.sessionId, sectionId)");
    expect(recentItem).toContain("groupDraggable");
    expect(recentItem).not.toContain('sortMode === "manual"');
    expect(source).toContain("groupDraggable={row.depth === 0}");
  });

  test("removes sectioned sessions from their original project workspace", () => {
    const workspace = source.slice(source.indexOf("function WorkspaceSidebarGroup("), source.indexOf("function GroupedSessionList("));

    expect(workspace).toContain("const sectionedRootIds = React.useMemo");
    expect(workspace).toContain("validSectionIds.has(sectionId)");
    expect(workspace).toContain("const rootsHiddenFromWorkspace = React.useMemo");
    expect(workspace).toContain("{ exclude: rootsHiddenFromWorkspace }");
    expect(workspace).toContain("!rootsHiddenFromWorkspace.has(session.id) && tree.activeIds.has(session.id)");
    expect(workspace).toContain("filter((session) => !rootsHiddenFromWorkspace.has(session.id)).length");
  });

  test("allows Pinned, Projects, Recent, and custom sections to reorder as top-level groups", () => {
    const localGroups = source.slice(source.indexOf('data-sidebar-group-order'), source.indexOf('taskScope !== "local"'));
    const reorderItem = source.slice(source.indexOf("function SidebarGroupReorderItem("), source.indexOf("function LocalProjectsSection("));

    expect(source).toContain("values={sidebarGroupOrder}");
    expect(source).toContain("setGroupOrder(next)");
    expect(localGroups).toContain("PINNED_GROUP_ID");
    expect(localGroups).toContain("PROJECTS_GROUP_ID");
    expect(localGroups).toContain("RECENT_GROUP_ID");
    expect(localGroups).toContain("SECTION_GROUP_PREFIX");
    expect(reorderItem).toContain("dragListener={false}");
    expect(reorderItem).toContain("dragControls.start(event)");
    expect(source).toContain("onTitlePointerDown={onTitlePointerDown}");
  });

  test("keeps disclosure arrows visible while collapsed and hover-only while expanded", () => {
    const projects = source.slice(source.indexOf("function LocalProjectsSection("), source.indexOf("// Heading actions stay hidden"));
    const sharedHeading = source.slice(source.indexOf("function SidebarListHeading("), source.indexOf("function SidebarSessionList("));
    const pinned = source.slice(source.indexOf("function GlobalPinnedSessions("), source.indexOf("type GlobalArchivedSessionEntry"));

    expect(projects).toContain('? "rotate-90 opacity-0 group-hover/projects-heading:opacity-100');
    expect(projects).toContain(': "opacity-100"');
    expect(sharedHeading).toContain('? "rotate-90 opacity-0 group-hover/list-heading:opacity-100');
    expect(sharedHeading).toContain(': "opacity-100"');
    expect(sharedHeading).toContain("expanded: boolean");
    expect(pinned).toContain('? "rotate-90 opacity-0 group-hover/pinned-heading:opacity-100');
    expect(pinned).toContain(': "opacity-100"');
  });

  test("hides the workspace color dot on pinned sessions while retaining workspace context", () => {
    const pinned = source.slice(source.indexOf("function GlobalPinnedSessionTree("), source.indexOf("type WorkspaceHeaderProps"));
    expect(pinned).toContain("showWorkspaceIcon={false}");
    expect(pinned).toContain("workspaceName={row.depth === 0 ? workspaceLabel(group.workspace) : undefined}");
    expect(pinned).toContain("isPinned={pinnedIds.has(row.session.id)}");
  });
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
    expect(source).toMatch(/const leading = flushLeft \? null : \([\s\S]+aria-hidden="true" className=\{LEFT_ACTIVITY_SLOT\}/);
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
    expect(source).toMatch(/workspaceSessionGroupsInScope = React\.useMemo\([\s\S]+sidebarWorkspaceSessionGroups\.filter/);
    expect(source).toMatch(/resolveWorkspaceSessionIndicator\([\s\S]+sidebarWorkspaceSessionGroups/);
  });
});

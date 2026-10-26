import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { AUTOMATION_TEMPLATE_CATALOG_VERSION, AUTOMATION_TEMPLATES } from "../src/react-app/domains/automations/templates";
import { parseWorkspaceAppPath } from "../src/react-app/shell/workspace-routes";
import { APP_PRIMARY_RAIL_ORDER } from "../src/react-app/shell/app-navigation-order";

describe("Desktop automation catalog and routes", () => {
  test("ships twelve stable client-only templates without credentials or absolute paths", () => {
    expect(AUTOMATION_TEMPLATES).toHaveLength(12);
    expect(new Set(AUTOMATION_TEMPLATES.map((template) => template.id)).size).toBe(12);
    const serialized = JSON.stringify(AUTOMATION_TEMPLATES);
    expect(serialized).not.toMatch(/accessToken|refreshToken|apiKey|password|secret/i);
    expect(serialized).not.toMatch(/"\/(?:Users|home|var|tmp)\//);
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.version).toBe(AUTOMATION_TEMPLATE_CATALOG_VERSION);
      expect(template.title.trim()).not.toBe("");
      expect(template.prompt.trim()).not.toBe("");
      expect(template.promptTemplate).toEqual({ version: 1, parts: [{ type: "text", text: template.prompt }] });
      expect(template.localized["zh-CN"].title).toBe(template.title);
      expect(template.localized["en-US"].title.trim()).not.toBe("");
      expect(template.recommendedConnectorIds).toEqual([...new Set(template.recommendedConnectorIds)]);
    }
  });

  test("recognizes list, history, create and edit deep links as automation surfaces", () => {
    for (const path of ["/automations", "/automations/runs", "/automations/new", "/automations/task-1"]) {
      expect(parseWorkspaceAppPath(path)).toEqual({ view: "automations", workspaceId: null });
    }
  });

  test("places automation immediately below cloud workspace in the primary rail", () => {
    expect(APP_PRIMARY_RAIL_ORDER).toEqual(["local-workspace", "cloud-workspace", "automations", "plugins", "chat", "contacts", "more"]);
  });

  test("uses a compact two-pane dashboard with a centered template landing", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const landing = page.slice(page.indexOf("function AutomationTaskLanding"), page.indexOf("function TaskList"));
    const catalog = page.slice(page.indexOf("function TemplateCatalog"), page.indexOf("function AutomationEditor"));
    expect(page).toContain('data-testid="automation-sidebar"');
    expect(page).toContain('data-testid="automation-main"');
    expect(page).toContain('props.sidebarOpen ? "w-[var(--jugglework-left-sidebar-width)]" : "w-0"');
    expect(page).toContain('transition-[width] duration-200 ease-linear');
    expect(landing).toContain('max-w-4xl');
    expect(landing).toContain('automation.schedule_tasks');
    expect(catalog).toContain('block text-[13px] font-medium');
    expect(catalog).toContain('block text-xs leading-5 text-dls-secondary');
    expect(catalog).toContain('grid grid-cols-1 gap-4 md:grid-cols-2');
    expect(catalog).toContain('min-h-28');
    expect(catalog).toContain('border-dashed');
    expect(page).toContain('triggerSummaryLabel(task.trigger)');
  });

  test("automation prompt reuses the session editor without a run-task action", () => {
    const source = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<LexicalPromptEditor/);
    const adapter = source.slice(source.indexOf("function AutomationPromptComposer"), source.indexOf("function ScheduleEditor"));
    expect(adapter).not.toMatch(/run_task|运行任务|onSend/);
  });

  test("uses compact expandable schedule tabs and quarter-hour time menus", () => {
    const source = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const editor = source.slice(source.indexOf("function AutomationEditor"), source.indexOf("type ConnectorOption"));
    const compact = source.slice(source.indexOf("type ScheduleTab"), source.indexOf("function ScheduleEditor"));
    expect(source).toMatch(/return \{ version: 1, kind: "calendar", frequency: "daily", every: 1, anchorLocalDate: today\(\), localTime: "09:00", timezone \}/);
    expect(editor).not.toMatch(/<Field label=\{t\("automation\.prompt"\)\}>/);
    expect(editor).not.toMatch(/t\("automation\.prompt_hint"\)/);
    expect(compact).toMatch(/"workdays" \| "minute" \| "hour" \| "daily" \| "weekly" \| "monthly" \| "yearly"/);
    expect(compact).toMatch(/COMPACT_SCHEDULE_TABS[^\n]+\["workdays", "daily", "weekly", "monthly"\]/);
    expect(compact).toMatch(/ALL_SCHEDULE_TABS[^\n]+\["workdays", "minute", "hour", "daily", "weekly", "monthly", "yearly"\]/);
    expect(compact).toMatch(/ChevronsRight/);
    expect(compact).toMatch(/inline-flex max-w-full items-center gap-1 overflow-x-auto/);
    expect(compact).toMatch(/every: 30, unit: "minute"/);
    expect(compact).toMatch(/every: 1, unit: "hour"/);
    expect(compact).toMatch(/role="combobox"/);
    expect(compact).toMatch(/createPortal/);
    expect(compact).toMatch(/useAnchoredFloating/);
    expect(compact).not.toMatch(/CompactFrequencySelect|automation\.schedule_custom|automation\.frequency_hint/);
    expect(compact).toMatch(/Array\.from\(\{ length: 96 \}/);
    expect(compact).toMatch(/\(index % 4\) \* 15/);
    expect(compact).toMatch(/role="listbox"[\s\S]+aria-selected=\{option === value\}/);
  });

  test("characterizes the live session composer contract before shared reuse", () => {
    const source = readFileSync(new URL("../src/react-app/domains/session/surface/composer/composer.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/busy: boolean/);
    expect(source).toMatch(/onSend/);
    expect(source).toMatch(/LexicalPromptEditor/);
    expect(source).toMatch(/listAgents/);
    expect(source).toMatch(/listMcp/);
  });

  test("keeps template application client-only, accessible, and independent of server catalog versions", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const catalog = readFileSync(new URL("../src/react-app/domains/automations/templates.ts", import.meta.url), "utf8");
    const rail = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/grid-cols-1[^\n]+md:grid-cols-2[^\n]+xl:grid-cols-3/);
    expect(page).toMatch(/navigate\("\/automations\/new", \{ state: \{ templateId:/);
    expect(page).toMatch(/<AutomationTaskLanding onSelect=/);
    expect(page).toMatch(/AUTOMATION_TEMPLATES\.slice\(0, 6\)/);
    expect(page).toMatch(/onOpenHome=\{\(\) => navigateAfterDiscard\(\(\) => navigate\(props\.sessionPath\)\)\}/);
    expect(rail).toContain("active={automationsActive}");
    expect(rail).toContain('location.pathname.startsWith("/automations")');
    expect(page).toMatch(/value\.schedule\.kind === "once"[\s\S]+请选择单次任务的未来日期和时间/);
    expect(catalog).not.toMatch(/fetch\(|createAutomation|updateAutomation|serverId/);
    expect(AUTOMATION_TEMPLATES.filter((template) => !template.schedule).length).toBeGreaterThan(0);
  });

  test("connector picker is multi-select, readiness-gated, localized, and never renders credentials", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/connectorReadinessError/);
    expect(page).toMatch(/aria-multiselectable="true"/);
    expect(page).toMatch(/t\("automation\.connector_needs_reconnect"\)/);
    expect(page).toMatch(/orgConnectors\.connect/);
    expect(page).not.toMatch(/accessToken|refreshToken|apiKey|password/);
    for (const locale of ["zh", "en"]) {
      const table = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of ["connector_needs_reconnect", "connectors_manage", "connectors_placeholder", "connectors_empty"]) {
        expect(table).toMatch(new RegExp(`"automation\\.${key}"`));
      }
    }
  });

  test("reserves non-id automation segments and keeps secondary actions out of the task sidebar", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    // /automations/templates 必须走模板页，不能被解析成 id 为 "templates" 的任务。
    expect(page).toMatch(/AUTOMATION_RESERVED_SEGMENTS = new Set\(\["new", "runs", "templates"\]\)/);
    expect(page).toMatch(/templatesVisible = location\.pathname === "\/automations\/templates"/);
    expect(parseWorkspaceAppPath("/automations/templates")).toEqual({ view: "automations", workspaceId: null });
    // 模板页和运行记录的深链接继续兼容，但左侧任务栏不再显示这两个固定入口。
    const dashboard = page.slice(page.indexOf("function AutomationDashboard"), page.indexOf("function AutomationServerLoading"));
    const taskList = page.slice(page.indexOf("function TaskList"), page.indexOf("function TaskRow"));
    expect(dashboard).not.toMatch(/<nav/);
    expect(dashboard).not.toMatch(/automation\.from_template/);
    expect(taskList).not.toMatch(/navigate\("\/automations\/runs"\)/);
    expect(page).toMatch(/AUTOMATION_TEMPLATES\.slice\(0, 6\)/);
    expect(dashboard).not.toMatch(/t\("automation\.batch_manage"\)/);
    for (const locale of ["zh", "en"]) {
      const table = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of ["from_template", "breadcrumb_root"]) {
        expect(table).toMatch(new RegExp(`"automation\\.${key}"`));
      }
    }
  });

  test("expands new-chat automations and opens the reusable chat from the task row", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const row = page.slice(page.indexOf("function TaskRow"), page.indexOf("function taskTimingLabel"));
    expect(row).toMatch(/task\.newChatPerRun !== false/);
    expect(row).toMatch(/listAutomationRuns\(\{[\s\S]+automationId: task\.id/);
    expect(row).toMatch(/createsNewChatPerRun[\s\S]+setExpanded/);
    expect(row).toContain("onOpenSession(target.workspaceId, target.sessionId,");
    expect(row).toContain('if (task.trigger.kind !== "event")');
    expect(row).toContain("await client.prepareAutomationSession(task.id)");
    expect(row).toContain("onOpenSession(item.workspaceId, item.sessionId,");
    expect(row).toContain("if (!client || openingSessionRef.current) return;");
    expect(row).not.toContain("client.runAutomation(");
    expect(row).toContain("onOpenSession(run.workspaceId, run.sessionId!,");
    expect(row).not.toContain("navigate(");
    expect(row).toMatch(/if \(nextExpanded\) void loadSessions\(false\);\s*return;/);
    expect(row).toMatch(/if \(!target\?\.sessionId\) \{\s*onEdit\(\)/);
    expect(row).toMatch(/automation\.edit_task/);
  });

  test("filters scheduled tasks by lifecycle and unread result and marks opened results viewed", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const client = readFileSync(new URL("../src/app/lib/jugglework-server.ts", import.meta.url), "utf8");
    expect(page).toContain("DEFAULT_AUTOMATION_TASK_STATUS_FILTERS");
    expect(page).toContain("matchesAutomationTaskFilter(record, taskStatusFilters, unreadOnly)");
    expect(page).toContain("DropdownMenuCheckboxItem");
    expect(page).toMatch(/<DropdownMenuGroup>[\s\S]+<DropdownMenuLabel[\s\S]+<\/DropdownMenuGroup>/);
    expect(page).toContain('(["enabled", "paused", "completed"] as const)');
    expect(page).toContain('t(`automation.filter_${filter}`)');
    expect(page).toContain('t("automation.filter_unread")');
    expect(page).toContain("markAutomationResultViewed(viewedResult.automationId, viewedResult.runId)");
    const sessionStatus = readFileSync(new URL("../src/react-app/domains/automations/automation-session-status.tsx", import.meta.url), "utf8");
    expect(sessionStatus).toContain("client.markAutomationResultViewed(run.automationId, run.id)");
    expect(client).toContain("/viewed-result");
  });

  test("groups paused scheduled tasks separately from current and ended tasks", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toContain('key: "current"');
    expect(page).toContain('task.definition.lifecycle !== "paused" && task.definition.lifecycle !== "completed"');
    expect(page).toContain('key: "paused"');
    expect(page).toContain('task.definition.lifecycle === "paused"');
    expect(page).toContain('key: "ended"');
    expect(page).toContain('task.definition.lifecycle === "completed"');
    expect(page).toContain('data-automation-task-group={key}');
    expect(page).toContain('const [pausedGroupExpanded, setPausedGroupExpanded] = useState(false)');
    expect(page).toContain('aria-expanded={pausedGroupExpanded}');
    for (const locale of ["zh", "en"]) {
      const table = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      expect(table).toMatch(/"automation\.paused":/);
    }
  });

  test("shows live and unread outcomes in scheduled-task sidebars", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const preview = readFileSync(new URL("../src/react-app/domains/automations/automation-sidebar-preview.tsx", import.meta.url), "utf8");
    const indicator = readFileSync(new URL("../src/react-app/domains/automations/automation-task-status-indicator.tsx", import.meta.url), "utf8");
    expect(page).toContain("activeRunByAutomationId");
    expect(page).toContain("<AutomationTaskStatusIndicator");
    expect(page).toContain("const unreadResult = record.hasUnreadResult ? record.latestResultRun : undefined");
    expect(page).toContain("onOpenSession(unreadResult.workspaceId, unreadResult.sessionId,");
    expect(preview).toContain("<AutomationTaskStatusIndicator");
    expect(indicator).toContain('data-automation-task-status="running"');
    expect(indicator).toContain('"succeeded-unread"');
    expect(indicator).toContain('"failed-unread"');
    expect(indicator).toContain('const AUTOMATION_SUCCESS_DOT = "#2FBE54"');
    expect(indicator).toContain('const AUTOMATION_FAILURE_DOT = "#E8933A"');
  });

  test("starts the shared local-server connection and keeps local automations out of cloud sync", () => {
    const root = readFileSync(new URL("../src/react-app/shell/app-root.tsx", import.meta.url), "utf8");
    const provider = readFileSync(new URL("../src/react-app/domains/connections/root-jugglework-server-provider.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");

    expect(root).toMatch(/<RootJuggleWorkServerProvider>[\s\S]+<AutomationRunNotificationCoordinator \/>[\s\S]+<Routes>/);
    expect(root).not.toMatch(/AutomationSyncCoordinator/);
    expect(page).not.toMatch(/syncStateLabel|sync_unavailable_notice|readReadOnlyAutomationMirrors/);
    expect(provider).toMatch(/store\.start\(\)/);
    expect(provider).toMatch(/store\.dispose\(\)/);
    expect(page).toMatch(/juggleworkServerCheckedAt === null/);
    expect(page).toMatch(/reconnectJuggleWorkServer\(\)/);
    expect(page).toMatch(/ensureLocalJuggleWorkServerClient\(\)/);
  });

  test("keeps search and creation controls compact inside the task sidebar", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/aria-expanded=\{searchVisible\}/);
    expect(page).toMatch(/placeholder=\{t\("automation\.search"\)\} className="h-9[^\"]+text-\[13px\]/);
    expect(page).toMatch(/navigate\("\/automations\/new"\)[\s\S]+automation\.new_task/);
    expect(page).not.toMatch(/placeholder=\{t\("automation\.search"\)\} className="h-11/);
  });

  test("matches the automation editor actions to the session Run task button", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const actionsStart = page.indexOf('className="ml-auto flex shrink-0 gap-1.5 mac:titlebar-no-drag"');
    const editorActions = page.slice(actionsStart, page.indexOf("</header>}", actionsStart));
    expect(editorActions).toMatch(/h-9 max-h-9 items-center rounded-full[^\"]+text-\[13px\] font-medium/);
    expect(editorActions).toMatch(/bg-\[var\(--dls-accent\)\] text-\[var\(--dls-accent-fg\)\]/);
    expect(editorActions).toMatch(/border border-dls-border bg-transparent/);
    expect(editorActions).not.toMatch(/h-11 rounded-xl/);
  });

  test("uses a full-width settings row for local workspaces", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const workspaceSelect = page.slice(page.indexOf("function WorkspaceSingleSelect"), page.indexOf("type AutomationPromptComposerProps"));
    expect(page).toMatch(/<WorkspaceSingleSelect[\s\S]+selectedId=\{workspaceId\}[\s\S]+onSelect=\{setWorkspaceId\}/);
    expect(workspaceSelect).toMatch(/role="listbox"/);
    expect(workspaceSelect).not.toMatch(/aria-multiselectable/);
    expect(workspaceSelect).toMatch(/useAnchoredFloating\(open, containerRef, \{ width: "anchor", maxHeight: 280 \}\)/);
    expect(workspaceSelect).toMatch(/createPortal\([\s\S]+document\.body/);
    expect(workspaceSelect).toContain("overflow-y-auto overscroll-contain");
    expect(workspaceSelect).not.toContain('t("automation.workspace_automatic")');
    expect(workspaceSelect).toMatch(/w-full items-center justify-between[^\"]+rounded-2xl border border-dls-border[^\"]+px-5 py-4 text-sm/);
    expect(workspaceSelect).toMatch(/className="flex w-full[^\"]+bg-transparent/);
    expect(workspaceSelect).toMatch(/t\("automation\.workspace"\)[\s\S]+flex min-w-0 items-center[\s\S]+t\("automation\.workspace_none"\)/);
    expect(workspaceSelect).toMatch(/rounded-2xl border border-dls-border[^\"]+shadow-\[var\(--dls-shell-shadow\)\]/);
    expect(workspaceSelect).toMatch(/role="option"[\s\S]+aria-selected=\{selectedOption\}/);
    expect(workspaceSelect).toMatch(/props\.onSelect\(workspace\.id\);[\s\S]+setOpen\(false\)/);
    expect(workspaceSelect).toMatch(/workspaceOptionLabel\(workspace\)[\s\S]+selectedOption \? <Check className="size-4 shrink-0/);
    expect(workspaceSelect).not.toMatch(/rounded-md border border-\[#ebebeb\]/);
    expect(page).not.toMatch(/<select value=\{workspaceId\}/);
    expect(page).toMatch(/filter\(\(item\) => item\.workspaceType === "local" && !item\.automationManaged\)/);
  });

  test("ends the advanced creation settings at effort", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const advancedStart = page.indexOf('{advanced ? <div className="space-y-4"');
    const advanced = page.slice(advancedStart, page.indexOf("{modal ? (", advancedStart));
    const controlsStart = page.indexOf("if (props.controlsOnly)");
    const controls = page.slice(controlsStart, page.indexOf("  return (", controlsStart));

    expect(advanced).toContain("<WorkspaceSingleSelect");
    expect(advanced).toContain("<AutomationPromptComposer controlsOnly");
    expect(advanced.indexOf('t("automation.new_chat_per_run")')).toBeLessThan(advanced.indexOf("<WorkspaceSingleSelect"));
    expect(advanced).not.toContain("<ConnectorMultiSelect");
    expect(advanced).not.toContain("<TriggerKindSelector");
    expect(advanced).not.toContain("<EventTriggerEditor");
    expect(advanced).not.toContain("<DateRangeField");
    expect(controls).toContain('t("automation.model")');
    expect(controls).toContain('t("automation.effort")');
    expect(controls).not.toContain('t("automation.skills")');
    expect(controls).not.toContain("<PermissionMenu");
  });

  test("shows connector multi-selection with trailing checks instead of checkbox boxes", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const connectorSelect = page.slice(page.indexOf("function ConnectorMultiSelect"), page.indexOf("function useDismissOnOutside"));
    expect(connectorSelect).toMatch(/option\.label[\s\S]+checked \? <Check className="size-4 shrink-0/);
    expect(connectorSelect).not.toMatch(/rounded-md border border-\[#ebebeb\]/);
    expect(connectorSelect).toMatch(/aria-multiselectable="true"/);
  });

  test("keeps empty-task copy in the sidebar and creation available above it", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/navigate\("\/automations\/new"\)[\s\S]+t\("automation\.new_task"\)/);
    expect(page).toMatch(/!loading && tasks\.length === 0/);
    expect(page).toMatch(/t\("automation\.no_scheduled_tasks"\)/);
    expect(page).toMatch(/<AutomationTaskLanding onSelect=/);
  });

  test("uses the project confirm dialog for single automation deletion", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/import \{ ConfirmModal \} from "@\/react-app\/design-system\/modals\/confirm-modal"/);
    expect(page).toMatch(/open=\{Boolean\(pendingDelete\)\}[\s\S]+automation\.delete_confirm[\s\S]+variant="danger"/);
    expect(page).not.toMatch(/window\.confirm\(t\("automation\.delete_confirm/);
  });

  test("cancels a new draft directly while retaining discard protection for other navigation", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/const \[discardConfirmOpen, setDiscardConfirmOpen\] = useState\(false\)/);
    expect(page).toMatch(/pendingDiscardActionRef\.current = action;[\s\S]+setDiscardConfirmOpen\(true\)/);
    expect(page).toMatch(/open=\{discardConfirmOpen\}[\s\S]+automation\.discard_confirm[\s\S]+variant="warning"/);
    expect(page).toMatch(/const confirmDiscard = \(\) => \{[\s\S]+setEditorDirty\(false\);[\s\S]+action\?\.\(\)/);
    expect(page).toMatch(/const cancelEditor = \(\) => \{[\s\S]+location\.pathname === "\/automations\/new"[\s\S]+setEditorDirty\(false\);[\s\S]+navigate\("\/automations"\);[\s\S]+return;/);
    expect(page).toMatch(/onCancel=\{cancelEditor\}/);
    expect(page).not.toMatch(/window\.confirm\(t\("automation\.discard_confirm"\)\)/);
  });

  test("uses compact workspace-styled schedule selection and an effective Today action", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const frequency = page.slice(page.indexOf("function CalendarFrequencySelect"), page.indexOf("function PermissionDialog"));
    expect(page).toMatch(/<CalendarFields value=\{value\} onChange=\{onChange\}/);
    expect(page).toMatch(/function CalendarFields[\s\S]+flex flex-nowrap items-center gap-3/);
    expect(frequency).toMatch(/className="relative w-36 shrink-0"/);
    expect(frequency).toMatch(/pr-4 text-left/);
    expect(frequency).toMatch(/role="listbox"[\s\S]+rounded-2xl border border-dls-border/);
    expect(frequency).toMatch(/absolute bottom-full left-0 right-0[^"]+mb-2/);
    expect(frequency).toMatch(/option\.label[\s\S]+selected \? <Check className="size-4 shrink-0/);
    expect(page).not.toMatch(/<select value=\{value\.frequency\}/);
    expect(page).toMatch(/const currentDate = today\(\);[\s\S]+setCursor\(startOfMonth\(currentDate\)\);[\s\S]+pickDay\(currentDate\)/);
  });

  test("uses compact multi-selects for weekly, monthly, and yearly calendar values", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const fields = page.slice(page.indexOf("function CalendarFields"), page.indexOf("type CalendarFrequency"));
    const multiSelect = page.slice(page.indexOf("function CompactMultiSelect"), page.indexOf("function CalendarFrequencySelect"));
    expect(fields).toMatch(/frequency === "weekly"[\s\S]+<CompactMultiSelect value=\{value\.weekdays\}/);
    expect(fields).toMatch(/frequency === "monthly"[\s\S]+<CompactMultiSelect value=\{monthlyScheduleDays\(value\)\}/);
    expect(fields).toMatch(/frequency === "yearly"[\s\S]+<CompactMultiSelect value=\{yearlyScheduleMonths\(value\)\}/);
    expect(fields).toMatch(/months: \[1\][\s\S]+dayOfMonth: 1/);
    expect(multiSelect).toMatch(/aria-multiselectable="true"/);
    expect(multiSelect).toMatch(/triggerClassName = "w-44"/);
    expect(multiSelect).toMatch(/cn\("relative shrink-0", triggerClassName\)/);
    expect(multiSelect).toMatch(/columns === 7 \? 390 : 240/);
    expect(multiSelect).toMatch(/useAnchoredFloating/);
    expect(multiSelect).toMatch(/createPortal/);
  });

  test("uses theme-matched time and single-date pickers instead of native browser popups", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const schedule = page.slice(page.indexOf("function ScheduleEditor"), page.indexOf("function PermissionDialog"));
    const time = page.slice(page.indexOf("function TimeField"), page.indexOf("function TimePartList"));
    const date = page.slice(page.indexOf("function SingleDateField"), page.indexOf("function DateRangeField"));
    expect(schedule).not.toMatch(/type="time"|type="date"/);
    expect(schedule).toMatch(/<TimeField value=\{value\.localTime\}/);
    expect(schedule).toMatch(/<SingleDateField value=\{value\.localDate\}/);
    expect(time).toMatch(/border border-dls-border bg-background[\s\S]+shadow-\[var\(--dls-shell-shadow\)\]/);
    expect(time).toMatch(/absolute bottom-full left-0[^"]+mb-2/);
    expect(date).toMatch(/<CalendarPanel[\s\S]+selectedDate=\{value\}/);
    expect(date).toMatch(/absolute bottom-full left-0[^"]+mb-2/);
    expect(date).toMatch(/data-date=\{date\}[\s\S]+aria-current=\{date === today\(\) \? "date"/);
  });

  test("uses the project checkbox visual and vertically centers the risk acknowledgement", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const permission = page.slice(page.indexOf("function PermissionDialog"), page.indexOf("function Field"));
    expect(permission).toMatch(/role="checkbox"[\s\S]+aria-checked=\{props\.accepted\}/);
    expect(permission).toMatch(/items-center gap-3 text-left text-sm/);
    expect(permission).toMatch(/rounded-md border border-\[#ebebeb\][\s\S]+props\.accepted && "border-dls-text bg-dls-text text-background"/);
    expect(permission).not.toMatch(/type="checkbox"|items-start|mt-0\.5 size-5/);
  });

  test("creates scheduled tasks with their selected permission profile without a second confirmation", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const editor = page.slice(page.indexOf("function AutomationEditor"), page.indexOf("type ConnectorOption"));
    expect(editor).toMatch(/useState<AutomationPermissionProfile>\(AUTOMATION_PERMISSION_PROFILE\)/);
    expect(editor).toMatch(/if \(!props\.automationId && triggerKind === "schedule"\) \{\s*void save\(true\);\s*return;\s*\}/);
    expect(editor).toMatch(/permission: \{ profile: permission, acknowledgedAt: now \}/);
    expect(editor).toMatch(/setPermissionOpen\(true\)/);
  });

  test("waits for dependencies from the current workspace before allowing create", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const editor = page.slice(page.indexOf("function AutomationEditor"), page.indexOf("type ConnectorOption"));
    expect(editor).toContain("const [dependenciesResolvedFor, setDependenciesResolvedFor] = useState<string | null>(null)");
    expect(editor).toContain("setDependencies(EMPTY_DEPENDENCIES)");
    expect(editor).toContain("setDependenciesResolvedFor(requestedWorkspaceId)");
    expect(editor).toContain("dependenciesResolvedFor === dependencyWorkspaceId");
    expect(editor).toContain('"正在加载可用模型，请稍候"');
    expect(editor.match(/disabled=\{saving \|\| !prompt\.trim\(\) \|\| !dependenciesReady\}/g)).toHaveLength(2);
  });

  test("refreshes the retained task dashboard after a successful editor save", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const automationPage = page.slice(page.indexOf("export function AutomationPage"), page.indexOf("function AutomationDashboard"));
    const dashboard = page.slice(page.indexOf("function AutomationDashboard"), page.indexOf("function AutomationServerLoading"));
    expect(automationPage).toMatch(/const \[automationListRevision, setAutomationListRevision\] = useState\(0\)/);
    expect(automationPage).toMatch(/const handleEditorSaved = useCallback\(\(session\?: \{ workspaceId: string; sessionId: string \}\) => \{[\s\S]+setAutomationListRevision\(\(value\) => value \+ 1\);[\s\S]+navigate\("\/automations"\)/);
    expect(automationPage).toMatch(/if \(session\) props\.onOpenSession\(session\.workspaceId, session\.sessionId\)/);
    expect(automationPage.match(/onSaved=\{handleEditorSaved\}/g)).toHaveLength(1);
    expect(automationPage).toMatch(/<AutomationDashboard[\s\S]+refreshRevision=\{automationListRevision\}/);
    expect(dashboard).toMatch(/refreshRevision: number/);
    expect(dashboard).toMatch(/useEffect\(\(\) => \{ setNextCursor\(undefined\); void load\(\); \}, \[load, props\.refreshRevision\]\)/);
  });

  test("uses the same modal for create and edit while retaining the dashboard and session host", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const automationPage = page.slice(page.indexOf("export function AutomationPage"), page.indexOf("function AutomationDashboard"));
    expect(automationPage).toContain('<Dialog open={editorVisible}');
    expect(automationPage).toContain('presentation="modal"');
    expect(automationPage).not.toContain('presentation="page"');
    expect(automationPage).toContain('automationId={editingId}');
    expect(automationPage).toContain('key={editingId ?? "new"}');
    expect(page).toContain('data-testid="automation-session-host"');
    expect(page).toContain('if (props.history) props.onClearSession();');
    expect(page).not.toContain('className="flex h-9 shrink-0 items-center border-b border-dls-border px-4 mac:titlebar-no-drag"');
    expect(page).toContain('props.sessionSelected && "mb-0 mr-0 mt-0 rounded-none border-0 bg-dls-sidebar shadow-none"');
    expect(page).toContain('props.sessionSelected && "mb-1.5 mt-11 h-auto self-stretch rounded-l-[18px] border border-r-0 border-dls-border');
    expect(page).toContain('!templatesVisible && !(props.sessionSelected && !sidebarOpen)');
    expect(page).toContain('props.sessionSelected ? "bg-dls-sidebar" : "bg-background"');
    expect(page).toContain('t(props.automationId ? "automation.save" : "common.create")');
    expect(page).not.toContain('navigate(`/workspace/');
  });

  test("keeps automation editor actions visible in a draggable fixed header", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const editor = page.slice(page.indexOf("function AutomationEditor"), page.indexOf("type ConnectorOption"));
    expect(page).toMatch(/templatesVisible \? "overflow-auto" : "overflow-hidden"/);
    expect(editor).toMatch(/flex h-full min-h-0 flex-col overflow-hidden/);
    expect(editor).toMatch(/<header className="z-30 shrink-0[^\"]+mac:titlebar-drag">/);
    expect(editor).toMatch(/mac:titlebar-no-drag[\s\S]+<AutomationBreadcrumb/);
    expect(editor).toMatch(/ml-auto flex shrink-0 gap-1\.5 mac:titlebar-no-drag/);
    expect(editor).toMatch(/<div className="min-h-0 flex-1 overflow-y-auto">/);
    expect(editor).toMatch(/max-w-6xl px-6 pb-8 pt-3 lg:px-10/);
    expect(editor).toMatch(/<div className="mt-4 space-y-7">/);
  });

  test("keeps draggable chrome and independent scrolling in the dashboard panes", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const dashboard = page.slice(page.indexOf("function AutomationDashboard"), page.indexOf("function AutomationServerLoading"));
    expect(page).toMatch(/templatesVisible \? "overflow-auto" : "overflow-hidden"/);
    expect(dashboard).toMatch(/"relative flex h-full min-h-0 w-full overflow-hidden"/);
    expect(dashboard).toMatch(/props\.sessionSelected \? "bg-dls-sidebar" : "bg-background"/);
    expect(dashboard).toMatch(/<aside[^>]+mac:titlebar-drag/);
    expect(dashboard).toMatch(/h-\[var\(--app-topbar-height\)\][^\"]+mac:titlebar-drag/);
    expect(dashboard).toMatch(/min-h-0 flex-1 overflow-y-auto px-2 pb-3/);
    expect(dashboard).toMatch(/<main data-testid="automation-main" className="min-w-0 flex-1 overflow-hidden">/);
  });

  test("keeps the full automation top-left chrome draggable around its controls", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toContain('WebkitAppRegion: "drag"');
    expect(page).toContain('data-automation-sidebar-titlebar');
    expect(page).toMatch(/data-automation-sidebar-titlebar[\s\S]+WebkitAppRegion: "no-drag"/);
    expect(page).toContain('mac:titlebar-drag');
    expect(page).toContain('mac:titlebar-no-drag');
  });
});

describe("Event-trigger editor (add-event-triggered-automation tasks 2.1-2.6)", () => {
  test("defaultEventTrigger produces a structurally valid AutomationEventTrigger", async () => {
    const { defaultEventTrigger } = await import("../src/react-app/domains/automations/event-trigger-editor");
    const trigger = defaultEventTrigger("connector-1");
    expect(trigger).toEqual({
      version: 1,
      kind: "event",
      provider: "github",
      connectorId: "connector-1",
      repository: { owner: "", name: "" },
      matches: [],
      concurrencyKey: "entity",
      deliveryMode: "auto",
      permissionTier: "auto",
    });
  });

  test("defaultEventTrigger fills in the selected repository when provided", async () => {
    const { defaultEventTrigger } = await import("../src/react-app/domains/automations/event-trigger-editor");
    const trigger = defaultEventTrigger("connector-1", { connectorId: "connector-1", owner: "juggleai", name: "jugglework-desktop", visibility: "public" });
    expect(trigger.repository).toEqual({ owner: "juggleai", name: "jugglework-desktop" });
  });

  test("compact creation UI hides event-only controls while retaining event data handling", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const advancedStart = page.indexOf('{advanced ? <div className="space-y-4"');
    const advanced = page.slice(advancedStart, page.indexOf("{modal ? (", advancedStart));
    expect(advanced).not.toContain("TriggerKindSelector");
    expect(advanced).not.toContain("EventTriggerEditor");
    expect(page).toMatch(/const \[eventTrigger, setEventTrigger\] = useState<AutomationEventTrigger>/);
    expect(page).toMatch(/setEventTrigger\(definition\.trigger\)/);
    expect(page).toMatch(/trigger: triggerKind === "event" \? eventTrigger : schedule/);
  });

  test("save path assigns an event trigger definition and auto-adds a github-app connector entry", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/trigger: triggerKind === "event" \? eventTrigger : schedule/);
    expect(page).toMatch(/source: "github-app" as const/);
  });

  test("event trigger validation rejects an empty repository or empty event-type selection, independent of server readiness", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const start = page.indexOf("function validateEventEditor");
    const fn = page.slice(start, page.indexOf("\nfunction ", start + 1));
    expect(fn).toMatch(/请选择一个仓库/);
    expect(fn).toMatch(/至少选择一种关心的事件类型/);
    // TIPS:这条断言是这次简化的关键——本地校验故意不检查服务端就绪态，保存不该被"仓库还没绑定"卡住。
    expect(fn).not.toMatch(/readiness/i);
  });
});

describe("Run history and list rendering for event-sourced runs (tasks 4.1-4.2)", () => {
  test("run history renders the entity link, merged-event count, and previous-session-unavailable note", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const fnStart = page.indexOf("function RunHistory");
    const fn = page.slice(fnStart, page.indexOf("\nfunction ", fnStart + 1));
    expect(fn).toMatch(/eventMetadata\?\.entityUrl/);
    expect(fn).toMatch(/查看触发的 PR\/Issue/);
    expect(fn).toMatch(/eventMetadata\?\.mergedEventCount/);
    expect(fn).toMatch(/eventMetadata\?\.previousSessionUnavailable/);
    expect(fn).toMatch(/event_backlog_dropped/);
  });

  test("automationFailureAdvice covers the new event-trigger error codes with distinct copy", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const fnStart = page.indexOf("function automationFailureAdvice");
    const fn = page.slice(fnStart, page.indexOf("\n}", fnStart));
    expect(fn).toMatch(/event_backlog_dropped/);
    expect(fn).toMatch(/rate_limited/);
    expect(fn).toMatch(/upstream_connector_revoked/);
  });

  test("scheduled-task list row shows repository and event-type count for event-kind triggers, not a schedule summary", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const fnStart = page.indexOf("function triggerSummaryLabel");
    const fn = page.slice(fnStart, page.indexOf("\nfunction ", fnStart + 1));
    expect(fn).toMatch(/trigger\.repository\.owner/);
    expect(fn).toMatch(/trigger\.matches\.length/);
  });
});

describe("Delivery-mode status indicator (task 5.4)", () => {
  test("resolveEffectiveDeliveryChannel reflects forced-vs-resolved mismatches", async () => {
    const { resolveEffectiveDeliveryChannel } = await import("../src/react-app/domains/automations/event-trigger-editor");
    // 就绪时：auto/im 都解析成 im，poll 强制维持 poll。
    expect(resolveEffectiveDeliveryChannel("auto", "ready")).toBe("im");
    expect(resolveEffectiveDeliveryChannel("im", "ready")).toBe("im");
    expect(resolveEffectiveDeliveryChannel("poll", "ready")).toBe("poll");
    // 未就绪时：不管配置成什么，一律降级为轮询——这正是"强制 vs 实际生效"最该被看见的落差。
    expect(resolveEffectiveDeliveryChannel("im", "not_connected")).toBe("poll");
    expect(resolveEffectiveDeliveryChannel("auto", "pending_configuration")).toBe("poll");
  });
});

describe("P2 extended event coverage (tasks 7.1-7.2)", () => {
  test("event-type matrix includes release, backed by types/validation that already support it", () => {
    const editor = readFileSync(new URL("../src/react-app/domains/automations/event-trigger-editor.tsx", import.meta.url), "utf8");
    expect(editor).toMatch(/\{ event: "release", labelKey: "automation\.event_type\.release_published" \}/);
  });

  test("mention keyword filter is a free-text field, not hardcoded to a fixed @ default", () => {
    const editor = readFileSync(new URL("../src/react-app/domains/automations/event-trigger-editor.tsx", import.meta.url), "utf8");
    // TIPS:任务 7.2 想要的能力其实已经存在——mentionText 从设计第一天起就是自由文本输入，
    // 不曾硬编码过固定的 "@" 触发词，这里只是把这一点显式断言出来，避免以后被误改成受限输入。
    expect(editor).toMatch(/updateCommonFilter\(\{ mentionText: event\.target\.value \}\)/);
    expect(editor).not.toMatch(/mentionText.*=.*"@"/);
  });
});

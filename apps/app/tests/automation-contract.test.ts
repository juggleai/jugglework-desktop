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
    expect(rail).toMatch(/active=\{location\.pathname\.startsWith\("\/automations"\)\}/);
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

  test("reserves non-id automation segments and keeps batch/template entries out of the empty state", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    // /automations/templates 必须走模板页，不能被解析成 id 为 "templates" 的任务。
    expect(page).toMatch(/AUTOMATION_RESERVED_SEGMENTS = new Set\(\["new", "runs", "templates"\]\)/);
    expect(page).toMatch(/templatesVisible = location\.pathname === "\/automations\/templates"/);
    expect(parseWorkspaceAppPath("/automations/templates")).toEqual({ view: "automations", workspaceId: null });
    // 左侧任务栏始终保留完整模板入口，右侧只展示六个快速建议。
    expect(page).toMatch(/navigate\("\/automations\/templates"\)/);
    expect(page).toMatch(/AUTOMATION_TEMPLATES\.slice\(0, 6\)/);
    expect(page).toMatch(/t\("automation\.batch_manage"\)/);
    for (const locale of ["zh", "en"]) {
      const table = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
      for (const key of ["batch_manage", "batch_delete_confirm", "from_template", "breadcrumb_root"]) {
        expect(table).toMatch(new RegExp(`"automation\\.${key}"`));
      }
    }
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
    const editorActions = page.slice(page.indexOf('className="ml-auto flex shrink-0 gap-1.5 mac:titlebar-no-drag"'), page.indexOf("<ScheduleEditor"));
    expect(editorActions).toMatch(/h-9 max-h-9 items-center rounded-full[^\"]+text-\[13px\] font-medium/);
    expect(editorActions).toMatch(/bg-\[var\(--dls-accent\)\] text-\[var\(--dls-accent-fg\)\]/);
    expect(editorActions).toMatch(/border border-dls-border bg-transparent/);
    expect(editorActions).not.toMatch(/h-11 rounded-xl/);
  });

  test("uses a connector-styled single-select for local workspaces", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const workspaceSelect = page.slice(page.indexOf("function WorkspaceSingleSelect"), page.indexOf("type AutomationPromptComposerProps"));
    expect(page).toMatch(/<WorkspaceSingleSelect[\s\S]+selectedId=\{workspaceId\}[\s\S]+onSelect=\{setWorkspaceId\}/);
    expect(workspaceSelect).toMatch(/role="listbox"/);
    expect(workspaceSelect).not.toMatch(/aria-multiselectable/);
    expect(workspaceSelect).toMatch(/pr-4 text-left/);
    expect(workspaceSelect).toMatch(/rounded-2xl border border-dls-border[^\"]+shadow-\[var\(--dls-shell-shadow\)\]/);
    expect(workspaceSelect).toMatch(/role="option"[\s\S]+aria-selected=\{selectedOption\}/);
    expect(workspaceSelect).toMatch(/props\.onSelect\(workspace\.id\);[\s\S]+setOpen\(false\)/);
    expect(workspaceSelect).toMatch(/workspaceOptionLabel\(workspace\)[\s\S]+selectedOption \? <Check className="size-4 shrink-0/);
    expect(workspaceSelect).not.toMatch(/rounded-md border border-\[#ebebeb\]/);
    expect(page).not.toMatch(/<select value=\{workspaceId\}/);
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

  test("uses project confirm dialogs for single and batch automation deletion", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/import \{ ConfirmModal \} from "@\/react-app\/design-system\/modals\/confirm-modal"/);
    expect(page).toMatch(/open=\{batchDeleteOpen\}[\s\S]+automation\.batch_delete_confirm[\s\S]+variant="danger"/);
    expect(page).toMatch(/open=\{Boolean\(pendingDelete\)\}[\s\S]+automation\.delete_confirm[\s\S]+variant="danger"/);
    expect(page).not.toMatch(/window\.confirm\(t\("automation\.(?:batch_)?delete_confirm/);
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
    expect(multiSelect).toMatch(/relative w-44 shrink-0/);
    expect(multiSelect).toMatch(/absolute bottom-full left-0[^"]+mb-2/);
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
    expect(dashboard).toMatch(/relative flex h-full min-h-0 w-full overflow-hidden bg-background/);
    expect(dashboard).toMatch(/<aside[^>]+mac:titlebar-drag/);
    expect(dashboard).toMatch(/h-\[var\(--app-topbar-height\)\][^\"]+mac:titlebar-no-drag/);
    expect(dashboard).toMatch(/min-h-0 flex-1 overflow-y-auto px-2 pb-3/);
    expect(dashboard).toMatch(/<main data-testid="automation-main" className="min-w-0 flex-1 overflow-hidden">/);
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

  test("editor wires the trigger-kind selector, discard confirmation, and event editor branch", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/<TriggerKindSelector[\s\S]{0,400}onRequestChange=/);
    expect(page).toMatch(/hasEventDraft = eventTrigger\.repository\.owner \|\| eventTrigger\.matches\.length/);
    expect(page).toMatch(/setPendingTriggerKind\(next\)/);
    expect(page).toMatch(/triggerKind === "event" \? \(\s*<>\s*<EventTriggerEditor/);
    // TIPS:影子模式（任务 5.3）只在事件触发分支里出现，跟 EventTriggerEditor 包在同一个 fragment 里。
    expect(page).toMatch(/checked={lifecycle === "shadow"}/);
    // TIPS:公开仓库权限升级需要一次独立确认，不能一步选中——这里断言升级动作被路由到
    // EventTriggerEditor 自己的确认弹窗，而不是编辑器顶层已有的「完整访问权限」弹窗。
    expect(page).toMatch(/onPermissionEscalationConfirmed=\{\(\) => setPermission\(AUTOMATION_PERMISSION_PROFILE\)\}/);
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

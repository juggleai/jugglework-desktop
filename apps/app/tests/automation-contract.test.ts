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
    expect(APP_PRIMARY_RAIL_ORDER).toEqual(["local-workspace", "cloud-workspace", "automations", "chat", "contacts"]);
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
    expect(page).toMatch(/!loading && !props\.history[\s\S]+<TemplateCatalog/);
    expect(page).toMatch(/tasks\.length === 0 \? <FirstAutomation/);
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
    // 有任务时模板画廊只在「从模版添加」页出现，列表底部不再重复一份。
    expect(page).toMatch(/tasks\.length === 0 \? <TemplateCatalog/);
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

  test("matches automation header controls to the default create-workspace button size", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/inline-flex h-9 rounded-xl bg-dls-hover/);
    expect(page).toMatch(/placeholder=\{t\("automation\.search"\)\} className="h-9[^\"]+text-sm/);
    expect(page).toMatch(/inline-flex h-9 items-center gap-1\.5 rounded-xl border[^\"]+text-sm font-medium/);
    expect(page).not.toMatch(/inline-flex h-11|placeholder=\{t\("automation\.search"\)\} className="h-11/);
  });

  test("matches the automation editor actions to the session Run task button", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const editorActions = page.slice(page.indexOf('className="ml-auto flex gap-1.5"'), page.indexOf("<ScheduleEditor"));
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

  test("keeps the empty automation state compact and uses its internal create action", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/!props\.history && tasks\.length > 0 \? \([\s\S]+navigate\("\/automations\/new"\)/);
    expect(page).toMatch(/<section className="flex min-h-\[364px\] flex-col items-center justify-center text-center">/);
    expect(page).not.toMatch(/min-h-\[520px\]/);
    expect(page).toMatch(/tasks\.length === 0 \? <FirstAutomation/);
  });

  test("uses project confirm dialogs for single and batch automation deletion", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/import \{ ConfirmModal \} from "@\/react-app\/design-system\/modals\/confirm-modal"/);
    expect(page).toMatch(/open=\{batchDeleteOpen\}[\s\S]+automation\.batch_delete_confirm[\s\S]+variant="danger"/);
    expect(page).toMatch(/open=\{Boolean\(pendingDelete\)\}[\s\S]+automation\.delete_confirm[\s\S]+variant="danger"/);
    expect(page).not.toMatch(/window\.confirm\(t\("automation\.(?:batch_)?delete_confirm/);
  });

  test("uses the same project dialog layout when discarding a new automation draft", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/const \[discardConfirmOpen, setDiscardConfirmOpen\] = useState\(false\)/);
    expect(page).toMatch(/pendingDiscardActionRef\.current = action;[\s\S]+setDiscardConfirmOpen\(true\)/);
    expect(page).toMatch(/open=\{discardConfirmOpen\}[\s\S]+automation\.discard_confirm[\s\S]+variant="warning"/);
    expect(page).toMatch(/const confirmDiscard = \(\) => \{[\s\S]+setEditorDirty\(false\);[\s\S]+action\?\.\(\)/);
    expect(page).not.toMatch(/window\.confirm\(t\("automation\.discard_confirm"\)\)/);
  });

  test("uses compact workspace-styled schedule selection and an effective Today action", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const frequency = page.slice(page.indexOf("function CalendarFrequencySelect"), page.indexOf("function PermissionDialog"));
    expect(page).toMatch(/<div className="flex flex-wrap items-start gap-3"><CalendarFields/);
    expect(frequency).toMatch(/className="relative w-44"/);
    expect(frequency).toMatch(/pr-4 text-left/);
    expect(frequency).toMatch(/role="listbox"[\s\S]+rounded-2xl border border-dls-border/);
    expect(frequency).toMatch(/option\.label[\s\S]+selected \? <Check className="size-4 shrink-0/);
    expect(page).not.toMatch(/<select value=\{value\.frequency\}/);
    expect(page).toMatch(/const currentDate = today\(\);[\s\S]+setCursor\(startOfMonth\(currentDate\)\);[\s\S]+pickDay\(currentDate\)/);
  });

  test("uses the project checkbox visual and vertically centers the risk acknowledgement", () => {
    const page = readFileSync(new URL("../src/react-app/domains/automations/automation-page.tsx", import.meta.url), "utf8");
    const permission = page.slice(page.indexOf("function PermissionDialog"), page.indexOf("function Field"));
    expect(permission).toMatch(/role="checkbox"[\s\S]+aria-checked=\{props\.accepted\}/);
    expect(permission).toMatch(/items-center gap-3 text-left text-sm/);
    expect(permission).toMatch(/rounded-md border border-\[#ebebeb\][\s\S]+props\.accepted && "border-dls-text bg-dls-text text-background"/);
    expect(permission).not.toMatch(/type="checkbox"|items-start|mt-0\.5 size-5/);
  });
});

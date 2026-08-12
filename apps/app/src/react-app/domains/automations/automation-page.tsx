/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  AlarmClock,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleCheck,
  Clock3,
  ExternalLink,
  Languages,
  Lightbulb,
  ListChecks,
  Mailbox,
  MessageCircle,
  MoonStar,
  MoreHorizontal,
  Newspaper,
  Pause,
  Play,
  Plus,
  Search,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  AUTOMATION_DEFAULT_PERMISSION_PROFILE,
  AUTOMATION_PERMISSION_PROFILE,
  isAutomationPermissionProfile,
  type AutomationConnectorSelection,
  type AutomationDefinition,
  type AutomationDefinitionRecord,
  type AutomationDraft,
  type AutomationModelSelection,
  type AutomationPermissionProfile,
  type AutomationRun,
  type AutomationSchedule,
} from "@jugglework/types/automation";

import type { WorkspaceInfo } from "@/app/lib/desktop";
import { toast } from "@/components/ui/sonner";
import { JuggleWorkServerError, type JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { isOrgMcpConnectionReady } from "@/react-app/domains/connections/native-provider-connections";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import { useLocal } from "@/react-app/kernel/local-provider";
import { LexicalPromptEditor, type LexicalPromptEditorHandle } from "@/react-app/domains/session/surface/composer/editor";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import { AUTOMATION_TEMPLATES, type AutomationTemplate } from "./templates";
import { parseAutomationPrompt, readAutomationSkillIds, serializeAutomationPrompt } from "./automation-prompt-template";
import { AUTOMATION_CLOUD_CONNECTOR_SCOPE_ENABLED, LOCAL_AUTOMATION_ENABLED } from "./automation-feature-flags";
import { readAutomationDeviceId } from "./automation-device-identity";

type AutomationPageProps = {
  sessionPath: string;
  onOpenAccount: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onOpenTaskSearch?: () => void;
  onOpenCreateWorkspace?: () => void;
};

// TIPS:自动化表单统一使用 1px / #ebebeb 描边，暗色主题回落到设计系统边框色，避免浅灰在深色背景上消失。
// 右内边距留 8px：带下拉箭头的控件靠这段留白把箭头从边框上推开。
const FIELD = "h-11 w-full rounded-xl border border-[#ebebeb] bg-background pl-3 pr-2 text-sm outline-none transition focus:border-dls-accent dark:border-dls-border";
// TIPS:卡片阴影比输入框更重，用于把内容卡片从页面底色中托起。
const CARD_SHADOW = "shadow-[0_10px_30px_-12px_rgba(0,0,0,0.22),0_2px_8px_-4px_rgba(0,0,0,0.12)]";
type AutomationDependencies = Awaited<ReturnType<JuggleWorkServerClient["listAutomationDependencies"]>>;
const EMPTY_DEPENDENCIES: AutomationDependencies = { models: [], agents: [], skills: [], connectors: [] };
/** `/automations/*` 下不是任务 ID 的固定路径段。 */
const AUTOMATION_RESERVED_SEGMENTS = new Set(["new", "runs", "templates"]);
/** 内置默认智能体名，选择器里以「默认智能体」单独呈现。 */
const BUILT_IN_DEFAULT_AGENT = "jugglework";

/** Desktop 自动化任务列表、运行记录和编辑页面。 */
export function AutomationPage(props: AutomationPageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const store = useOptionalJuggleWorkServer();
  const serverSnapshot = store?.getSnapshot() ?? null;
  const client = serverSnapshot?.juggleworkServerReady ? serverSnapshot.juggleworkServerClient : null;
  const localServerPending = Boolean(store && serverSnapshot?.juggleworkServerCheckedAt === null);
  const reconnectLocalServer = useCallback(async () => {
    if (!store) return false;
    if (await store.reconnectJuggleWorkServer()) return true;
    // TIPS:健康检查失败可能意味着本机服务进程未启动，恢复进程后必须再次刷新 Store 状态。
    const recoveredClient = await store.ensureLocalJuggleWorkServerClient();
    return Boolean(recoveredClient && await store.reconnectJuggleWorkServer());
  }, [store]);
  const editMatch = location.pathname.match(/^\/automations\/([^/]+)$/);
  const editingId = editMatch && !AUTOMATION_RESERVED_SEGMENTS.has(editMatch[1]) ? decodeURIComponent(editMatch[1]) : null;
  const editorVisible = location.pathname === "/automations/new" || Boolean(editingId);
  const templatesVisible = location.pathname === "/automations/templates";
  const [editorDirty, setEditorDirty] = useState(false);

  useEffect(() => {
    if (!editorVisible || !editorDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [editorDirty, editorVisible]);

  if (!LOCAL_AUTOMATION_ENABLED) return <Navigate to={props.sessionPath} replace />;

  const navigateAfterDiscard = (action: () => void) => {
    if (editorVisible && editorDirty && !window.confirm(t("automation.discard_confirm"))) return;
    setEditorDirty(false);
    action();
  };

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      <AppNavigationRail
        onOpenAccount={() => navigateAfterDiscard(props.onOpenAccount)}
        onOpenHome={() => navigateAfterDiscard(() => navigate(props.sessionPath))}
        onOpenApps={() => navigateAfterDiscard(props.onOpenApps)}
        onOpenChat={() => navigateAfterDiscard(props.onOpenChat)}
        onOpenSettings={() => navigateAfterDiscard(props.onOpenSettings)}
        onOpenTaskSearch={props.onOpenTaskSearch}
        onOpenCreateWorkspace={props.onOpenCreateWorkspace}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-dls-surface/40">
        {templatesVisible ? (
          <TemplateGallery
            onBack={() => navigate("/automations")}
            onSelect={(template) => navigate("/automations/new", { state: { templateId: template.id } })}
          />
        ) : editorVisible ? (
          localServerPending ? (
            <AutomationServerLoading />
          ) : client ? (
            <AutomationEditor
              client={client}
              onManageConnectors={props.onOpenSettings}
              automationId={editingId}
              duplicateSourceId={location.pathname === "/automations/new" ? new URLSearchParams(location.search).get("duplicate") : null}
              templateId={readTemplateId(location.state)}
              onDirtyChange={setEditorDirty}
              onCancel={() => navigateAfterDiscard(() => navigate("/automations"))}
              onSaved={() => { setEditorDirty(false); navigate("/automations"); }}
            />
          ) : (
            <AutomationServerUnavailable onRetry={reconnectLocalServer} />
          )
        ) : (
          <AutomationDashboard
            client={client}
            localServerPending={localServerPending}
            history={location.pathname === "/automations/runs"}
            onReconnect={reconnectLocalServer}
          />
        )}
      </main>
    </div>
  );
}

function AutomationDashboard(props: {
  client: JuggleWorkServerClient | null;
  localServerPending: boolean;
  history: boolean;
  onReconnect: () => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<AutomationDefinitionRecord[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [status, setStatus] = useState<AutomationRun["state"] | "">("");
  const [trigger, setTrigger] = useState<AutomationRun["triggerSource"] | "">("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);

  // TIPS:`silent` 用于操作后的就地刷新。整页 loading 会把列表整个换成占位文案，一次
  // 暂停/删除就闪一下，看起来像是页面被重载了；只有首屏和筛选条件变化才该出现占位。
  const load = useCallback(async (cursor?: string, append = false, silent = false) => {
    if (props.localServerPending) {
      setLoading(true);
      setError(null);
      return;
    }
    if (!props.client) {
      setLoading(false);
      setError("本机服务尚未连接");
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      if (props.history) {
        const page = await props.client.listAutomationRuns({
          limit: 50,
          ...(cursor ? { cursor } : {}),
          ...(status ? { status } : {}),
          ...(trigger ? { trigger } : {}),
          ...(fromDate ? { scheduledFrom: new Date(`${fromDate}T00:00:00`).getTime() } : {}),
          ...(toDate ? { scheduledTo: new Date(`${toDate}T23:59:59.999`).getTime() } : {}),
        });
        setRuns((current) => append ? [...current, ...page.items] : page.items);
        setNextCursor(page.nextCursor);
      } else {
        const page = await props.client.listAutomations({ limit: 50, ...(cursor ? { cursor } : {}) });
        setTasks((current) => append ? [...current, ...page.items] : page.items);
        setNextCursor(page.nextCursor);
      }
    } catch (loadError) {
      setError(describeError(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [fromDate, props.client, props.history, props.localServerPending, status, toDate, trigger]);
  const refresh = useCallback(() => load(undefined, false, true), [load]);

  /**
   * 批量删除已勾选的任务。
   * TIPS: 逐个删除而不是并发——每次删除都带 baseRevision 乐观锁，串行才能在中途失败时
   * 明确停在第一个冲突上，并把已经删掉的部分如实反映到列表里。
   */
  const deleteSelected = useCallback(async () => {
    if (!props.client || !selectedIds.size || batchBusy) return;
    const targets = tasks.filter((record) => selectedIds.has(record.definition.id));
    if (!window.confirm(t("automation.batch_delete_confirm", { count: targets.length }))) return;
    setBatchBusy(true);
    let removed = 0;
    try {
      for (const record of targets) {
        await props.client.deleteAutomation(record.definition.id, record.definition.revision);
        removed += 1;
      }
      toast.success(t("automation.batch_deleted", { count: removed }));
      setSelecting(false);
      setSelectedIds(new Set());
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setBatchBusy(false);
      await refresh();
    }
  }, [batchBusy, props.client, refresh, selectedIds, tasks]);

  useEffect(() => { setNextCursor(undefined); void load(); }, [load]);
  const normalized = query.trim().toLocaleLowerCase();
  const visibleTasks = tasks.filter(({ definition }) => !normalized || `${definition.name} ${definition.workspace.name}`.toLocaleLowerCase().includes(normalized));
  const visibleRuns = runs.filter((run) => !normalized || `${run.automationName} ${run.workspaceName} ${run.errorMessage ?? ""}`.toLocaleLowerCase().includes(normalized));

  return (
    <div className="mx-auto flex min-h-full max-w-[1500px] flex-col px-6 py-5 lg:px-10">
      <header className="flex flex-wrap items-center gap-3">
        <SegmentedTabs history={props.history} />
        <div className="ml-auto flex items-center gap-3">
          {(!props.history && tasks.length > 0) || (props.history && runs.length > 0) ? (
            <label className="relative hidden sm:block">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("automation.search")} className="h-11 w-72 rounded-xl bg-dls-hover pl-9 pr-3 text-sm outline-none" />
            </label>
          ) : null}
          {/* TIPS:有任务之后模板画廊从列表底部挪到「从模版添加」入口后面，列表页只留任务本身。 */}
          {!props.history && tasks.length > 0 ? (
            <>
              <button
                type="button"
                onClick={() => { setSelecting((value) => !value); setSelectedIds(new Set()); }}
                className={cn(
                  "inline-flex h-11 items-center gap-2 rounded-xl border border-dls-border px-4 text-sm transition-colors hover:bg-dls-hover",
                  selecting && "border-dls-text bg-dls-hover",
                )}
              >
                <ListChecks className="size-4" />{selecting ? t("automation.batch_exit") : t("automation.batch_manage")}
              </button>
              <button type="button" onClick={() => navigate("/automations/templates")} className="inline-flex h-11 items-center gap-2 rounded-xl border border-dls-border px-4 text-sm transition-colors hover:bg-dls-hover">
                <Newspaper className="size-4" />{t("automation.from_template")}
              </button>
            </>
          ) : null}
          {!props.history ? (
            <button type="button" onClick={() => navigate("/automations/new")} className="inline-flex h-11 items-center gap-2 rounded-xl bg-dls-text px-5 text-sm font-medium text-background hover:opacity-90">
              <Plus className="size-4" />{t("automation.add")}
            </button>
          ) : null}
        </div>
      </header>

      {props.history && (runs.length > 0 || status || trigger || fromDate || toDate) ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="运行记录筛选">
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={FIELD} aria-label="运行状态"><option value="">全部状态</option>{(["queued", "running", "succeeded", "failed", "skipped", "cancelled"] as const).map((value) => <option key={value} value={value}>{runStateLabel(value)}</option>)}</select>
          <select value={trigger} onChange={(event) => setTrigger(event.target.value as typeof trigger)} className={FIELD} aria-label="触发来源"><option value="">全部触发方式</option>{(["scheduled", "catchup", "manual"] as const).map((value) => <option key={value} value={value}>{triggerLabel(value)}</option>)}</select>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className={FIELD} aria-label="计划时间从" />
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className={FIELD} aria-label="计划时间至" />
        </div>
      ) : null}

      {error ? <Notice tone="error">{error}<button type="button" className="ml-3 underline" onClick={() => void (props.client ? load() : props.onReconnect())}>{t("automation.retry")}</button></Notice> : null}
      {loading ? <div className="flex min-h-72 items-center justify-center text-dls-secondary">{t("automation.loading")}</div> : null}
      {!loading && props.history ? <RunHistory runs={visibleRuns} /> : null}
      {!loading && !props.history ? (
        <>
          {selecting ? (
            <BatchActionBar
              total={visibleTasks.length}
              selected={selectedIds}
              busy={batchBusy}
              onToggleAll={() => setSelectedIds((current) => (
                current.size === visibleTasks.length ? new Set() : new Set(visibleTasks.map((task) => task.definition.id))
              ))}
              onDelete={() => void deleteSelected()}
            />
          ) : null}
          {tasks.length === 0 ? <FirstAutomation onCreate={() => navigate("/automations/new")} /> : (
            <TaskList
              tasks={visibleTasks}
              client={props.client}
              reload={refresh}
              selecting={selecting}
              selectedIds={selectedIds}
              onToggleSelected={(id) => setSelectedIds((current) => {
                const next = new Set(current);
                if (!next.delete(id)) next.add(id);
                return next;
              })}
            />
          )}
          {tasks.length === 0 ? <TemplateCatalog onSelect={(template) => navigate("/automations/new", { state: { templateId: template.id } })} /> : null}
        </>
      ) : null}
      {!loading && nextCursor ? <button type="button" onClick={() => void load(nextCursor, true)} className="mx-auto mt-6 rounded-xl border border-dls-border px-5 py-2 text-sm">加载更多</button> : null}
    </div>
  );
}

function AutomationServerLoading() {
  return <div className="flex h-full items-center justify-center text-dls-secondary">{t("automation.loading")}</div>;
}

/** 本机服务不可用时提供主动重连入口。 */
function AutomationServerUnavailable(props: { onRetry: () => Promise<boolean> }) {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <Notice tone="error">
        本机服务尚未连接
        <button type="button" className="ml-3 underline" onClick={() => void props.onRetry()}>{t("automation.retry")}</button>
      </Notice>
    </div>
  );
}

function SegmentedTabs({ history }: { history: boolean }) {
  const navigate = useNavigate();
  const switchTab = (nextHistory: boolean) => navigate(nextHistory ? "/automations/runs" : "/automations");
  return (
    <div className="inline-flex rounded-xl bg-dls-hover p-1" role="tablist" aria-label="自动化视图" onKeyDown={(event) => { if (event.key === "ArrowLeft") switchTab(false); if (event.key === "ArrowRight") switchTab(true); }}>
      <button type="button" role="tab" tabIndex={history ? -1 : 0} aria-selected={!history} onClick={() => switchTab(false)} className={cn("rounded-lg px-5 py-2 text-sm", !history && "bg-background font-semibold shadow-sm")}>{t("automation.tabs.tasks")}</button>
      <button type="button" role="tab" tabIndex={history ? 0 : -1} aria-selected={history} onClick={() => switchTab(true)} className={cn("rounded-lg px-5 py-2 text-sm", history && "bg-background font-semibold shadow-sm")}>{t("automation.tabs.runs")}</button>
    </div>
  );
}

function FirstAutomation({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="flex min-h-[520px] flex-col items-center justify-center text-center">
      <AlarmClock className="mb-7 size-20 stroke-[1.25] text-dls-border" aria-hidden="true" />
      <h1 className="text-xl font-medium">{t("automation.empty_tasks")}</h1>
      <button type="button" onClick={onCreate} className="mt-8 inline-flex h-12 items-center gap-2 rounded-xl bg-dls-text px-6 font-medium text-background"><Plus className="size-4" />{t("automation.add")}</button>
    </section>
  );
}

function TaskList(props: {
  tasks: AutomationDefinitionRecord[];
  client: JuggleWorkServerClient | null;
  reload: () => Promise<void>;
  selecting: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const mutate = async (task: AutomationDefinition, action: "run" | "pause" | "resume" | "delete") => {
    if (!props.client || busy) return;
    if (action === "delete" && !window.confirm(t("automation.delete_confirm", { name: task.name }))) return;
    setBusy(task.id);
    try {
      // TIPS:立即执行只是把一条 manual run 排进本机调度器，任务列表本身不会有任何变化——
      // 没有这个提示，用户点完「执行」看到的就是一片死寂，无从判断是否触发成功。
      // TIPS:手动执行按设计不推进 next_run_at，任务定义一个字段都不会变，因此不刷新列表——
      // 刷新只会让整个列表重绘一次，用户看到的就是「点一下闪一下」。
      if (action === "run") {
        await props.client.runAutomation(task.id);
        toast.success(t("automation.run_started"), {
          action: { label: t("automation.tabs.runs"), onClick: () => navigate("/automations/runs") },
        });
        return;
      }
      if (action === "pause" || action === "resume") await props.client.setAutomationPaused(task.id, task.revision, action === "pause");
      if (action === "delete") await props.client.deleteAutomation(task.id, task.revision);
      await props.reload();
    } catch (error) {
      // TIPS:服务端用 one-active-run-per-task 拦住重复触发（overlap_blocked），这里翻译成
      // 用户能懂的说法，而不是把原始英文错误抛到界面上。
      toast.error(isOverlapBlocked(error) ? t("automation.run_already_running") : describeError(error));
    } finally {
      setBusy(null);
    }
  };
  const groups = {
    [t("automation.current")]: props.tasks.filter((task) => task.definition.lifecycle !== "completed"),
    [t("automation.ended")]: props.tasks.filter((task) => task.definition.lifecycle === "completed"),
  };
  return (
    <div className="mt-10 space-y-8">
      {Object.entries(groups).map(([label, tasks]) => tasks.length ? (
        <section key={label}>
          <h2 className="mb-3 text-sm text-dls-secondary">{label}</h2>
          <div className="space-y-1">
            {tasks.map((record) => (
              <TaskRow
                key={record.definition.id}
                record={record}
                busy={busy === record.definition.id}
                selecting={props.selecting}
                selected={props.selectedIds.has(record.definition.id)}
                onToggleSelected={() => props.onToggleSelected(record.definition.id)}
                onOpen={() => navigate(`/automations/${encodeURIComponent(record.definition.id)}`)}
                onAction={(action) => void mutate(record.definition, action)}
              />
            ))}
          </div>
        </section>
      ) : null)}
    </div>
  );
}

/**
 * 任务列表行
 *
 * TIPS:默认只显示一行摘要，鼠标悬浮才浮出「立即执行」和溢出菜单——操作按钮常驻会让长列表
 * 显得嘈杂。悬浮时右侧的下次运行时间让位给操作区，避免两者挤在一起。
 *
 * @param record 任务定义及同步状态
 * @param busy 该行正在执行操作
 * @param onOpen 打开编辑页
 * @param onAction 触发立即执行 / 暂停 / 恢复 / 删除
 */
function TaskRow({ record, busy, selecting, selected, onToggleSelected, onOpen, onAction }: {
  record: AutomationDefinitionRecord;
  busy: boolean;
  selecting: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
  onAction: (action: "run" | "pause" | "resume" | "delete") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setMenuOpen(false), []);
  useDismissOnOutside(menuRef, menuOpen, dismiss);
  const now = useNowTick(30_000);
  const task = record.definition;
  const paused = task.lifecycle === "paused";

  return (
    <article className="group relative flex h-14 items-center gap-3 rounded-xl px-4 transition-colors hover:bg-dls-hover/60">
      {selecting ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t("automation.select_task", { name: task.name })}
          onClick={onToggleSelected}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md border border-[#ebebeb] transition-colors dark:border-dls-border",
            selected && "border-dls-text bg-dls-text text-background",
          )}
        >
          {selected ? <Check size={13} strokeWidth={3} /> : null}
        </button>
      ) : null}
      <button type="button" onClick={selecting ? onToggleSelected : onOpen} className="min-w-0 flex-1 truncate text-left">
        <span className="font-medium">{task.name}</span>
        <span className="ml-3 text-sm text-dls-secondary">{task.workspace.name}</span>
        <span className="ml-3 text-sm text-dls-secondary">{summaryWithoutTimezone(scheduleLabel(task.schedule), task.schedule.timezone)}</span>
        {task.activeRange ? (
          <span className="ml-3 text-sm text-dls-secondary">
            {t("automation.active_range_prefix")} {displayDate(task.activeRange.startDate)} – {displayDate(task.activeRange.endDate)}
          </span>
        ) : null}
      </button>

      {/* TIPS:时间与操作区叠在同一个固定宽度的槽位里，用透明度切换而不是 display——
          否则悬浮时行内元素宽度突变，整行会跟着抖动。 */}
      <div className="relative h-9 w-[168px] shrink-0">
        <span className={cn(
          "absolute inset-0 flex items-center justify-end truncate text-sm text-dls-secondary transition-opacity",
          menuOpen ? "opacity-0" : "group-hover:opacity-0",
        )}>
          {taskTimingLabel(record, now)}
        </span>
        <div className={cn(
          "absolute inset-0 flex items-center justify-end gap-1 opacity-0 transition-opacity",
          selecting ? "hidden" : "group-hover:opacity-100",
          menuOpen ? "opacity-100" : "pointer-events-none group-hover:pointer-events-auto",
        )}>
        <button
          type="button"
          title={t("automation.run_now")}
          aria-label={t("automation.run_now_for", { name: task.name })}
          disabled={busy}
          onClick={() => onAction("run")}
          className="rounded-lg p-1.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40"
        >
          <Play className="size-[18px]" />
        </button>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            title={t("automation.more_actions")}
            aria-label={t("automation.more_actions_for", { name: task.name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={busy}
            onClick={() => setMenuOpen((value) => !value)}
            className="rounded-lg p-1.5 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40"
          >
            <MoreHorizontal className="size-[18px]" />
          </button>
          {menuOpen ? (
            <div role="menu" className="absolute right-0 top-full z-40 mt-1 w-36 overflow-hidden rounded-xl border border-dls-border bg-background py-1 shadow-[var(--dls-shell-shadow)]">
              <button
                type="button"
                role="menuitem"
                disabled={task.lifecycle === "completed"}
                onClick={() => { setMenuOpen(false); onAction(paused ? "resume" : "pause"); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-dls-hover disabled:opacity-40"
              >
                {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                {paused ? t("automation.resume") : t("automation.pause")}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setMenuOpen(false); onAction("delete"); }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-9 transition-colors hover:bg-red-3"
              >
                <Trash2 className="size-4" />
                {t("automation.delete")}
              </button>
            </div>
          ) : null}
        </div>
        </div>
      </div>

    </article>
  );
}

/**
 * 行右侧的执行时间文案
 *
 * TIPS:这里的文案完全由「频率算出的下一次执行时间 + 生命周期」推导，不是固定字符串：
 * 已暂停/已执行完成各自成句；`nextRunAt` 为空说明这个频率不会再产生执行（单次已消费、
 * 生效区间已结束）；已经到点但还没被调度器认领时不能说成「N 分钟前执行」，统一叫即将执行。
 *
 * @param record 任务定义及同步状态
 * @param now 当前时刻，由外部按秒级心跳传入，保证相对时间不会停在渲染那一刻
 */
function taskTimingLabel(record: AutomationDefinitionRecord, now: number): string {
  const task = record.definition;
  if (task.lifecycle === "paused") return t("automation.state_paused");
  if (task.lifecycle === "completed") return t("automation.state_completed");
  if (!task.nextRunAt) return t("automation.no_next_run");
  if (task.nextRunAt - now < 60_000) return t("automation.runs_soon");
  return t("automation.runs_in", { when: formatRelativeTo(task.nextRunAt, now) });
}

/**
 * 把未来时刻格式化为「12天后」「3小时后」这类相对时间。
 * @param target 目标时刻（epoch 毫秒）
 * @param now 参照时刻（epoch 毫秒）
 */
function formatRelativeTo(target: number, now: number): string {
  const formatter = new Intl.RelativeTimeFormat(currentLocale() === "zh" ? "zh-CN" : "en-US", { numeric: "auto" });
  const deltaMs = target - now;
  const minutes = Math.round(deltaMs / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(deltaMs / 86_400_000);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return formatter.format(Math.round(days / 30), "month");
}

/**
 * 按固定间隔返回当前时刻，用于让相对时间文案随时间自然推进。
 * @param intervalMs 心跳间隔
 */
function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * 批量操作条
 * @param total 当前可见任务数
 * @param selected 已勾选的任务 ID
 * @param busy 正在批量删除
 * @param onToggleAll 全选 / 取消全选
 * @param onDelete 删除已勾选任务
 */
function BatchActionBar({ total, selected, busy, onToggleAll, onDelete }: {
  total: number;
  selected: Set<string>;
  busy: boolean;
  onToggleAll: () => void;
  onDelete: () => void;
}) {
  const allSelected = total > 0 && selected.size === total;
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl border border-dls-border bg-background px-4 py-3">
      <button type="button" onClick={onToggleAll} className="text-sm underline-offset-2 hover:underline">
        {allSelected ? t("automation.batch_clear_all") : t("automation.batch_select_all")}
      </button>
      <span className="text-sm text-dls-secondary">{t("automation.batch_selected", { count: selected.size })}</span>
      <button
        type="button"
        disabled={!selected.size || busy}
        onClick={onDelete}
        className="ml-auto inline-flex h-9 items-center gap-2 rounded-lg bg-red-9 px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        <Trash2 className="size-4" />
        {busy ? t("automation.batch_deleting") : t("automation.delete")}
      </button>
    </div>
  );
}

/**
 * 模板画廊页
 * @param onBack 返回任务列表
 * @param onSelect 选择模板并进入新建页
 */
function TemplateGallery({ onBack, onSelect }: { onBack: () => void; onSelect: (template: AutomationTemplate) => void }) {
  return (
    <div className="mx-auto max-w-[1500px] px-6 py-5 lg:px-10">
      <AutomationBreadcrumb onBack={onBack} current={t("automation.from_template")} />
      <div className="mt-8 grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {AUTOMATION_TEMPLATES.map((template) => {
          const Icon = templateIcon(template.icon);
          const localized = template.localized[currentLocale() === "zh" ? "zh-CN" : "en-US"];
          return (
            <button key={template.id} type="button" onClick={() => onSelect(template)} className="group flex min-h-28 items-center gap-5 rounded-3xl border border-transparent bg-background px-7 py-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-dls-border hover:shadow-md focus-visible:outline-2 focus-visible:outline-dls-accent">
              <Icon className="size-8 shrink-0 stroke-[1.7]" />
              <span className="min-w-0">
                <span className="block text-lg font-semibold">{localized.title}</span>
                <span className="mt-1 line-clamp-2 block text-sm leading-6 text-dls-secondary">{localized.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 自动化二级页面的面包屑；「自动化」始终可点回列表。
 * @param onBack 返回任务列表
 * @param current 当前页名称
 */
function AutomationBreadcrumb({ onBack, current }: { onBack: () => void; current: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <AlarmClock className="size-4 shrink-0" />
      <button type="button" onClick={onBack} className="text-dls-secondary underline-offset-4 transition-colors hover:text-dls-text hover:underline">
        {t("automation.breadcrumb_root")}
      </button>
      <span className="text-dls-secondary">/</span>
      <strong className="truncate font-semibold">{current}</strong>
    </div>
  );
}

/**
 * 运行记录列表
 * @param runs 运行记录
 */
function RunHistory({ runs }: { runs: AutomationRun[] }) {
  const navigate = useNavigate();
  if (!runs.length) return (
    <section className="flex min-h-[620px] flex-col items-center justify-center text-center text-dls-secondary">
      <Clock3 className="mb-5 size-16 stroke-[1.25]" /><h1 className="text-lg font-medium text-dls-text">{t("automation.empty_runs")}</h1><p className="mt-2 text-sm">{t("automation.empty_runs_hint")}</p>
    </section>
  );
  return (
    <div className="mt-10 divide-y divide-dls-border overflow-hidden rounded-2xl border border-dls-border bg-background">
      {runs.map((run) => (
        <article key={run.id} role={run.sessionId ? "link" : undefined} tabIndex={run.sessionId ? 0 : undefined} onKeyDown={(event) => { if (run.sessionId && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); navigate(`/workspace/${encodeURIComponent(run.workspaceId)}/session/${encodeURIComponent(run.sessionId)}`); } }} onClick={() => run.sessionId && navigate(`/workspace/${encodeURIComponent(run.workspaceId)}/session/${encodeURIComponent(run.sessionId)}`)} className={cn("grid gap-2 px-5 py-4 md:grid-cols-[minmax(180px,1fr)_160px_160px_120px]", run.sessionId && "cursor-pointer hover:bg-dls-hover/50 focus-visible:outline-2 focus-visible:outline-dls-accent")}>
          <div><div className="font-medium">{run.automationName}</div><div className="text-xs text-dls-secondary">{run.workspaceName} · {triggerLabel(run.triggerSource)}</div></div>
          <div className="text-sm"><div className="text-dls-secondary">计划时间</div>{formatDateTime(run.scheduledFor)}</div>
          <div className="text-sm"><div className="text-dls-secondary">实际时间</div>{run.startedAt ? formatDateTime(run.startedAt) : "—"}<div className="text-xs text-dls-secondary">耗时 {runDuration(run)}</div></div>
          <div className={cn("text-sm font-medium", run.state === "failed" && "text-red-9", run.state === "succeeded" && "text-green-9")}>{runStateLabel(run.state)}
            {run.errorCode ? <div className="mt-1 max-w-xs text-xs font-normal text-red-9">{automationFailureAdvice(run.errorCode)}</div> : run.errorMessage ? <div className="mt-1 max-w-xs text-xs font-normal text-red-9">{run.errorMessage}</div> : null}</div>
        </article>
      ))}
    </div>
  );
}

function TemplateCatalog({ onSelect }: { onSelect: (template: AutomationTemplate) => void }) {
  return (
    <section className="mt-auto pt-14">
      <h2 className="mb-7 text-2xl font-semibold">{t("automation.templates")}</h2>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {AUTOMATION_TEMPLATES.map((template) => {
          const Icon = templateIcon(template.icon);
          return (
            <button key={template.id} type="button" onClick={() => onSelect(template)} className="group flex min-h-32 items-center gap-5 rounded-3xl border border-transparent bg-background px-7 py-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-dls-border hover:shadow-md focus-visible:outline-2 focus-visible:outline-dls-accent">
              <Icon className="size-8 shrink-0 stroke-[1.7]" />
              <span className="min-w-0"><span className="block text-lg font-semibold">{template.localized[currentLocale() === "zh" ? "zh-CN" : "en-US"].title}</span><span className="mt-1 line-clamp-2 block text-sm leading-6 text-dls-secondary">{template.localized[currentLocale() === "zh" ? "zh-CN" : "en-US"].description}</span></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AutomationEditor(props: {
  client: JuggleWorkServerClient | null;
  onManageConnectors?: () => void;
  automationId: string | null;
  duplicateSourceId: string | null;
  templateId: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const template = AUTOMATION_TEMPLATES.find((item) => item.id === props.templateId);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [name, setName] = useState(template?.title ?? "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  const [schedule, setSchedule] = useState<AutomationSchedule>(() => templateSchedule(template, timezone));
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [connectors, setConnectors] = useState<AutomationConnectorSelection[]>([]);
  const [dependencies, setDependencies] = useState<AutomationDependencies>(EMPTY_DEPENDENCIES);
  const [dependenciesLoading, setDependenciesLoading] = useState(false);
  const [dependenciesError, setDependenciesError] = useState<string | null>(null);
  const [reloadDependenciesToken, setReloadDependenciesToken] = useState(0);
  const [legacyConnectors, setLegacyConnectors] = useState<Array<{ id: string; label: string; ready: boolean }> | null>(null);
  const [model, setModel] = useState<AutomationModelSelection>({ mode: "auto" });
  const [modelTouched, setModelTouched] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [lifecycle, setLifecycle] = useState<"enabled" | "paused">("enabled");
  const [permission, setPermission] = useState<AutomationPermissionProfile>(AUTOMATION_PERMISSION_PROFILE);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(props.automationId));
  const [error, setError] = useState<string | null>(null);
  const [warningVisible, setWarningVisible] = useState(true);
  const [baseline, setBaseline] = useState<string | null>(null);
  const orgConnectors = useOrgMcpConnections();
  const promptEditorRef = useRef<LexicalPromptEditorHandle>(null);
  const local = useLocal();

  useEffect(() => {
    if (!props.client) return;
    void props.client.listWorkspaces().then((list) => setWorkspaces((list.items ?? list.workspaces ?? []).filter((item) => item.workspaceType !== "remote")));
    if (!props.automationId) return;
    void props.client.getAutomation(props.automationId).then(({ item }) => {
      const definition = item.definition;
      setBaseRevision(definition.revision);
      setName(definition.name);
      setWorkspaceId(definition.workspace.id);
      setPrompt(serializeAutomationPrompt(definition.prompt));
      setSchedule(definition.schedule);
      setStartDate(definition.activeRange?.startDate ?? "");
      setEndDate(definition.activeRange?.endDate ?? "");
      setConnectors(definition.connectors);
      setModel(definition.model);
      setAgentId(definition.agentId ?? "");
      setPermission(isAutomationPermissionProfile(definition.permission.profile) ? definition.permission.profile : AUTOMATION_PERMISSION_PROFILE);
      setLifecycle(definition.lifecycle === "paused" ? "paused" : "enabled");
    }).catch((loadError) => setError(describeError(loadError))).finally(() => setLoading(false));
  }, [props.automationId, props.client]);

  useEffect(() => {
    if (!props.client || !props.duplicateSourceId) return;
    setLoading(true);
    void props.client.duplicateAutomation(props.duplicateSourceId).then(({ draft }) => {
      setName(draft.name);
      setWorkspaceId(draft.workspace?.id ?? "");
      setPrompt(serializeAutomationPrompt(draft.prompt));
      if (draft.schedule) setSchedule(draft.schedule);
      setStartDate(draft.activeRange?.startDate ?? "");
      setEndDate(draft.activeRange?.endDate ?? "");
      setConnectors(draft.connectors);
      setModel(draft.model);
      setAgentId(draft.agentId ?? "");
      if (draft.permission && isAutomationPermissionProfile(draft.permission.profile)) setPermission(draft.permission.profile);
      setLifecycle(draft.lifecycle);
    }).catch((loadError) => setError(describeError(loadError))).finally(() => setLoading(false));
  }, [props.client, props.duplicateSourceId]);

  // TIPS:还没选工作空间时，用工作空间列表里的第一个本机工作空间去查依赖——模型和智能体本来
  // 就是用户级配置，技能/连接器则先给出全局那一份。这里在客户端就选好 ID，而不是只依赖服务端
  // 回落：旧版本 embedded server 的该接口把 workspaceId 当必填，缺参会直接 400。
  const dependencyWorkspaceId = workspaceId || workspaces[0]?.id || "";
  useEffect(() => {
    if (!props.client) {
      setDependencies(EMPTY_DEPENDENCIES);
      return;
    }
    let cancelled = false;
    setDependenciesLoading(true);
    setDependenciesError(null);
    void props.client.listAutomationDependencies(dependencyWorkspaceId || undefined).then((value) => {
      if (!cancelled) setDependencies(value);
    }).catch((dependencyError) => {
      // 不要把失败悄悄变成空列表——那会让「没有可选模型」和「查询失败」看起来一模一样。
      if (cancelled) return;
      setDependencies(EMPTY_DEPENDENCIES);
      setDependenciesError(describeError(dependencyError));
    }).finally(() => { if (!cancelled) setDependenciesLoading(false); });
    return () => { cancelled = true; };
  }, [dependencyWorkspaceId, props.client, reloadDependenciesToken]);

  // TIPS:`connectors` 字段缺失（undefined）表示 embedded server 还是旧版本，此时退回单独查
  // MCP 列表；返回空数组则是「确实没有连接器」，不再重复请求。
  useEffect(() => {
    if (!props.client || dependencies.connectors !== undefined || !dependencyWorkspaceId) {
      setLegacyConnectors(null);
      return;
    }
    let cancelled = false;
    void props.client.listMcp(dependencyWorkspaceId).then(({ items }) => {
      if (!cancelled) setLegacyConnectors(items.map((item) => ({ id: item.name, label: item.name, ready: item.disabledByTools !== true })));
    }).catch(() => { if (!cancelled) setLegacyConnectors(null); });
    return () => { cancelled = true; };
  }, [dependencies.connectors, dependencyWorkspaceId, props.client]);

  const selectedWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);
  const cloudConnectors = (AUTOMATION_CLOUD_CONNECTOR_SCOPE_ENABLED ? orgConnectors.connections : []).map((connection) => ({
    id: connection.id,
    label: connection.name,
    source: "cloud" as const,
    ready: isOrgMcpConnectionReady(connection),
  }));
  const connectorOptions = [
    ...(dependencies.connectors ?? legacyConnectors ?? []).map((item) => ({ ...item, source: "local-mcp" as const })),
    ...cloudConnectors,
  ].sort((left, right) => left.label.localeCompare(right.label));
  // TIPS:内置默认智能体在选择器里已经以「默认智能体」单独呈现，这里再兜一层，防止旧版本
  // embedded server 没做过滤时又重复列出来。
  const selectableDependencies = useMemo(
    () => ({ ...dependencies, agents: dependencies.agents.filter((agent) => agent.id !== BUILT_IN_DEFAULT_AGENT) }),
    [dependencies],
  );
  const selectedModel = model.mode === "explicit" ? dependencies.models.find(
    (item) => item.providerId === model.providerId && item.modelId === model.modelId,
  ) : undefined;

  // TIPS:新建任务默认落在「全局默认模型」上（模型列表里能找到时），而不是 Auto——自动化是无人值守
  // 执行，明确的模型比隐式路由更可预期。用户一旦手动改过就不再覆盖。
  useEffect(() => {
    if (modelTouched || props.automationId || props.duplicateSourceId) return;
    if (model.mode === "explicit" || !dependencies.models.length) return;
    const preferred = local.prefs.defaultModel;
    const match = preferred
      ? dependencies.models.find((item) => item.providerId === preferred.providerID && item.modelId === preferred.modelID)
      : undefined;
    const fallback = match ?? dependencies.models[0];
    setModel({ mode: "explicit", providerId: fallback.providerId, modelId: fallback.modelId });
  }, [dependencies.models, local.prefs.defaultModel, model.mode, modelTouched, props.automationId, props.duplicateSourceId]);

  const applyModel = useCallback((next: AutomationModelSelection) => {
    setModelTouched(true);
    setModel(next);
  }, []);
  // TIPS:技能以 tag 形式内嵌在提示词里，skillIds 从草稿反推，避免出现「输入框里没有但仍被当作依赖」的幽灵技能。
  const skillIds = useMemo(() => { try { return readAutomationSkillIds(prompt); } catch { return []; } }, [prompt]);
  const fingerprint = editorFingerprint({ name, workspaceId, prompt, schedule, startDate, endDate, connectors, model, agentId, skillIds, lifecycle, permission });

  useEffect(() => {
    if (!loading && baseline === null) setBaseline(fingerprint);
  }, [baseline, fingerprint, loading]);

  useEffect(() => {
    props.onDirtyChange(baseline !== null && fingerprint !== baseline);
  }, [baseline, fingerprint, props.onDirtyChange]);

  useEffect(() => () => props.onDirtyChange(false), [props.onDirtyChange]);
  // TIPS:技能通过编辑器句柄插入到光标处，落到草稿文本里就是一个 `[skill id]` tag。
  const insertSkill = useCallback((skillId: string) => promptEditorRef.current?.insertSkillAtSelection(skillId), []);
  // TIPS:切到单次任务时同步清空生效区间，避免隐藏的旧区间把唯一一次触发过滤掉。
  const applySchedule = useCallback((next: AutomationSchedule) => {
    setSchedule(next);
    if (next.kind === "once") {
      setStartDate("");
      setEndDate("");
    }
  }, []);
  const requestSave = () => {
    const validationError = validateEditor({ name, workspaceId, prompt, schedule, startDate, endDate })
      ?? dependencyReadinessError(model, agentId, skillIds, dependencies)
      ?? connectorReadinessError(connectors, connectorOptions);
    setError(validationError);
    if (validationError) return;
    // TIPS:只有「完全访问权限」需要那份风险确认；默认权限本来就会逐项询问用户，再弹一次纯属噪音。
    if (permission !== AUTOMATION_PERMISSION_PROFILE) {
      setRiskAccepted(true);
      void save(true);
      return;
    }
    setRiskAccepted(false);
    setPermissionOpen(true);
  };
  const save = async (acknowledged = riskAccepted) => {
    if (!props.client || !selectedWorkspace || !acknowledged) return;
    setSaving(true);
    setError(null);
    const now = Date.now();
    const draft: AutomationDraft = {
      name,
      workspace: {
        id: selectedWorkspace.id,
        name: selectedWorkspace.displayName?.trim() || selectedWorkspace.name || selectedWorkspace.id,
        path: selectedWorkspace.path,
        workspaceType: "local",
      },
      prompt: parseAutomationPrompt(prompt),
      timezone: schedule.timezone,
      schedule,
      ...(startDate && endDate ? { activeRange: { startDate, endDate } } : {}),
      model,
      ...(agentId ? { agentId } : {}),
      skillIds,
      connectors,
      permission: { profile: permission, acknowledgedAt: now },
      lifecycle,
      executorDeviceId: readAutomationDeviceId(),
    };
    try {
      if (props.automationId && baseRevision) await props.client.updateAutomation(props.automationId, baseRevision, draft);
      else await props.client.createAutomation(draft);
      props.onSaved();
    } catch (saveError) {
      setPermissionOpen(false);
      setError(describeError(saveError));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center text-dls-secondary">正在加载…</div>;
  return (
    <div className="mx-auto max-w-6xl px-6 py-5 lg:px-10" aria-busy={saving}>
      <header className="mb-8 flex items-center gap-3">
        <AutomationBreadcrumb
          onBack={props.onCancel}
          current={name || t(props.automationId ? "automation.edit_task" : "automation.new_task")}
        />
        <div className="ml-auto flex gap-3"><button type="button" onClick={props.onCancel} className="h-11 rounded-xl bg-dls-hover px-6">{t("automation.cancel")}</button><button type="button" disabled={saving} onClick={requestSave} className="h-11 rounded-xl bg-dls-text px-6 text-background disabled:opacity-50">{saving ? t("automation.saving") : t("automation.save")}</button></div>
      </header>
      {warningVisible ? <Notice>{t("automation.warning")}<button type="button" aria-label="关闭自动化运行提示" onClick={() => setWarningVisible(false)} className="float-right rounded p-0.5"><X className="size-4" /></button></Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="mt-7 space-y-7">
        <Field label={t("automation.name")}><input maxLength={100} value={name} onChange={(event) => setName(event.target.value)} className={FIELD} placeholder={t("automation.name_placeholder")} aria-label={t("automation.name")} /></Field>
        <Field label={t("automation.workspace")} hint={t("automation.workspace_hint")}>
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} className={FIELD} aria-label={t("automation.workspace")}><option value="">{t("automation.workspace_placeholder")}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.displayName || workspace.name || workspace.id}</option>)}</select>
        </Field>
        <Field label={t("automation.prompt")}>
          <AutomationPromptComposer
            value={prompt}
            onChange={setPrompt}
            dependencies={selectableDependencies}
            dependenciesLoading={dependenciesLoading}
            model={model}
            onModelChange={applyModel}
            selectedModel={selectedModel}
            agentId={agentId}
            onAgentChange={setAgentId}
            editorRef={promptEditorRef}
            skillIds={skillIds}
            onInsertSkill={insertSkill}
            permission={permission}
            onPermissionChange={setPermission}
          />
          <p className="mt-2 text-xs text-dls-secondary">{t("automation.prompt_hint")}</p>
          {dependenciesError ? (
            <p className="mt-2 text-xs text-red-9">
              {t("automation.dependencies_failed")}{dependenciesError}
              <button type="button" className="ml-2 underline" onClick={() => setReloadDependenciesToken((value) => value + 1)}>{t("automation.retry")}</button>
            </p>
          ) : null}
        </Field>
        <Field label={t("automation.connectors")} hint={t("automation.connectors_hint")}>
          <ConnectorMultiSelect
            selected={connectors}
            options={connectorOptions}
            connectingId={orgConnectors.connectingId}
            onToggle={(option) => setConnectors((current) => (
              current.some((connector) => connectorKey(connector) === connectorKey(option))
                ? current.filter((connector) => connectorKey(connector) !== connectorKey(option))
                : [...current, { id: option.id, label: option.label, source: option.source }]
            ))}
            onConnect={orgConnectors.connect}
            onManage={() => props.onManageConnectors?.()}
          />
          {orgConnectors.error ? <p className="mt-2 text-xs text-red-9">{t("automation.connectors_load_failed")}{orgConnectors.error}</p> : null}
          {template?.recommendedConnectorIds.length ? <p className="mt-2 text-xs text-dls-secondary">{t("automation.connectors_recommended")}{template.recommendedConnectorIds.join("、")}</p> : null}
        </Field>
        <ScheduleEditor
          value={schedule}
          onChange={applySchedule}
          client={props.client}
          activeRange={startDate && endDate ? { startDate, endDate } : undefined}
        />
        {/* TIPS:单次任务的执行日期本身就是唯一一次触发，再叠加生效区间只会互相矛盾，因此不展示。 */}
        {schedule.kind !== "once" ? (
          <Field label={t("automation.active_range")} hint={t("automation.active_range_hint")}>
            <DateRangeField
              startDate={startDate}
              endDate={endDate}
              onChange={(range) => { setStartDate(range.startDate); setEndDate(range.endDate); }}
            />
          </Field>
        ) : null}
      </div>

      {permissionOpen ? <PermissionDialog accepted={riskAccepted} saving={saving} onAccepted={setRiskAccepted} onCancel={() => setPermissionOpen(false)} onConfirm={() => void save()} /> : null}
    </div>
  );
}

type ConnectorOption = AutomationConnectorSelection & { ready: boolean };

type AutomationPromptComposerProps = {
  value: string;
  onChange: (value: string) => void;
  editorRef: React.RefObject<LexicalPromptEditorHandle | null>;
  dependencies: AutomationDependencies;
  dependenciesLoading: boolean;
  model: AutomationModelSelection;
  onModelChange: (model: AutomationModelSelection) => void;
  selectedModel: AutomationDependencies["models"][number] | undefined;
  agentId: string;
  onAgentChange: (agentId: string) => void;
  skillIds: string[];
  onInsertSkill: (skillId: string) => void;
  permission: AutomationPermissionProfile;
  onPermissionChange: (profile: AutomationPermissionProfile) => void;
};

/**
 * 自动化提示词输入区
 *
 * TIPS:布局与工作区会话页底部输入栏一致——最左是技能入口，右接智能体、模型、模型变体三个下拉。
 * 选中的技能以 tag 形式插在提示词光标处（和会话页同一个编辑器节点）。差异只有两点：没有「运行
 * 任务」按钮（自动化由调度触发），以及固定展示完全访问权限提示。
 *
 * @param value 提示词草稿文本
 * @param onChange 草稿变更回调
 * @param editorRef Lexical 编辑器句柄，用于把技能作为 tag 插入光标处
 * @param dependencies 可用的模型、智能体、技能
 * @param dependenciesLoading 依赖加载中，期间禁用选择
 * @param model 已选模型
 * @param onModelChange 模型变更回调
 * @param selectedModel 已选模型的完整描述，用于读取模型变体
 * @param agentId 已选智能体 ID，空串表示默认智能体
 * @param onAgentChange 智能体变更回调
 * @param skillIds 提示词中已引用的技能 ID，用于在菜单中打勾
 * @param onInsertSkill 把技能作为 tag 插入提示词输入框
 * @param permission 当前权限模式
 * @param onPermissionChange 权限模式变更回调
 */
function AutomationPromptComposer(props: AutomationPromptComposerProps) {
  const modelLabel = props.model.mode === "explicit"
    ? props.selectedModel?.modelName ?? props.model.modelId
    : t("automation.model_auto");
  const agentLabel = props.dependencies.agents.find((agent) => agent.id === props.agentId)?.name
    ?? t("automation.default_agent");
  const variants = props.model.mode === "explicit" ? props.selectedModel?.variants ?? [] : [];
  const modelGroups = groupModelsByProvider(props.dependencies.models);

  return (
    <div
      className={cn("relative overflow-visible rounded-[24px] border border-[#ebebeb] bg-background transition focus-within:border-dls-accent dark:border-dls-border", CARD_SHADOW)}
      data-testid="automation-prompt-composer"
    >
      <div className="min-h-44 px-5 pt-5">
        <LexicalPromptEditor
          ref={props.editorRef}
          value={props.value}
          mentions={{}}
          disabled={false}
          placeholder={t("automation.prompt_placeholder")}
          onChange={props.onChange}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-2">
        <ComposerMenu
          label={t("automation.skills")}
          title={t("automation.skills")}
          icon={<Zap size={15} />}
          disabled={props.dependenciesLoading}
          width="w-72"
        >
          {props.dependencies.skills.length ? props.dependencies.skills.map((skill) => (
            <ComposerMenuItem
              key={skill.id}
              selected={props.skillIds.includes(skill.id)}
              onSelect={() => props.onInsertSkill(skill.id)}
            >
              <span className="block truncate">{skill.name}</span>
              {skill.description ? <span className="block truncate text-[11px] text-gray-10">{skill.description}</span> : null}
            </ComposerMenuItem>
          )) : <ComposerMenuEmpty>{props.dependenciesLoading ? t("automation.loading") : t("automation.skills_empty")}</ComposerMenuEmpty>}
        </ComposerMenu>

        <ComposerMenu label={agentLabel} title={t("automation.agent")} disabled={props.dependenciesLoading}>
          <ComposerMenuItem selected={!props.agentId} onSelect={() => props.onAgentChange("")}>{t("automation.default_agent")}</ComposerMenuItem>
          {props.dependencies.agents.map((agent) => (
            <ComposerMenuItem key={agent.id} selected={props.agentId === agent.id} onSelect={() => props.onAgentChange(agent.id)}>
              <span className="block truncate">{agent.name}</span>
              {agent.description ? <span className="block truncate text-[11px] text-gray-10">{agent.description}</span> : null}
            </ComposerMenuItem>
          ))}
        </ComposerMenu>

        {/* 模型按提供商分组，与会话输入栏的模型选择器一致。 */}
        <ComposerMenu label={modelLabel} title={t("automation.model")} disabled={props.dependenciesLoading} width="w-72">
          {modelGroups.length ? modelGroups.map((group, groupIndex) => (
            <div key={group.providerName} className={cn(groupIndex > 0 && "mt-1 border-t border-dls-border pt-1")}>
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-10">{group.providerName}</div>
              {group.models.map((item) => (
                <ComposerMenuItem
                  key={`${item.providerId}:${item.modelId}`}
                  selected={props.model.mode === "explicit" && props.model.providerId === item.providerId && props.model.modelId === item.modelId}
                  onSelect={() => props.onModelChange({ mode: "explicit", providerId: item.providerId, modelId: item.modelId })}
                >
                  <span className="block truncate">{item.modelName}</span>
                </ComposerMenuItem>
              ))}
            </div>
          )) : <ComposerMenuEmpty>{props.dependenciesLoading ? t("automation.loading") : t("automation.models_empty")}</ComposerMenuEmpty>}
        </ComposerMenu>

        {variants.length ? (
          <ComposerMenu label={(props.model.mode === "explicit" ? props.model.variant : null) ?? t("automation.model_variant_default")} title={t("automation.model_variant")}>
            <ComposerMenuItem
              selected={props.model.mode === "explicit" && !props.model.variant}
              onSelect={() => { if (props.model.mode === "explicit") props.onModelChange({ ...props.model, variant: undefined }); }}
            >
              {t("automation.model_variant_default")}
            </ComposerMenuItem>
            {variants.map((variant) => (
              <ComposerMenuItem
                key={variant}
                selected={props.model.mode === "explicit" && props.model.variant === variant}
                onSelect={() => { if (props.model.mode === "explicit") props.onModelChange({ ...props.model, variant }); }}
              >
                {variant}
              </ComposerMenuItem>
            ))}
          </ComposerMenu>
        ) : null}

        <PermissionMenu value={props.permission} onChange={props.onPermissionChange} />
      </div>
    </div>
  );
}

/**
 * 权限模式选择
 *
 * TIPS:只有警示图标是橙色，文字保持和技能/模型一样的工具条灰——权限是个常驻状态，不是每次
 * 都要抢注意力的告警。
 *
 * @param value 当前权限模式
 * @param onChange 权限模式变更回调
 */
function PermissionMenu({ value, onChange }: {
  value: AutomationPermissionProfile;
  onChange: (profile: AutomationPermissionProfile) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(containerRef, open, dismiss);
  const unattended = value === AUTOMATION_PERMISSION_PROFILE;
  const options = [
    {
      profile: AUTOMATION_PERMISSION_PROFILE,
      icon: <TriangleAlert size={16} className="text-orange-9" />,
      title: t("automation.permission_full"),
      suffix: t("automation.permission_recommended"),
      description: t("automation.permission_full_desc"),
    },
    {
      profile: AUTOMATION_DEFAULT_PERMISSION_PROFILE,
      icon: <ShieldCheck size={16} />,
      title: t("automation.permission_default"),
      suffix: "",
      description: t("automation.permission_default_desc"),
    },
  ] as const;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("automation.permission_mode")}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-9 max-h-9 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12",
          open && "bg-gray-3 text-gray-12",
        )}
      >
        {unattended ? <TriangleAlert size={13} className="text-orange-9" /> : <ShieldCheck size={13} />}
        <span className="truncate">{unattended ? t("automation.permission_full") : t("automation.permission_default")}</span>
        <ChevronsUpDown size={12} />
      </button>
      {open ? (
        <div role="menu" className="absolute bottom-full left-0 z-40 mb-2 w-[340px] overflow-hidden rounded-2xl border border-dls-border bg-background p-2 shadow-[var(--dls-shell-shadow)]">
          {options.map((option) => {
            const selected = value === option.profile;
            return (
              <button
                key={option.profile}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => { onChange(option.profile); setOpen(false); }}
                className={cn(
                  "flex w-full gap-2 rounded-xl p-3 text-left transition-colors hover:bg-dls-hover",
                  selected && "bg-dls-hover",
                )}
              >
                <span className="w-4 shrink-0 pt-0.5">{selected ? <Check size={14} /> : null}</span>
                <span className="shrink-0 pt-0.5">{option.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">
                    {option.title}
                    {option.suffix ? <span className="ml-1 font-normal text-dls-secondary">（{option.suffix}）</span> : null}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-dls-secondary">{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 把模型列表按提供商分组并各自按名称排序，供模型下拉展示。 */
function groupModelsByProvider(models: AutomationDependencies["models"]) {
  const groups = new Map<string, AutomationDependencies["models"]>();
  for (const model of models) {
    const key = model.providerName || model.providerId;
    const existing = groups.get(key);
    if (existing) existing.push(model);
    else groups.set(key, [model]);
  }
  return [...groups.entries()]
    .map(([providerName, items]) => ({ providerName, models: [...items].sort((a, b) => a.modelName.localeCompare(b.modelName)) }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName));
}

/**
 * 连接器多选
 *
 * @param selected 已授权的连接器
 * @param options 可选连接器及就绪状态
 * @param connectingId 正在授权的云连接器 ID
 * @param onToggle 勾选或取消勾选
 * @param onConnect 发起云连接器授权
 * @param onManage 打开连接器管理页
 */
function ConnectorMultiSelect(props: {
  selected: AutomationConnectorSelection[];
  options: ConnectorOption[];
  connectingId: string | null;
  onToggle: (option: ConnectorOption) => void;
  onConnect: (id: string) => void | Promise<unknown>;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(containerRef, open, dismiss);
  const summary = props.selected.map((connector) => connector.label).join(", ");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("automation.connectors")}
        onClick={() => setOpen((value) => !value)}
        className={cn(FIELD, "flex items-center gap-2 text-left")}
      >
        <span className={cn("min-w-0 flex-1 truncate", !summary && "text-dls-secondary")}>
          {summary || t("automation.connectors_placeholder")}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-dls-secondary transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div role="listbox" aria-multiselectable="true" className="absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-2xl border border-dls-border bg-background shadow-[var(--dls-shell-shadow)]">
          <div className="max-h-64 overflow-y-auto p-2">
            {props.options.length ? props.options.map((option) => {
              const checked = props.selected.some((connector) => connectorKey(connector) === connectorKey(option));
              const needsAuth = !option.ready && option.source === "cloud";
              return (
                <button
                  key={connectorKey(option)}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  disabled={!option.ready && !needsAuth}
                  onClick={() => needsAuth ? void props.onConnect(option.id) : props.onToggle(option)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-dls-hover disabled:opacity-50"
                >
                  <span className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md border border-[#ebebeb] dark:border-dls-border",
                    checked && "border-dls-text bg-dls-text text-background",
                  )}>
                    {checked ? <Check size={13} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {needsAuth ? (
                    <span className="shrink-0 text-xs text-dls-secondary">
                      {props.connectingId === option.id ? t("automation.connector_connecting") : t("automation.connector_connect")}
                    </span>
                  ) : !option.ready ? (
                    <span className="shrink-0 text-xs text-orange-9">{t("automation.connector_needs_reconnect")}</span>
                  ) : null}
                </button>
              );
            }) : <p className="px-3 py-2 text-sm text-dls-secondary">{t("automation.connectors_empty")}</p>}
          </div>
          {props.onManage ? (
            <button
              type="button"
              onClick={() => { setOpen(false); props.onManage?.(); }}
              className="flex w-full items-center gap-2 border-t border-dls-border px-4 py-3 text-sm text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            >
              <ExternalLink size={14} />
              {t("automation.connectors_manage")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 点击外部或按 Esc 收起浮层。 */
function useDismissOnOutside(ref: React.RefObject<HTMLElement | null>, active: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active, onDismiss, ref]);
}

/** 输入栏工具条上的下拉菜单，交互与会话输入栏的模型/智能体选择器一致。 */
function ComposerMenu(props: {
  label: string;
  title?: string;
  icon?: React.ReactNode;
  width?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(containerRef, open, dismiss);
  return (
    <div ref={containerRef} className="relative" onClick={(event) => { if ((event.target as HTMLElement).closest("[data-menu-item]")) setOpen(false); }}>
      <button
        type="button"
        disabled={props.disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title={props.title}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-9 max-h-9 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-60",
          open && "bg-gray-3 text-gray-12",
        )}
      >
        {props.icon}
        <span className="max-w-[160px] truncate">{props.label}</span>
        <ChevronDown size={13} />
      </button>
      {open ? (
        <div role="menu" className={cn("absolute bottom-full left-0 z-40 mb-2 max-h-72 overflow-y-auto rounded-[18px] border border-dls-border bg-dls-surface p-2 shadow-[var(--dls-shell-shadow)]", props.width ?? "w-64")}>
          {props.children}
        </div>
      ) : null}
    </div>
  );
}

function ComposerMenuItem(props: { selected: boolean; disabled?: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      data-menu-item=""
      aria-checked={props.selected}
      disabled={props.disabled}
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-gray-2/70 disabled:opacity-50",
        props.selected ? "bg-gray-2 text-gray-12" : "text-gray-11",
      )}
    >
      <span className="min-w-0 flex-1">{props.children}</span>
      {props.selected ? <Check size={14} className="shrink-0 text-gray-10" /> : null}
    </button>
  );
}

function ComposerMenuEmpty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-xs text-gray-10">{children}</p>;
}

function ScheduleEditor({ value, onChange, client, activeRange }: {
  value: AutomationSchedule;
  onChange: (schedule: AutomationSchedule) => void;
  client: JuggleWorkServerClient | null;
  activeRange?: { startDate: string; endDate: string };
}) {
  const [preview, setPreview] = useState<{ summary: string; nextRunAt: number | null } | null>(null);
  useEffect(() => {
    if (!client || (value.kind === "once" && !value.localDate)) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void client.previewAutomationSchedule(value, activeRange).then((next) => {
        if (!cancelled) setPreview(next);
      }).catch(() => { if (!cancelled) setPreview(null); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [activeRange?.endDate, activeRange?.startDate, client, value]);
  // TIPS:时区始终跟随本机（Intl 解析结果），不再让用户手填 IANA 字符串——跨设备执行本就绑定在本机。
  const setKind = (kind: AutomationSchedule["kind"]) => {
    const timezone = value.timezone;
    if (kind === "calendar") onChange({ version: 1, kind, frequency: "daily", localTime: "09:00", timezone });
    if (kind === "interval") onChange({ version: 1, kind, every: 1, unit: "hour", anchorLocalDate: today(), anchorLocalTime: "00:00", timezone });
    // TIPS:单次任务默认「今天 + 当前时间后 5 分钟」，保存时才不会立刻被「必须晚于保存时间」拦下。
    if (kind === "once") onChange({ version: 1, kind, localDate: today(), localTime: inMinutes(5), timezone });
  };
  return (
    <Field label={t("automation.frequency")} hint={t("automation.frequency_hint")}>
      <div className="mb-4 inline-flex rounded-xl bg-dls-hover p-1">{(["calendar", "interval", "once"] as const).map((kind) => <button key={kind} type="button" onClick={() => setKind(kind)} className={cn("rounded-lg px-5 py-2 text-sm", value.kind === kind && "bg-background font-medium shadow-sm")}>{kind === "calendar" ? t("automation.period") : kind === "interval" ? t("automation.interval") : t("automation.once")}</button>)}</div>
      {value.kind === "calendar" ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><CalendarFields value={value} onChange={onChange} /></div> : null}
      {value.kind === "interval" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">{t("automation.schedule_every")}</span>
          <input type="number" min={1} step={1} value={value.every} onChange={(event) => onChange({ ...value, every: Number(event.target.value) })} className={cn(FIELD, "w-24 text-center")} aria-label={t("automation.schedule_interval_amount")} />
          <select value={value.unit} onChange={(event) => onChange({ ...value, unit: event.target.value as typeof value.unit })} className="h-11 rounded-xl bg-transparent px-1 text-sm outline-none" aria-label={t("automation.schedule_interval_unit")}><option value="minute">{t("automation.schedule_unit_minute")}</option><option value="hour">{t("automation.schedule_unit_hour")}</option><option value="day">{t("automation.schedule_unit_day")}</option></select>
          <WeekdayPicker
            value={value.weekdays ?? []}
            onChange={(weekdays) => onChange({ ...value, weekdays })}
            label={t("automation.schedule_weekday_limit")}
          />
        </div>
      ) : null}
      {value.kind === "once" ? (
        <div className="flex flex-wrap items-center gap-3">
          <input type="time" value={value.localTime} onChange={(event) => onChange({ ...value, localTime: event.target.value })} className={cn(FIELD, "w-36")} aria-label={t("automation.schedule_run_time")} />
          <input type="date" value={value.localDate} onChange={(event) => onChange({ ...value, localDate: event.target.value })} className={cn(FIELD, "w-44")} aria-label={t("automation.schedule_run_date")} />
        </div>
      ) : null}
      <p className="mt-3 text-xs text-dls-secondary">{summaryWithoutTimezone(preview?.summary ?? scheduleLabel(value), value.timezone)}{preview?.nextRunAt ? ` · ${t("automation.schedule_next_run")} ${formatDateTime(preview.nextRunAt)}` : ""}</p>
    </Field>
  );
}

/**
 * 星期选择器
 * @param value 已选星期（1=周一 … 7=周日）
 * @param onChange 选择变更回调
 * @param label 无障碍分组名
 */
function WeekdayPicker({ value, onChange, label }: { value: number[]; onChange: (weekdays: number[]) => void; label: string }) {
  return (
    <div className="inline-flex overflow-hidden rounded-xl border border-[#ebebeb] dark:border-dls-border" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5, 6, 7].map((day) => {
        const selected = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(selected ? value.filter((item) => item !== day) : [...value, day].sort((a, b) => a - b))}
            className={cn(
              "h-[38px] min-w-[62px] border-l border-[#ebebeb] px-3 text-sm transition-colors first:border-l-0 hover:bg-dls-hover dark:border-dls-border",
              selected && "bg-dls-text text-background hover:bg-dls-text",
            )}
          >
            {weekdayShortLabels()[day - 1]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 生效日期区间选择器
 * @param startDate 已保存的开始日期（YYYY-MM-DD），空串表示未设置
 * @param endDate 已保存的结束日期（YYYY-MM-DD），空串表示未设置
 * @param onChange 区间变更回调；只在开始和结束都确定后回传，清空时回传两个空串
 */
function DateRangeField({ startDate, endDate, onChange }: {
  startDate: string;
  endDate: string;
  onChange: (range: { startDate: string; endDate: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  // TIPS:pendingStart 只在“已点开始、未点结束”的中间态存在，此时不向上提交半个区间，避免保存校验报错。
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => startOfMonth(startDate || today()));
  const containerRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => { setOpen(false); setPendingStart(null); }, []);
  useDismissOnOutside(containerRef, open, dismiss);

  const rangeStart = pendingStart ?? startDate;
  const rangeEnd = pendingStart ? "" : endDate;
  const display = pendingStart
    ? `${displayDate(pendingStart)} —`
    : startDate && endDate ? `${displayDate(startDate)} — ${displayDate(endDate)}` : "";

  const pickDay = (date: string) => {
    if (!pendingStart || date < pendingStart) {
      setPendingStart(date);
      return;
    }
    onChange({ startDate: pendingStart, endDate: date });
    setPendingStart(null);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className={cn(FIELD, "flex items-center gap-2")}>
        <button
          type="button"
          onClick={() => { setOpen((value) => !value); setCursor(startOfMonth(startDate || today())); }}
          className="min-w-0 flex-1 truncate py-2 text-left"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {display || <span className="text-dls-secondary">{t("automation.range_placeholder")}</span>}
        </button>
        {display ? (
          <button
            type="button"
            aria-label={t("automation.range_clear")}
            onClick={() => { setPendingStart(null); onChange({ startDate: "", endDate: "" }); }}
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-dls-hover text-dls-secondary hover:text-dls-text"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div role="dialog" aria-label={t("automation.active_range")} className="absolute bottom-full left-0 z-40 mb-2 w-[340px] rounded-2xl border border-dls-border bg-background p-4 shadow-[var(--dls-shell-shadow)]">
          <div className="mb-3 flex items-center justify-between text-dls-secondary">
            <div className="flex gap-1">
              <button type="button" aria-label={t("automation.range_prev_year")} onClick={() => setCursor(shiftMonth(cursor, -12))} className="rounded-md px-2 py-1 hover:bg-dls-hover">«</button>
              <button type="button" aria-label={t("automation.range_prev_month")} onClick={() => setCursor(shiftMonth(cursor, -1))} className="rounded-md px-2 py-1 hover:bg-dls-hover">‹</button>
            </div>
            <span className="text-sm font-semibold text-dls-text">{formatMonthTitle(cursor)}</span>
            <div className="flex gap-1">
              <button type="button" aria-label={t("automation.range_next_month")} onClick={() => setCursor(shiftMonth(cursor, 1))} className="rounded-md px-2 py-1 hover:bg-dls-hover">›</button>
              <button type="button" aria-label={t("automation.range_next_year")} onClick={() => setCursor(shiftMonth(cursor, 12))} className="rounded-md px-2 py-1 hover:bg-dls-hover">»</button>
            </div>
          </div>
          <div className="grid grid-cols-7 text-center text-xs text-dls-secondary">
            {weekdayInitialLabels().map((day, index) => <span key={index} className="py-1.5">{day}</span>)}
          </div>
          <div className="grid grid-cols-7">
            {monthGrid(cursor).map((date) => {
              const outside = !date.startsWith(`${cursor.year}-${String(cursor.month).padStart(2, "0")}`);
              const edge = date === rangeStart || date === rangeEnd;
              const inside = Boolean(rangeStart && rangeEnd && date > rangeStart && date < rangeEnd);
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => pickDay(date)}
                  className={cn(
                    "h-9 text-sm transition-colors",
                    outside && !edge && !inside && "text-dls-secondary/50",
                    inside && "bg-dls-hover",
                    date === rangeStart && "rounded-l-lg bg-dls-text text-background",
                    date === rangeEnd && "rounded-r-lg bg-dls-text text-background",
                    !edge && !inside && "hover:bg-dls-hover",
                  )}
                >
                  {Number(date.slice(8))}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-dls-border pt-3 text-sm">
            <span className="text-dls-secondary">{pendingStart ? t("automation.range_pick_end") : t("automation.range_pick_start")}</span>
            <button type="button" onClick={() => setCursor(startOfMonth(today()))} className="rounded-md px-2 py-1 hover:bg-dls-hover">{t("automation.range_today")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type CalendarCursor = { year: number; month: number };

function startOfMonth(date: string): CalendarCursor {
  const [year, month] = date.split("-").map(Number);
  return { year, month };
}

function shiftMonth(cursor: CalendarCursor, delta: number): CalendarCursor {
  const value = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1 };
}

/** 返回以周一开头的 6×7 日期网格（YYYY-MM-DD），含前后月补齐日。 */
function monthGrid(cursor: CalendarCursor): string[] {
  const first = Date.UTC(cursor.year, cursor.month - 1, 1);
  const leading = (new Date(first).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => new Date(first + (index - leading) * 86_400_000).toISOString().slice(0, 10));
}

/** 星期短标签（周一…周日 / Mon…Sun），按当前语言拆分。 */
function weekdayShortLabels(): string[] {
  return t("automation.weekdays_short").split(",");
}

/** 日历表头的星期缩写。 */
function weekdayInitialLabels(): string[] {
  return t("automation.weekday_initials").split(",");
}

/** 日历标题，按当前语言格式化为「2026年8月」/「August 2026」。 */
function formatMonthTitle(cursor: CalendarCursor): string {
  return new Intl.DateTimeFormat(currentLocale() === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "long" })
    .format(Date.UTC(cursor.year, cursor.month - 1, 1));
}

/** 把 `YYYY-MM-DD` 显示成 `2026/8/25`（不补零，与列表和日期区间的写法一致）。 */
function displayDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${year}/${Number(month)}/${Number(day)}` : date;
}

/** 单次任务的执行时刻：`2026/8/12 14:55:00`。 */
function displayDateTime(date: string, time: string): string {
  return `${displayDate(date)} ${time.length === 5 ? `${time}:00` : time}`;
}

/** 频率摘要在编辑页不展示 IANA 时区（时区固定跟随本机）。 */
function summaryWithoutTimezone(summary: string, timezone: string): string {
  return summary.split(" · ").filter((segment) => segment !== timezone).join(" · ");
}

function CalendarFields({ value, onChange }: { value: Extract<AutomationSchedule, { kind: "calendar" }>; onChange: (schedule: AutomationSchedule) => void }) {
  return <>
    <select value={value.frequency} onChange={(event) => {
      const frequency = event.target.value;
      if (frequency === "daily") onChange({ version: 1, kind: "calendar", frequency, localTime: value.localTime, timezone: value.timezone });
      if (frequency === "weekly") onChange({ version: 1, kind: "calendar", frequency, weekdays: [1], localTime: value.localTime, timezone: value.timezone });
      if (frequency === "monthly") onChange({ version: 1, kind: "calendar", frequency, dayOfMonth: 1, localTime: value.localTime, timezone: value.timezone });
      if (frequency === "yearly") onChange({ version: 1, kind: "calendar", frequency, month: 1, dayOfMonth: 1, localTime: value.localTime, timezone: value.timezone });
    }} className={FIELD} aria-label={t("automation.schedule_frequency_label")}><option value="daily">{t("automation.schedule_daily")}</option><option value="weekly">{t("automation.schedule_weekly")}</option><option value="monthly">{t("automation.schedule_monthly")}</option><option value="yearly">{t("automation.schedule_yearly")}</option></select>
    {value.frequency === "weekly" ? <div className="col-span-full"><WeekdayPicker value={value.weekdays} onChange={(weekdays) => onChange({ ...value, weekdays })} label={t("automation.schedule_weekday_pick")} /></div> : null}
    {value.frequency === "monthly" ? <input type="number" min={1} max={31} value={value.dayOfMonth} onChange={(event) => onChange({ ...value, dayOfMonth: Number(event.target.value) })} className={FIELD} aria-label={t("automation.schedule_day_of_month")} /> : null}
    {value.frequency === "yearly" ? <><input type="number" min={1} max={12} value={value.month} onChange={(event) => onChange({ ...value, month: Number(event.target.value) })} className={FIELD} aria-label={t("automation.schedule_month")} /><input type="number" min={1} max={31} value={value.dayOfMonth} onChange={(event) => onChange({ ...value, dayOfMonth: Number(event.target.value) })} className={FIELD} aria-label={t("automation.schedule_day_of_month")} /></> : null}
    <input type="time" value={value.localTime} onChange={(event) => onChange({ ...value, localTime: event.target.value })} className={FIELD} aria-label={t("automation.schedule_run_time")} />
  </>;
}

function PermissionDialog(props: { accepted: boolean; saving: boolean; onAccepted: (accepted: boolean) => void; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="automation-permission-title" onKeyDown={(event) => { if (event.key === "Escape" && !props.saving) props.onCancel(); }} className="w-full max-w-xl rounded-3xl bg-background p-8 shadow-2xl">
        <h2 id="automation-permission-title" className="flex items-center gap-3 text-xl font-semibold"><span className="text-orange-9">⚠</span>{t("automation.permission_title")}</h2>
        <p className="mt-3 text-sm leading-6 text-dls-secondary">{t("automation.permission_body")}</p>
        <ul className="mt-4 list-disc space-y-2 pl-6 text-sm"><li>{t("automation.permission_files")}</li><li>{t("automation.permission_connectors")}</li><li>{t("automation.permission_commands")}</li></ul>
        <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm"><input autoFocus type="checkbox" checked={props.accepted} onChange={(event) => props.onAccepted(event.target.checked)} className="mt-0.5 size-5" /><span>{t("automation.permission_accept")}</span></label>
        <div className="mt-7 flex justify-end gap-3"><button type="button" onClick={props.onCancel} className="h-11 rounded-xl border border-dls-border px-6">{t("automation.cancel")}</button><button type="button" disabled={!props.accepted || props.saving} onClick={props.onConfirm} className="h-11 rounded-xl bg-dls-text px-6 text-background disabled:opacity-35">{t("automation.permission_confirm")}</button></div>
      </div>
    </div>
  );
}

/**
 * 表单分组
 *
 * TIPS: 这里刻意不用 <label>。分组里普遍含有按钮、下拉浮层和富文本编辑器，<label> 会把点击
 * 转发给第一个可标注后代——表现就是点标题或输入框空白处会莫名触发工具菜单。改用 role=group
 * 后每个控件各自带 aria-label，点击行为才是所见即所得。
 *
 * @param label 分组名称
 * @param hint 补充说明
 * @param children 分组内容
 */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="block" role="group" aria-label={label}>
      <span className="mb-2 block text-sm font-medium">{label} <span className="font-normal text-dls-secondary">{hint}</span></span>
      {children}
    </div>
  );
}

function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: React.ReactNode }) {
  return <div className={cn("my-4 rounded-xl border px-4 py-3 text-sm", tone === "info" ? "border-blue-7/30 bg-blue-3 text-blue-11" : "border-red-7/30 bg-red-3 text-red-11")}>{children}</div>;
}

function templateSchedule(template: AutomationTemplate | undefined, timezone: string): AutomationSchedule {
  if (template?.schedule) return { ...template.schedule, timezone } as AutomationSchedule;
  return { version: 1, kind: "once", localDate: today(), localTime: inMinutes(5), timezone };
}

/** 返回本地时间偏移若干分钟后的 HH:mm。 */
function inMinutes(minutes: number): string {
  const value = new Date(Date.now() + minutes * 60_000);
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function validateEditor(value: { name: string; workspaceId: string; prompt: string; schedule: AutomationSchedule; startDate: string; endDate: string }): string | null {
  const nameLength = [...value.name.trim()].length;
  if (nameLength < 1 || nameLength > 100) return "名称必须为 1–100 个字符";
  if (!value.workspaceId) return "请选择一个本机工作空间";
  try { parseAutomationPrompt(value.prompt); } catch (error) { return describeError(error); }
  if (Boolean(value.startDate) !== Boolean(value.endDate)) return "生效日期必须同时填写开始和结束日期";
  if (value.startDate && value.endDate < value.startDate) return "结束日期不能早于开始日期";
  if (value.schedule.kind === "once" && (!value.schedule.localDate || !value.schedule.localTime)) return "请选择单次任务的未来日期和时间";
  if (value.schedule.kind === "interval" && (!Number.isInteger(value.schedule.every) || value.schedule.every < 1)) return "间隔必须为正整数";
  if (value.schedule.kind === "calendar" && value.schedule.frequency === "weekly" && !value.schedule.weekdays.length) return "每周任务至少选择一个星期";
  return null;
}

function connectorReadinessError(
  selected: AutomationConnectorSelection[],
  available: Array<AutomationConnectorSelection & { ready: boolean }>,
): string | null {
  const unavailable = selected.find((connector) => !available.some(
    (option) => connectorKey(option) === connectorKey(connector) && option.ready,
  ));
  return unavailable ? `连接器“${unavailable.label}”不可用，请重新连接或移除后再保存` : null;
}

function dependencyReadinessError(
  model: AutomationModelSelection,
  agentId: string,
  skillIds: string[],
  dependencies: AutomationDependencies,
): string | null {
  if (model.mode === "explicit" && !dependencies.models.some(
    (item) => item.providerId === model.providerId && item.modelId === model.modelId,
  )) return "指定模型当前不可用，请重新选择";
  if (agentId && !dependencies.agents.some((agent) => agent.id === agentId)) return "指定 Agent 当前不可用，请重新选择";
  const missingSkill = skillIds.find((id) => !dependencies.skills.some((skill) => skill.id === id));
  return missingSkill ? `技能“${missingSkill}”当前不可用，请重新选择` : null;
}

function connectorKey(connector: Pick<AutomationConnectorSelection, "id" | "source">): string {
  return `${connector.source}:${connector.id}`;
}

function editorFingerprint(value: {
  name: string;
  workspaceId: string;
  prompt: string;
  schedule: AutomationSchedule;
  startDate: string;
  endDate: string;
  connectors: AutomationConnectorSelection[];
  model: AutomationModelSelection;
  agentId: string;
  skillIds: string[];
  lifecycle: "enabled" | "paused";
  permission: AutomationPermissionProfile;
}): string {
  return JSON.stringify(value);
}

function scheduleLabel(schedule: AutomationSchedule): string {
  // TIPS:单次任务只有一个时刻，不带模式名会读成一段无来由的时间戳，所以前缀「单次 ·」。
  if (schedule.kind === "once") {
    const when = schedule.localDate ? displayDateTime(schedule.localDate, schedule.localTime) : t("automation.schedule_no_date");
    return `${t("automation.once")} · ${when} · ${schedule.timezone}`;
  }
  if (schedule.kind === "interval") {
    const unit = schedule.unit === "minute" ? "分钟" : schedule.unit === "hour" ? "小时" : "天";
    const weekdays = schedule.weekdays?.length && schedule.weekdays.length < 7
      ? `（${schedule.weekdays.map((day) => `周${"一二三四五六日"[day - 1]}`).join("、")}）`
      : "";
    return `每 ${schedule.every} ${unit}${weekdays} · ${schedule.timezone}`;
  }
  if (schedule.frequency === "daily") return `每天 ${schedule.localTime} · ${schedule.timezone}`;
  if (schedule.frequency === "weekly") return `每周 ${schedule.weekdays.map((day) => `周${"一二三四五六日"[day - 1]}`).join("、")} ${schedule.localTime} · ${schedule.timezone}`;
  if (schedule.frequency === "monthly") return `每月 ${schedule.dayOfMonth} 日 ${schedule.localTime} · ${schedule.timezone}`;
  return `每年 ${schedule.month} 月 ${schedule.dayOfMonth} 日 ${schedule.localTime} · ${schedule.timezone}`;
}

function readTemplateId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as { templateId?: unknown }).templateId;
  return typeof value === "string" ? value : null;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function triggerLabel(value: AutomationRun["triggerSource"]): string {
  return value === "manual" ? t("automation.trigger_manual") : value === "catchup" ? t("automation.trigger_catchup") : t("automation.trigger_scheduled");
}

function runStateLabel(value: AutomationRun["state"]): string {
  return t(`automation.state_${value}`);
}

function runDuration(run: AutomationRun): string {
  if (!run.startedAt || !run.endedAt) return "—";
  const milliseconds = Math.max(0, run.endedAt - run.startedAt);
  if (milliseconds < 1_000) return `${milliseconds} 毫秒`;
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function automationFailureAdvice(code: string): string {
  const advice: Record<string, string> = {
    workspace_unavailable: "工作空间不可用，请重新选择本机工作空间",
    model_unavailable: "模型不可用，请编辑任务并重新选择",
    agent_unavailable: "Agent 不可用，请编辑任务并重新选择",
    skill_unavailable: "技能不可用，请重新安装或移除该技能",
    file_unavailable: "引用文件不可用，请检查工作空间相对路径",
    connector_unavailable: "连接器不可用，请检查连接状态",
    connector_reauth_required: "连接器授权已失效，请重新连接",
    connector_scope_unavailable: "云连接器任务授权不可用，请重新授权或暂时移除",
    sync_conflict: "云端已有更新，请保留本地内容并重新打开后处理冲突",
    sync_unavailable: "云同步暂不可用，将在网络或登录恢复后重试",
    automation_projection_unsupported: "服务端版本不兼容，请升级服务端",
    missed_deadline: "电脑休眠或客户端退出时间过长，本次已跳过",
    overlap_blocked: "上一次运行尚未结束，本次已跳过",
    session_lost: "运行会话已丢失，请手动重新运行",
  };
  return advice[code] ?? "执行失败，请打开运行会话查看可见详情";
}

/** 判断错误是否为「该任务已有排队或运行中的执行」。 */
function isOverlapBlocked(error: unknown): boolean {
  return error instanceof JuggleWorkServerError
    ? error.code === "overlap_blocked"
    : error instanceof Error && /overlap_blocked/.test(error.message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}

function templateIcon(key: string) {
  return {
    newspaper: Newspaper,
    languages: Languages,
    moon: MoonStar,
    clipboard: ListChecks,
    clapperboard: MoreHorizontal,
    calendar: CalendarDays,
    lightbulb: Lightbulb,
    contact: CircleCheck,
    mailbox: Mailbox,
    message: MessageCircle,
    list: ListChecks,
    image: AlarmClock,
  }[key] ?? AlarmClock;
}

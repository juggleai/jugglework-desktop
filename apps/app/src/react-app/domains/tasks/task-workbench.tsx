import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember } from "@/app/lib/den";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Columns3, List, LoaderCircle, Plus } from "lucide-react";
import { t } from "@/i18n";
import { TaskKanbanBoard } from "./task-kanban-board";
import { taskGroupCreateDefaults, TaskListTable, TaskLoadMore, type TaskQuickCreateDefaults } from "./task-list-table";
import { TaskToolbar } from "./task-toolbar";
import type { TaskWorkbenchSettings } from "./task-view-state";

export function sortLoadedProductTasks(tasks: DenProductTask[], settings: TaskWorkbenchSettings) {
  if (settings.sort !== "start_at" && settings.sort !== "completed_at") return tasks;
  const direction = settings.direction === "asc" ? 1 : -1;
  const value = (task: DenProductTask) => settings.sort === "start_at" ? task.startAt : task.completedAt;
  return [...tasks].sort((left, right) => {
    const leftValue = value(left);
    const rightValue = value(right);
    if (!leftValue && !rightValue) return left.id.localeCompare(right.id) * direction;
    if (!leftValue) return 1;
    if (!rightValue) return -1;
    return (new Date(leftValue).getTime() - new Date(rightValue).getTime() || left.id.localeCompare(right.id)) * direction;
  });
}

export function TaskWorkbench(props: { tasks: DenProductTask[]; membersByTaskId: Record<string, DenProductTaskMember[]>; members: DenOrganizationMember[]; lists: DenProductTaskList[]; listJoinError?: string | null; memberDirectoryError?: string | null; settings: TaskWorkbenchSettings; selectedTaskId: string | null; canLoadMore: boolean; loadingMore: boolean; refreshing?: boolean; quickCreatePending?: boolean; quickCreateMemberId?: string | null; onLoadMore: () => void; onRetryListJoin?: () => void; onRetryMemberDirectory?: () => void; onSettingsChange: (settings: TaskWorkbenchSettings) => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen" | "cancel") => void; onQuickCreate?: (title: string, defaults: TaskQuickCreateDefaults) => Promise<boolean> }) {
  const [inlineCreatePosition, setInlineCreatePosition] = useState<"top" | "bottom" | null>(null);
  const [inlineCreateGroupKey, setInlineCreateGroupKey] = useState<string | null>(null);
  const [inlineCreateDefaults, setInlineCreateDefaults] = useState<TaskQuickCreateDefaults>({});
  const [inlineCreateTitle, setInlineCreateTitle] = useState("");
  const [inlineCreateCreatedAt, setInlineCreateCreatedAt] = useState(() => new Date().toISOString());
  const [inlineCreateSubmitting, setInlineCreateSubmitting] = useState(false);
  const inlineCreateSubmittingRef = useRef(false);
  const openInlineCreate = (position: "top" | "bottom", groupKey?: string) => { setInlineCreateTitle(""); setInlineCreateCreatedAt(new Date().toISOString()); setInlineCreatePosition(position); setInlineCreateGroupKey(groupKey ?? null); setInlineCreateDefaults(groupKey === undefined ? {} : taskGroupCreateDefaults(props.settings.group, groupKey)); };
  const submitInlineCreate = () => {
    const title = inlineCreateTitle.trim();
    if (!title || !props.onQuickCreate || inlineCreateSubmittingRef.current) return;
    inlineCreateSubmittingRef.current = true;
    setInlineCreateSubmitting(true);
    void props.onQuickCreate(title, inlineCreateDefaults).then((created) => {
      if (created) { setInlineCreateTitle(""); setInlineCreatePosition(null); setInlineCreateGroupKey(null); setInlineCreateDefaults({}); }
    }).finally(() => {
      inlineCreateSubmittingRef.current = false;
      setInlineCreateSubmitting(false);
    });
  };
  const memberById = new Map(props.members.map((member) => [member.id, member]));
  const listById = new Map(props.lists.map((list) => [list.id, list]));
  const tasks = sortLoadedProductTasks(props.tasks, props.settings);
  return <section className="flex h-full min-h-0 w-full flex-col" aria-label={t("tasks.assigned_workbench")}>
    <div className="relative z-20 flex min-h-[46px] items-end border-b border-dls-border px-6" data-testid="task-view-tab-bar"><Tabs value={props.settings.view} onValueChange={(view) => props.onSettingsChange({ ...props.settings, view: view as TaskWorkbenchSettings["view"] })}><TabsList variant="line" aria-label={t("tasks.views")} className="h-[46px] gap-7 p-0"><WorkbenchTab value="list" active={props.settings.view === "list"} icon={<List className="size-4" />} label={t("tasks.view_list")} /><WorkbenchTab value="board" active={props.settings.view === "board"} icon={<Columns3 className="size-4" />} label={t("tasks.view_board")} /></TabsList></Tabs></div>
    <div className="flex min-h-[52px] flex-wrap items-center gap-3 px-6 pb-2 pt-3" data-testid="task-workbench-toolbar">{props.onQuickCreate ? <Button type="button" variant="outline" size="sm" data-testid="task-inline-create-top-trigger" className="h-8 rounded-md px-2.5 text-[13px] font-normal shadow-none" onClick={() => openInlineCreate("top", props.settings.group === "due" || props.settings.group === "start" ? "today" : props.settings.group === "creator" ? props.quickCreateMemberId ?? undefined : props.settings.group === "list" ? "" : undefined)}><Plus className="size-3.5" />{t("tasks.new_task")}</Button> : null}<TaskToolbar settings={props.settings} lists={props.lists} members={props.members} onChange={props.onSettingsChange} />{props.refreshing ? <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-dls-secondary" data-testid="task-filter-refreshing" role="status"><LoaderCircle className="size-3.5 animate-spin" />{t("tasks.loading")}</span> : null}</div>
    {props.listJoinError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.list_join_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryListJoin}>{t("tasks.retry")}</Button></div> : null}
    {props.memberDirectoryError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.member_directory_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryMemberDirectory}>{t("tasks.retry")}</Button></div> : null}
    {props.settings.view === "list" ? <TaskListTable tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById} fields={props.settings.fields} group={props.settings.group} selectedTaskId={props.selectedTaskId} inlineCreatePosition={inlineCreatePosition} inlineCreateGroupKey={inlineCreateGroupKey} inlineCreateDefaults={inlineCreateDefaults} inlineCreateTitle={inlineCreateTitle} inlineCreatePending={inlineCreateSubmitting || props.quickCreatePending === true} inlineCreateMemberId={props.quickCreateMemberId ?? null} inlineCreateCreatedAt={inlineCreateCreatedAt} onInlineCreatePositionChange={(position, groupKey) => { if (position) openInlineCreate(position, groupKey); else { setInlineCreateTitle(""); setInlineCreatePosition(null); setInlineCreateGroupKey(null); setInlineCreateDefaults({}); } }} onInlineCreateTitleChange={setInlineCreateTitle} onInlineCreateSubmit={submitInlineCreate} onSelect={props.onSelect} onTransition={props.onTransition} /> : <TaskKanbanBoard tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById} onSelect={props.onSelect} onTransition={props.onTransition} />}
    <TaskLoadMore visible={props.canLoadMore} pending={props.loadingMore} onLoad={props.onLoadMore} />
  </section>;
}

function WorkbenchTab(props: { value: TaskWorkbenchSettings["view"]; active: boolean; icon: ReactNode; label: string }) {
  return <TabsTrigger value={props.value} className={`relative h-[46px] rounded-none px-0 text-[14px] font-medium after:hidden ${props.active ? "!text-blue-10" : "text-dls-secondary"}`} data-testid={`task-view-tab-${props.value}`}>{props.icon}{props.label}{props.active ? <span aria-hidden="true" data-testid="task-view-active-indicator" className="absolute inset-x-0 bottom-[3px] h-[3px] rounded-t-full bg-blue-9 shadow-[0_0_0_0.5px_rgba(0,144,255,0.22)]" /> : null}</TabsTrigger>;
}

export function taskWorkbenchServerSort(settings: TaskWorkbenchSettings) {
  return settings.sort === "start_at" || settings.sort === "completed_at" ? { sort: "updated_at" as const, direction: "desc" as const } : { sort: settings.sort, direction: settings.direction };
}

export function taskWorkbenchStatuses(settings: TaskWorkbenchSettings) {
  if (settings.status === "incomplete") return ["todo" as const];
  if (settings.status === "completed") return ["completed" as const];
  return ["todo" as const, "completed" as const, "canceled" as const];
}

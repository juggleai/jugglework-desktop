import type { DenOrganizationMember, DenProductTask, DenProductTaskCompletionPolicy, DenProductTaskList, DenProductTaskMember, DenProductTaskReminder } from "@/app/lib/den";
import { productTaskListIds } from "@/app/lib/den";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Columns3, List, LoaderCircle, Plus } from "lucide-react";
import { t } from "@/i18n";
import { TaskKanbanBoard } from "./task-kanban-board";
import { defaultCustomTaskGroupKey, taskGroupCreateDefaults, TaskListTable, TaskLoadMore, taskTimeGroup, timeGroupOrder, type TaskGroupMove, type SaveTaskTitle, type TaskQuickCreateDefaults, type TaskSubtaskLoading } from "./task-list-table";
import { TaskToolbar } from "./task-toolbar";
import type { TaskReminderDraft, TaskTimeField } from "./task-date-time-cell";
import { mergeTaskManualOrder, taskWorkbenchCapabilities, taskWorkbenchGroupForView, type TaskWorkbenchSection, type TaskWorkbenchSettings, type TaskWorkbenchView } from "./task-view-state";

export function sortLoadedProductTasks(tasks: DenProductTask[], settings: TaskWorkbenchSettings, localCompletedSort = false) {
  if (settings.sort === "manual") {
    const ranks = new Map(settings.manualOrder.map((id, index) => [id, index]));
    // Unranked tasks append in server order, including tasks from newly loaded pages.
    return [...tasks].sort((left, right) => (ranks.get(left.id) ?? ranks.size) - (ranks.get(right.id) ?? ranks.size));
  }
  if (settings.sort !== "start_at" && !(settings.sort === "completed_at" && localCompletedSort)) return tasks;
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

type TaskGroupFieldEdits = {
  onListMove?: (task: DenProductTask, sourceListId: string | null, destinationListId: string | null) => Promise<boolean>;
  onPriorityChange?: (task: DenProductTask, priority: DenProductTask["priority"]) => Promise<boolean>;
};

export function TaskWorkbench(props: TaskSubtaskLoading & TaskGroupFieldEdits & { onTitleChange?: SaveTaskTitle; section?: TaskWorkbenchSection; isTaskList?: boolean; localCompletedSort?: boolean; tasks: DenProductTask[]; membersByTaskId: Record<string, DenProductTaskMember[]>; members: DenOrganizationMember[]; lists: DenProductTaskList[]; listJoinError?: string | null; memberDirectoryError?: string | null; settings: TaskWorkbenchSettings; selectedTaskId: string | null; canLoadMore: boolean; loadingMore: boolean; refreshing?: boolean; quickCreatePending?: boolean; quickCreateMemberId?: string | null; onLoadMore: () => void; onRetryListJoin?: () => void; onRetryMemberDirectory?: () => void; onSettingsChange: (settings: TaskWorkbenchSettings) => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "complete-whole" | "reopen" | "cancel") => void; onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean>; onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate?: (task: DenProductTask, name: string) => Promise<string | null>; onQuickCreate?: (title: string, defaults: TaskQuickCreateDefaults) => Promise<boolean | string> }) {
  const capabilities = taskWorkbenchCapabilities(props.section, props.isTaskList === true);
  const group = taskWorkbenchGroupForView(props.settings.group, props.settings.view, capabilities.allowCustomGrouping);
  const sort = !capabilities.allowManualSort && props.settings.sort === "manual" ? "updated_at" : props.settings.sort;
  const settings = group === props.settings.group && sort === props.settings.sort ? props.settings : { ...props.settings, group, sort };
  const hideRootSubtasks = capabilities.allowSubtaskVisibility && settings.subtaskVisibility === "hide";
  const changeView = (view: TaskWorkbenchView) => props.onSettingsChange({ ...settings, view, group: taskWorkbenchGroupForView(group, view, capabilities.allowCustomGrouping) });
  const [inlineCreatePosition, setInlineCreatePosition] = useState<"top" | "bottom" | null>(null);
  const [inlineCreateGroupKey, setInlineCreateGroupKey] = useState<string | null>(null);
  const [inlineCreateDefaults, setInlineCreateDefaults] = useState<TaskQuickCreateDefaults>({});
  const [inlineCreateTitle, setInlineCreateTitle] = useState("");
  const [inlineCreateCreatedAt, setInlineCreateCreatedAt] = useState(() => new Date().toISOString());
  const [inlineCreateSubmitting, setInlineCreateSubmitting] = useState(false);
  const inlineCreateSubmittingRef = useRef(false);
  const openInlineCreate = (position: "top" | "bottom", groupKey?: string) => { setInlineCreateTitle(""); setInlineCreateCreatedAt(new Date().toISOString()); setInlineCreatePosition(position); setInlineCreateGroupKey(groupKey ?? null); setInlineCreateDefaults(groupKey === undefined ? {} : taskGroupCreateDefaults(settings.group, groupKey)); };
  const submitInlineCreate = (liveTitle?: string) => {
    const title = (liveTitle ?? inlineCreateTitle).trim();
    if (!title || !props.onQuickCreate || inlineCreateSubmittingRef.current) return;
    const targetGroupKey = inlineCreateGroupKey;
    inlineCreateSubmittingRef.current = true;
    setInlineCreateSubmitting(true);
    void props.onQuickCreate(title, inlineCreateDefaults).then((created) => {
      if (created) {
        if (typeof created === "string" && settings.group === "custom" && targetGroupKey && targetGroupKey !== defaultCustomTaskGroupKey) {
          props.onSettingsChange({ ...settings, customGroupAssignments: { ...settings.customGroupAssignments, [created]: targetGroupKey } });
        }
        setInlineCreateTitle(""); setInlineCreatePosition(null); setInlineCreateGroupKey(null); setInlineCreateDefaults({});
      }
    }).finally(() => {
      inlineCreateSubmittingRef.current = false;
      setInlineCreateSubmitting(false);
    });
  };
  const memberById = new Map(props.members.map((member) => [member.id, member]));
  const listById = new Map(props.lists.map((list) => [list.id, list]));
  // Hide visible parent-linked rows while refreshing and when connected to older servers.
  const localSort = settings.sort === "start_at" || (settings.sort === "completed_at" && props.localCompletedSort === true);
  const tasks = sortLoadedProductTasks(hideRootSubtasks ? props.tasks.filter((task) => !task.parentTask) : props.tasks, settings, props.localCompletedSort);
  const manualSettings = (manualOrder: string[], manualFetchOrder = taskWorkbenchServerSort(settings)): TaskWorkbenchSettings => ({ ...settings, sort: "manual", direction: "desc", manualOrder, manualFetchOrder });
  const updateSortSettings = (next: TaskWorkbenchSettings) => props.onSettingsChange(next.sort === "manual" && settings.sort !== "manual"
    ? manualSettings(settings.manualOrder.length ? settings.manualOrder : tasks.map((task) => task.id), settings.manualFetchOrder)
    : next);
  const showFilingTargets = group === "list" && Boolean(props.onListMove) && tasks.some((task) => task.listFilingMoveSupported === true);
  const canMoveBetweenGroups = (group === "custom" && settings.customGroups.length > 0) ||
    ((group === "start" || group === "due") && Boolean(props.onTimeChange)) ||
    (group === "priority" && Boolean(props.onPriorityChange)) || showFilingTargets;
  const groupMove: TaskGroupMove | undefined = canMoveBetweenGroups ? (task, source, destination) => {
    if (source === destination || task.deletedAt) return;
    if (group === "custom") return () => {
      const customGroupAssignments = { ...settings.customGroupAssignments };
      if (destination === defaultCustomTaskGroupKey) delete customGroupAssignments[task.id];
      else customGroupAssignments[task.id] = destination;
      props.onSettingsChange({ ...settings, customGroupAssignments });
    };
    if (group === "priority" && props.onPriorityChange) {
      const priority = taskGroupCreateDefaults(group, destination).priority;
      if (priority) return () => props.onPriorityChange!(task, priority);
    }
    if ((group === "start" || group === "due") && props.onTimeChange && timeGroupOrder.some((key) => key === destination)) return () => {
      const field = group === "start" ? "startAt" : "dueAt";
      const now = new Date();
      let value = taskGroupCreateDefaults(group, destination, now)[field] ?? null;
      const other = group === "start" ? task.dueAt : task.startAt;
      // When the other date is in the destination bucket, use it if the
      // default would put the start after the due time. Never edit both dates.
      if (value && other && taskTimeGroup(other, group, now) === destination &&
          (group === "start" ? Date.parse(value) > Date.parse(other) : Date.parse(value) < Date.parse(other))) value = other;
      return props.onTimeChange!(task, field, value);
    };
    if (group === "list" && task.listFilingMoveSupported === true && props.onListMove) {
      const active = (id: string) => !id || listById.get(id)?.archivedAt === null;
      if (!active(source) || !active(destination) || (!destination && productTaskListIds(task).length !== 1)) return;
      return () => props.onListMove!(task, source || null, destination || null);
    }
  } : undefined;
  const dragDisabled = props.refreshing || props.loadingMore;
  const toolbarGroupKey = settings.group === "priority" ? "none"
    : settings.group === "due" || settings.group === "start" ? "today"
    : settings.group === "creator" ? props.quickCreateMemberId ?? undefined
    : settings.group === "list" ? ""
    : settings.group === "custom" ? defaultCustomTaskGroupKey : undefined;
  return <section className="flex h-full min-h-0 w-full flex-col" aria-label={t("tasks.workbench")}>
    <div className="relative z-20 flex min-h-[46px] items-end border-b border-dls-border px-6" data-testid="task-view-tab-bar"><Tabs value={settings.view} onValueChange={changeView}><TabsList variant="line" aria-label={t("tasks.views")} className="h-[46px] gap-7 p-0"><WorkbenchTab value="list" active={settings.view === "list"} icon={<List className="size-4" />} label={t("tasks.view_list")} /><WorkbenchTab value="board" active={settings.view === "board"} icon={<Columns3 className="size-4" />} label={t("tasks.view_board")} /></TabsList></Tabs></div>
    <div className="flex min-h-[52px] flex-wrap items-center gap-3 px-6 pb-2 pt-3" data-testid="task-workbench-toolbar">{props.onQuickCreate ? <Button type="button" variant="outline" size="sm" data-testid="task-inline-create-top-trigger" className="h-8 rounded-md px-2.5 text-[13px] font-normal shadow-none" onClick={() => openInlineCreate("top", toolbarGroupKey)}><Plus className="size-3.5" />{t("tasks.new_task")}</Button> : null}<TaskToolbar settings={settings} localSort={localSort} {...capabilities} lists={props.lists} members={props.members} onChange={updateSortSettings} />{props.refreshing ? <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-dls-secondary" data-testid="task-filter-refreshing" role="status"><LoaderCircle className="size-3.5 animate-spin" />{t("tasks.loading")}</span> : null}</div>
    {props.listJoinError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.list_join_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryListJoin}>{t("tasks.retry")}</Button></div> : null}
    {props.memberDirectoryError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.member_directory_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryMemberDirectory}>{t("tasks.retry")}</Button></div> : null}
    {settings.view === "list" ? <TaskListTable
      tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById}
      onTitleChange={props.onTitleChange}
      onReorder={settings.sort === "manual" ? (ids) => props.onSettingsChange({ ...settings, manualOrder: mergeTaskManualOrder(settings.manualOrder, ids) }) : undefined}
      groupMove={groupMove} showFilingTargets={showFilingTargets}
      reserveDragHandle={capabilities.allowManualSort || canMoveBetweenGroups}
      dragDisabled={dragDisabled}
      onLoadSubtasks={props.onLoadSubtasks} subtasksRevision={props.subtasksRevision}
      fields={settings.fields} group={settings.group} customGroupName={settings.customGroupName} customGroups={settings.customGroups} customGroupAssignments={settings.customGroupAssignments} selectedTaskId={props.selectedTaskId}
      inlineCreatePosition={inlineCreatePosition} inlineCreateGroupKey={inlineCreateGroupKey} inlineCreateDefaults={inlineCreateDefaults} inlineCreateTitle={inlineCreateTitle} inlineCreatePending={inlineCreateSubmitting || props.quickCreatePending === true} inlineCreateMemberId={props.quickCreateMemberId ?? null} inlineCreateCreatedAt={inlineCreateCreatedAt}
      onCustomGroupsChange={(customGroups) => { const groupIds = new Set(customGroups.map((group) => group.id)); props.onSettingsChange({ ...settings, customGroups, customGroupAssignments: Object.fromEntries(Object.entries(settings.customGroupAssignments).filter(([, groupId]) => groupIds.has(groupId))) }); }}
      onCustomGroupNameChange={(customGroupName) => props.onSettingsChange({ ...settings, customGroupName })}
      onInlineCreatePositionChange={(position, groupKey) => { if (position) openInlineCreate(position, groupKey); else { setInlineCreateTitle(""); setInlineCreatePosition(null); setInlineCreateGroupKey(null); setInlineCreateDefaults({}); } }}
      onInlineCreateTitleChange={setInlineCreateTitle} onInlineCreateSubmit={submitInlineCreate} onSelect={props.onSelect} onTransition={props.onTransition}
      onAssigneesChange={props.onAssigneesChange} onCompletionPolicyChange={props.onCompletionPolicyChange} onTimeChange={props.onTimeChange} onLoadReminders={props.onLoadReminders} onReminderChange={props.onReminderChange} onListChange={props.onListChange} onListCreate={props.onListCreate} onPriorityChange={props.onPriorityChange}
    /> : <TaskKanbanBoard tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById} currentMemberId={props.quickCreateMemberId ?? null} settings={settings} quickCreatePending={props.quickCreatePending} onSettingsChange={props.onSettingsChange} groupMove={groupMove} showFilingTargets={showFilingTargets} dragDisabled={dragDisabled} onQuickCreate={props.onQuickCreate} onSelect={props.onSelect} onTransition={props.onTransition} />}
    <TaskLoadMore visible={props.canLoadMore} pending={props.loadingMore} onLoad={props.onLoadMore} />
  </section>;
}

function WorkbenchTab(props: { value: TaskWorkbenchSettings["view"]; active: boolean; icon: ReactNode; label: string }) {
  return <TabsTrigger value={props.value} className={`relative h-[46px] rounded-none px-0 text-[14px] font-medium after:hidden ${props.active ? "!text-blue-10" : "text-dls-secondary"}`} data-testid={`task-view-tab-${props.value}`}>{props.icon}{props.label}{props.active ? <span aria-hidden="true" data-testid="task-view-active-indicator" className="absolute inset-x-0 bottom-[3px] h-[3px] rounded-t-full bg-blue-9 shadow-[0_0_0_0.5px_rgba(0,144,255,0.22)]" /> : null}</TabsTrigger>;
}

export function taskWorkbenchServerSort(settings: TaskWorkbenchSettings) {
  const fallback = { sort: "updated_at", direction: "desc" } as const;
  if (settings.sort === "manual") return settings.manualFetchOrder ?? fallback;
  return settings.sort === "start_at" ? fallback : { sort: settings.sort, direction: settings.direction };
}

export function taskWorkbenchStatuses(settings: TaskWorkbenchSettings) {
  if (settings.status === "incomplete") return ["todo" as const];
  if (settings.status === "completed") return ["completed" as const];
  return ["todo" as const, "completed" as const, "canceled" as const];
}

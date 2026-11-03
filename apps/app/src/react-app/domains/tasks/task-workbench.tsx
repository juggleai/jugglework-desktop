import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember } from "@/app/lib/den";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Columns3, List } from "lucide-react";
import { t } from "@/i18n";
import { TaskKanbanBoard } from "./task-kanban-board";
import { TaskListTable, TaskLoadMore } from "./task-list-table";
import { TaskToolbar } from "./task-toolbar";
import type { TaskWorkbenchSettings } from "./task-view-state";

export function sortLoadedProductTasks(tasks: DenProductTask[], settings: TaskWorkbenchSettings) {
  if (settings.sort !== "start_at") return tasks;
  const direction = settings.direction === "asc" ? 1 : -1;
  return [...tasks].sort((left, right) => {
    if (!left.startAt && !right.startAt) return left.id.localeCompare(right.id) * direction;
    if (!left.startAt) return 1;
    if (!right.startAt) return -1;
    return (new Date(left.startAt).getTime() - new Date(right.startAt).getTime() || left.id.localeCompare(right.id)) * direction;
  });
}

export function TaskWorkbench(props: { tasks: DenProductTask[]; membersByTaskId: Record<string, DenProductTaskMember[]>; members: DenOrganizationMember[]; lists: DenProductTaskList[]; listJoinError?: string | null; memberDirectoryError?: string | null; settings: TaskWorkbenchSettings; selectedTaskId: string | null; canLoadMore: boolean; loadingMore: boolean; onLoadMore: () => void; onRetryListJoin?: () => void; onRetryMemberDirectory?: () => void; onSettingsChange: (settings: TaskWorkbenchSettings) => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen" | "cancel") => void }) {
  const memberById = new Map(props.members.map((member) => [member.id, member]));
  const listById = new Map(props.lists.map((list) => [list.id, list]));
  const tasks = sortLoadedProductTasks(props.tasks, props.settings);
  return <section className="flex h-full min-h-0 w-full flex-col" aria-label={t("tasks.assigned_workbench")}>
    <div className="flex min-h-11 flex-wrap items-end justify-between gap-3 border-b border-dls-border px-5"><Tabs value={props.settings.view} onValueChange={(view) => props.onSettingsChange({ ...props.settings, view: view as TaskWorkbenchSettings["view"] })}><TabsList variant="line" aria-label={t("tasks.views")} className="h-11 gap-5 p-0"><WorkbenchTab value="list" active={props.settings.view === "list"} icon={<List className="size-3.5" />} label={t("tasks.view_list")} /><WorkbenchTab value="board" active={props.settings.view === "board"} icon={<Columns3 className="size-3.5" />} label={t("tasks.view_board")} /></TabsList></Tabs><div className="self-center"><TaskToolbar settings={props.settings} lists={props.lists} onChange={props.onSettingsChange} /></div></div>
    {props.listJoinError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.list_join_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryListJoin}>{t("tasks.retry")}</Button></div> : null}
    {props.memberDirectoryError ? <div className="mx-4 mt-3 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.member_directory_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryMemberDirectory}>{t("tasks.retry")}</Button></div> : null}
    {props.settings.view === "list" ? <TaskListTable tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById} fields={props.settings.fields} group={props.settings.group} selectedTaskId={props.selectedTaskId} onSelect={props.onSelect} onTransition={props.onTransition} /> : <TaskKanbanBoard tasks={tasks} membersByTaskId={props.membersByTaskId} memberById={memberById} listById={listById} onSelect={props.onSelect} onTransition={props.onTransition} />}
    <TaskLoadMore visible={props.canLoadMore} pending={props.loadingMore} onLoad={props.onLoadMore} />
  </section>;
}

function WorkbenchTab(props: { value: TaskWorkbenchSettings["view"]; active: boolean; icon: ReactNode; label: string }) {
  return <TabsTrigger value={props.value} className={`relative h-11 rounded-none px-0 text-xs after:hidden ${props.active ? "!text-blue-10" : "text-dls-secondary"}`} data-testid={`task-view-tab-${props.value}`}>{props.icon}{props.label}{props.active ? <span aria-hidden="true" data-testid="task-view-active-indicator" className="absolute inset-x-0 -bottom-px h-[3px] rounded-t-full bg-blue-9" /> : null}</TabsTrigger>;
}

export function taskWorkbenchServerSort(settings: TaskWorkbenchSettings) {
  return settings.sort === "start_at" ? { sort: "updated_at" as const, direction: "desc" as const } : { sort: settings.sort, direction: settings.direction };
}

export function taskWorkbenchStatuses(settings: TaskWorkbenchSettings) {
  if (settings.status === "incomplete") return ["todo" as const];
  if (settings.status === "completed") return ["completed" as const];
  return ["todo" as const, "completed" as const, "canceled" as const];
}

import { Calendar, Check, RotateCcw, X } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember, DenProductTaskStatus } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { taskMemberName } from "./task-list-table";

const lanes: Array<[DenProductTaskStatus, string]> = [["todo", "tasks.board_todo"], ["completed", "tasks.completed"], ["canceled", "tasks.board_canceled"]];

export function TaskKanbanBoard(props: { tasks: DenProductTask[]; membersByTaskId: Record<string, DenProductTaskMember[]>; memberById: Map<string, DenOrganizationMember>; listById: Map<string, DenProductTaskList>; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen" | "cancel") => void }) {
  return <div className="grid min-h-0 w-full flex-1 auto-cols-[minmax(270px,1fr)] grid-flow-col gap-4 overflow-auto p-5" data-testid="assigned-task-board">{lanes.map(([status, label]) => {
    const tasks = props.tasks.filter((task) => task.status === status);
    return <section key={status} className="flex min-h-64 min-w-72 flex-col rounded-xl bg-dls-sidebar" aria-label={t(label)}><header className="flex items-center justify-between border-b border-dls-border px-3 py-2.5"><h3 className="text-sm font-semibold text-dls-text">{t(label)}</h3><span className="rounded-full bg-dls-active px-2 py-0.5 text-xs text-dls-secondary">{tasks.length}</span></header><div className="space-y-2 overflow-auto p-2">{tasks.map((task) => {
      const assignees = (props.membersByTaskId[task.id] ?? []).filter((member) => member.role === "assignee").map((member) => member.memberId);
      const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
      return <article key={task.id} className="rounded-xl border border-dls-border bg-dls-surface p-3 shadow-sm"><button type="button" className="w-full text-left font-medium text-dls-text hover:underline" onClick={() => props.onSelect(task.id)}>{task.title}</button><div className="mt-3 flex items-center justify-between gap-2"><AvatarGroup>{assignees.slice(0, 3).map((id) => { const member = props.memberById.get(id); const name = taskMemberName(id, props.memberById); return <Avatar key={id} size="sm" title={name}><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>; })}{assignees.length > 3 ? <AvatarGroupCount>+{assignees.length - 3}</AvatarGroupCount> : null}</AvatarGroup>{task.dueAt ? <span className={`flex items-center gap-1 text-xs ${overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}><Calendar className="size-3" />{new Date(task.dueAt).toLocaleDateString()}</span> : null}</div><div className="mt-3 flex items-center justify-between gap-2"><span className="truncate text-xs text-dls-secondary">{task.listId ? props.listById.get(task.listId)?.name ?? task.listId : t("tasks.no_list")}</span><div className="flex gap-1">{task.status === "todo" ? <><Button size="icon-sm" variant="ghost" aria-label={t("tasks.complete")} onClick={() => props.onTransition(task, "complete")}><Check className="size-3.5" /></Button><Button size="icon-sm" variant="ghost" aria-label={t("tasks.cancel_task")} onClick={() => props.onTransition(task, "cancel")}><X className="size-3.5" /></Button></> : <Button size="icon-sm" variant="ghost" aria-label={t("tasks.reopen")} onClick={() => props.onTransition(task, "reopen")}><RotateCcw className="size-3.5" /></Button>}</div></div></article>;
    })}{!tasks.length ? <div className="p-4 text-center text-xs text-dls-secondary">{t("tasks.empty_column")}</div> : null}</div></section>;
  })}</div>;
}

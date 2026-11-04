import { ALargeSmall, CalendarDays, Check, Copy, Link2, ListTodo, RotateCcw, UserRound, type LucideIcon } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { TaskWorkbenchField, TaskWorkbenchGroup } from "./task-view-state";

type TaskPresentation = {
  tasks: DenProductTask[];
  membersByTaskId: Record<string, DenProductTaskMember[]>;
  memberById: Map<string, DenOrganizationMember>;
  listById: Map<string, DenProductTaskList>;
};

function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}...` : value; }
export function taskMemberName(memberId: string, members: Map<string, DenOrganizationMember>) {
  const member = members.get(memberId);
  return member?.user.name?.trim() || member?.user.account?.trim() || member?.user.email?.trim() || shortId(memberId) || t("tasks.unavailable");
}
function formatDate(value: string | null) {
  if (!value) return t("tasks.unavailable");
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : t("tasks.unavailable");
}
function MemberCell(props: { ids: string[]; members: Map<string, DenOrganizationMember> }) {
  if (!props.ids.length) return <span className="text-dls-secondary/80">{t("tasks.unassigned")}</span>;
  return <div className="flex max-w-56 items-center gap-1.5 overflow-hidden">{props.ids.slice(0, 3).map((id) => { const member = props.members.get(id); const name = taskMemberName(id, props.members); return <span key={id} className="flex items-center gap-1 rounded-full bg-dls-hover px-1.5 py-0.5 text-dls-text/85" title={name}><Avatar size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="max-w-24 truncate">{name}</span></span>; })}{props.ids.length > 3 ? <span>+{props.ids.length - 3}</span> : null}</div>;
}

function TaskIdCell({ id }: { id: string }) {
  return <div className="flex items-center gap-1.5 font-mono text-[12px]"><span className="select-all whitespace-nowrap" title={id}>{id}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.copy_task_id")} title={t("tasks.copy_task_id")} onClick={() => void globalThis.navigator?.clipboard?.writeText(id)}><Copy className="size-3.5" /></Button></div>;
}

const fieldLabels: Record<TaskWorkbenchField, string> = { assignee: "tasks.field_assignee", start: "tasks.field_start", due: "tasks.field_due", creator: "tasks.field_creator", created: "tasks.field_created", id: "tasks.field_id", list: "tasks.field_list" };
const fieldIcons: Partial<Record<TaskWorkbenchField, LucideIcon>> = { assignee: UserRound, start: CalendarDays, due: CalendarDays, creator: UserRound, created: CalendarDays, id: Link2, list: ListTodo };

function groupValue(task: DenProductTask, group: TaskWorkbenchGroup, presentation: TaskPresentation) {
  if (group === "list") return { key: task.listId ?? "", label: task.listId ? presentation.listById.get(task.listId)?.name ?? shortId(task.listId) : t("tasks.no_list") };
  if (group === "creator") return { key: task.creatorMemberId, label: taskMemberName(task.creatorMemberId, presentation.memberById) };
  return { key: "", label: "" };
}

export function TaskListTable(props: TaskPresentation & { fields: TaskWorkbenchField[]; group: TaskWorkbenchGroup; selectedTaskId: string | null; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen") => void; onCreateTask?: () => void }) {
  const groups = new Map<string, { label: string; tasks: DenProductTask[] }>();
  for (const task of props.tasks) {
    const group = groupValue(task, props.group, props);
    const current = groups.get(group.key);
    groups.set(group.key, { label: group.label, tasks: [...(current?.tasks ?? []), task] });
  }
  const rows = props.group === "none" ? [["", { label: "", tasks: props.tasks }] as const] : [...groups.entries()];
  return <div className="min-h-0 w-full flex-1 overflow-auto" data-testid="assigned-task-table"><table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-sm">
    <colgroup><col style={{ width: 60 }} /><col style={{ width: 300 }} />{props.fields.map((field) => <col key={field} style={{ width: field === "id" ? 260 : field === "created" ? 180 : 160 }} />)}</colgroup>
    <thead className="sticky top-0 z-10 bg-dls-surface"><tr><th className="py-3 pl-[38px] text-left text-[12px] font-normal text-dls-secondary"><ALargeSmall aria-hidden="true" className="size-4" /><span className="sr-only">{t("tasks.status")}</span></th><th className="px-0 py-3 text-left text-[12px] font-normal text-dls-secondary">{t("tasks.field_title")}</th>{props.fields.map((field) => { const FieldIcon = fieldIcons[field]; return <th key={field} className="px-4 py-3 text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-1.5">{FieldIcon ? <FieldIcon className="size-3.5" /> : null}{t(fieldLabels[field])}</span></th>; })}</tr></thead>
    <tbody>{rows.flatMap(([groupKey, group]) => [props.group !== "none" ? <tr key={`group:${groupKey}`}><th colSpan={props.fields.length + 2} className="border-b border-dls-border bg-dls-sidebar px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-dls-secondary">{group.label} <span className="font-normal">({group.tasks.length})</span></th></tr> : null, ...group.tasks.map((task) => {
      const assigneeIds = (props.membersByTaskId[task.id] ?? []).filter((member) => member.role === "assignee").map((member) => member.memberId);
      const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
      return <tr key={task.id} data-state={props.selectedTaskId === task.id ? "selected" : undefined} className="group h-12 transition-colors hover:bg-dls-hover/75 data-[state=selected]:bg-dls-active"><td className="relative py-2 pl-[38px] align-middle after:absolute after:bottom-0 after:left-[38px] after:right-0 after:h-px after:bg-dls-border"><button type="button" className={`flex size-4 items-center justify-center rounded-full border transition-colors ${task.status === "completed" ? "border-green-8 bg-green-8 text-white" : task.status === "canceled" ? "border-dls-secondary text-dls-secondary" : "border-dls-secondary hover:border-dls-accent"}`} aria-label={task.status === "todo" ? t("tasks.complete") : t("tasks.reopen")} onClick={() => props.onTransition(task, task.status === "todo" ? "complete" : "reopen")}>{task.status === "completed" ? <Check className="size-3" /> : task.status === "canceled" ? <RotateCcw className="size-2.5" /> : null}</button></td><td className="border-b border-dls-border px-0 py-2 align-middle"><button type="button" className={`block max-w-[290px] truncate text-left text-sm font-normal leading-5 text-dls-text hover:text-blue-10 ${task.status === "completed" ? "line-through opacity-60" : ""}`} onClick={() => props.onSelect(task.id)}>{task.title}</button></td>{props.fields.map((field) => <td key={field} className={`border-b border-dls-border px-4 py-2 align-middle whitespace-nowrap ${field === "due" && overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}>{field === "assignee" ? <MemberCell ids={assigneeIds} members={props.memberById} /> : field === "start" ? formatDate(task.startAt) : field === "due" ? formatDate(task.dueAt) : field === "creator" ? <MemberCell ids={[task.creatorMemberId]} members={props.memberById} /> : field === "created" ? formatDate(task.createdAt) : field === "id" ? <TaskIdCell id={task.id} /> : task.listId ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{props.listById.get(task.listId)?.name ?? shortId(task.listId)}</span> : t("tasks.no_list")}</td>)}</tr>;
    })])}{props.onCreateTask ? <tr><td className="py-2.5" /><td className="px-0 py-2.5" colSpan={props.fields.length + 1}><button type="button" onClick={props.onCreateTask} className="text-[13px] text-dls-secondary/70 transition-colors hover:text-blue-10">{t("tasks.new_task")}</button></td></tr> : null}</tbody>
  </table></div>;
}

export function TaskLoadMore(props: { visible: boolean; pending: boolean; onLoad: () => void }) {
  return props.visible ? <div className="flex justify-center border-t border-dls-border p-3"><Button variant="outline" disabled={props.pending} onClick={props.onLoad}>{props.pending ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : null;
}

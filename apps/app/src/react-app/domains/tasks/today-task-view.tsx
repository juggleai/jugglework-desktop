/** @jsxImportSource react */
import * as React from "react";
import { CalendarDays, Check, ChevronDown, ListChecks, LoaderCircle } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export type TodayTaskGroupKey = "overdue" | "due_today" | "starts_today";
export type TodayTaskGroup = { key: TodayTaskGroupKey; tasks: DenProductTask[] };

function localDayStart(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function isDateOnly(value: Date) {
  return value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 && value.getMilliseconds() === 0;
}

function validDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function todayTaskGroup(task: DenProductTask, now: Date): TodayTaskGroupKey | null {
  const today = localDayStart(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const due = validDate(task.dueAt);
  if (due && (isDateOnly(due) ? due < today : due < now)) return "overdue";
  if (due && due >= today && due < tomorrow) return "due_today";
  const start = validDate(task.startAt);
  return start && start >= today && start < tomorrow ? "starts_today" : null;
}

const priorityRank = { none: 0, low: 1, medium: 2, high: 3 } as const;

function compareNullableDates(left: string | null, right: string | null) {
  const leftTime = validDate(left)?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightTime = validDate(right)?.getTime() ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

export function groupTodayTasks(tasks: DenProductTask[], now = new Date()): TodayTaskGroup[] {
  const groups: Record<TodayTaskGroupKey, DenProductTask[]> = { overdue: [], due_today: [], starts_today: [] };
  for (const task of tasks) {
    if (task.status !== "todo") continue;
    const group = todayTaskGroup(task, now);
    if (group) groups[group].push(task);
  }
  groups.overdue.sort((left, right) => compareNullableDates(left.dueAt, right.dueAt) || priorityRank[right.priority] - priorityRank[left.priority] || left.id.localeCompare(right.id));
  groups.due_today.sort((left, right) => compareNullableDates(left.dueAt, right.dueAt) || priorityRank[right.priority] - priorityRank[left.priority] || left.id.localeCompare(right.id));
  groups.starts_today.sort((left, right) => compareNullableDates(left.startAt, right.startAt) || priorityRank[right.priority] - priorityRank[left.priority] || left.id.localeCompare(right.id));
  return (["overdue", "due_today", "starts_today"] as const).map((key) => ({ key, tasks: groups[key] })).filter((group) => group.tasks.length > 0);
}

function memberName(member: DenOrganizationMember | undefined, memberId: string) {
  return member?.user.name?.trim() || member?.user.account?.trim() || member?.user.email?.trim() || memberId;
}

function relationLabel(task: DenProductTask, members: DenProductTaskMember[], currentMemberId: string | null) {
  if (!currentMemberId) return t("tasks.today_relation_organization");
  if (members.some((member) => member.memberId === currentMemberId && member.role === "assignee")) return t("tasks.today_relation_assignee");
  if (task.creatorMemberId === currentMemberId) return t("tasks.today_relation_creator");
  if (members.some((member) => member.memberId === currentMemberId && member.role === "follower")) return t("tasks.today_relation_follower");
  if (members.some((member) => member.memberId === currentMemberId && member.role === "viewer")) return t("tasks.today_relation_viewer");
  return t("tasks.today_relation_organization");
}

function taskTimeLabel(task: DenProductTask, group: TodayTaskGroupKey, now: Date) {
  const value = group === "starts_today" && !task.dueAt ? task.startAt : task.dueAt;
  const date = validDate(value);
  if (!date) return group === "starts_today" ? t("tasks.today_starts_today") : "";
  const today = localDayStart(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (date >= today && date < tomorrow) {
    if (isDateOnly(date)) return group === "starts_today" ? t("tasks.today_starts_today") : t("tasks.today");
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(isDateOnly(date) ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }) }).format(date);
}

const groupLabel: Record<TodayTaskGroupKey, string> = {
  overdue: "tasks.group_overdue",
  due_today: "tasks.today_due_group",
  starts_today: "tasks.today_start_group",
};

function TodayTaskRow(props: {
  task: DenProductTask;
  group: TodayTaskGroupKey;
  taskMembers: DenProductTaskMember[];
  currentMemberId: string | null;
  memberById: Map<string, DenOrganizationMember>;
  listById: Map<string, DenProductTaskList>;
  now: Date;
  selected: boolean;
  onSelect: (taskId: string) => void;
  onComplete: (task: DenProductTask) => void;
}) {
  const assignees = props.taskMembers.filter((member) => member.role === "assignee");
  const currentAssigneeCompleted = props.task.completionPolicy === "all_assignees" && assignees.some((member) => member.memberId === props.currentMemberId && Boolean(member.completedAt));
  const list = props.task.listId ? props.listById.get(props.task.listId) : null;
  const time = taskTimeLabel(props.task, props.group, props.now);
  return <div data-testid={`today-task-row-${props.task.id}`} data-state={props.selected ? "selected" : undefined} className="group flex min-h-[72px] items-center gap-3 border-b border-dls-border px-4 py-3 last:border-b-0 hover:bg-dls-hover/70 data-[state=selected]:bg-dls-active">
    <button type="button" disabled={currentAssigneeCompleted} aria-label={currentAssigneeCompleted ? t("tasks.assignee_completed") : t("tasks.complete")} title={currentAssigneeCompleted ? t("tasks.waiting_for_assignees") : undefined} onClick={() => { if (!currentAssigneeCompleted) props.onComplete(props.task); }} className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-default ${currentAssigneeCompleted ? "border-blue-8 bg-blue-8 text-white" : "border-dls-secondary hover:border-blue-8 hover:bg-blue-2"}`}>{currentAssigneeCompleted ? <Check className="size-3" /> : null}</button>
    <button type="button" data-testid={`today-task-title-${props.task.id}`} onClick={() => props.onSelect(props.task.id)} className="min-w-0 flex-1 text-left">
      <span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium text-dls-text group-hover:text-blue-10">{props.task.title}</span>{props.task.priority !== "none" ? <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${props.task.priority === "high" ? "bg-red-3 text-red-10" : props.task.priority === "medium" ? "bg-amber-3 text-amber-10" : "bg-blue-3 text-blue-10"}`}>{t(`tasks.priority_${props.task.priority}`)}</span> : null}</span>
      <span className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-dls-secondary">{list ? <><span className="max-w-52 truncate">{list.marker} {list.name}</span><span aria-hidden="true">·</span></> : null}<span>{relationLabel(props.task, props.taskMembers, props.currentMemberId)}</span></span>
    </button>
    {time ? <span className={`shrink-0 text-xs ${props.group === "overdue" ? "font-medium text-red-9" : "text-dls-secondary"}`}>{time}</span> : null}
    <AvatarGroup className="ml-1 shrink-0">{assignees.slice(0, 3).map((assignee) => { const member = props.memberById.get(assignee.memberId); const name = memberName(member, assignee.memberId); return <Avatar key={assignee.memberId} size="sm" title={name}><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>; })}{assignees.length > 3 ? <AvatarGroupCount>+{assignees.length - 3}</AvatarGroupCount> : null}</AvatarGroup>
  </div>;
}

export function TodayTaskView(props: {
  tasks: DenProductTask[];
  membersByTaskId: Record<string, DenProductTaskMember[]>;
  members: DenOrganizationMember[];
  lists: DenProductTaskList[];
  currentMemberId: string | null;
  selectedTaskId: string | null;
  refreshing: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onSelect: (taskId: string) => void;
  onComplete: (task: DenProductTask) => void;
}) {
  const now = new Date();
  const groups = groupTodayTasks(props.tasks, now);
  const pendingCount = groups.reduce((count, group) => count + group.tasks.length, 0);
  const overdueCount = groups.find((group) => group.key === "overdue")?.tasks.length ?? 0;
  const [collapsed, setCollapsed] = React.useState<Partial<Record<TodayTaskGroupKey, boolean>>>({});
  const memberById = React.useMemo(() => new Map(props.members.map((member) => [member.id, member])), [props.members]);
  const listById = React.useMemo(() => new Map(props.lists.map((list) => [list.id, list])), [props.lists]);
  const dateLabel = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", weekday: "long" }).format(now);

  if (!pendingCount) return <div data-testid="today-empty" className="mx-auto flex max-w-sm flex-col items-center gap-3 self-center text-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-blue-3 text-blue-10"><CalendarDays className="size-6" /></div><div><h3 className="font-medium text-dls-text">{t("tasks.today_empty_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{t("tasks.today_empty_description")}</p></div>{props.canLoadMore ? <Button variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? t("tasks.loading") : t("tasks.load_more")}</Button> : null}</div>;

  return <div data-testid="today-task-view" className="mx-auto w-full max-w-5xl self-start pb-8">
    <header className="mb-5 flex items-start justify-between gap-4"><div><p className="text-sm text-dls-secondary">{dateLabel}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-sm"><span className="rounded-full bg-blue-3 px-2.5 py-1 font-medium text-blue-10">{t("tasks.today_pending_count", { count: pendingCount })}</span>{overdueCount ? <span className="rounded-full bg-red-3 px-2.5 py-1 font-medium text-red-10">{t("tasks.today_overdue_count", { count: overdueCount })}</span> : null}</div></div>{props.refreshing ? <span className="inline-flex items-center gap-1.5 text-xs text-dls-secondary" role="status"><LoaderCircle className="size-3.5 animate-spin" />{t("tasks.today_refreshing")}</span> : null}</header>
    <div className="space-y-5">{groups.map((group) => { const isCollapsed = collapsed[group.key] === true; return <section key={group.key} data-testid={`today-group-${group.key}`}><button type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => ({ ...current, [group.key]: !isCollapsed }))} className="mb-2 flex h-8 w-full items-center gap-2 px-1 text-left"><ChevronDown className={`size-4 text-dls-secondary transition-transform ${isCollapsed ? "-rotate-90" : ""}`} /><span className="text-sm font-semibold text-dls-text">{t(groupLabel[group.key])}</span><span className="rounded-full bg-dls-hover px-2 py-0.5 text-xs text-dls-secondary">{group.tasks.length}</span></button>{!isCollapsed ? <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface shadow-sm">{group.tasks.map((task) => <TodayTaskRow key={task.id} task={task} group={group.key} taskMembers={props.membersByTaskId[task.id] ?? []} currentMemberId={props.currentMemberId} memberById={memberById} listById={listById} now={now} selected={props.selectedTaskId === task.id} onSelect={props.onSelect} onComplete={props.onComplete} />)}</div> : null}</section>; })}</div>
    {props.canLoadMore ? <div className="mt-6 flex justify-center"><Button variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : <div className="mt-6 flex items-center justify-center gap-2 text-xs text-dls-secondary"><ListChecks className="size-3.5" />{t("tasks.today_all_loaded")}</div>}
  </div>;
}

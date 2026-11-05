import { useState } from "react";
import { ALargeSmall, CalendarDays, Check, ChevronDown, ChevronRight, Copy, Link2, ListTodo, Plus, RotateCcw, UserRound, type LucideIcon } from "lucide-react";

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
function MemberCell(props: { ids: string[]; members: Map<string, DenOrganizationMember>; emptyLabel?: string }) {
  if (!props.ids.length) return <span className="text-dls-secondary/80">{props.emptyLabel ?? t("tasks.unassigned")}</span>;
  return <div className="flex max-w-56 items-center gap-1.5 overflow-hidden">{props.ids.slice(0, 3).map((id) => { const member = props.members.get(id); const name = taskMemberName(id, props.members); return <span key={id} className="flex items-center gap-1 rounded-full bg-dls-hover px-1.5 py-0.5 text-dls-text/85" title={name}><Avatar size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="max-w-24 truncate">{name}</span></span>; })}{props.ids.length > 3 ? <span>+{props.ids.length - 3}</span> : null}</div>;
}

function CreatorGroupLabel(props: { memberId: string; members: Map<string, DenOrganizationMember> }) {
  const member = props.members.get(props.memberId);
  const name = taskMemberName(props.memberId, props.members);
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-dls-hover px-1.5 py-0.5 font-normal text-dls-text" data-testid={`task-creator-group-label-${props.memberId}`}><Avatar size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="max-w-40 truncate">{name}</span></span>;
}

function TaskIdCell({ id, displayNumber }: { id: string; displayNumber: number | null }) {
  const label = displayNumber ? `t${displayNumber}` : shortId(id);
  return <div className="flex items-center gap-1.5 font-mono text-[12px]"><span className="select-all whitespace-nowrap" title={id}>{label}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.copy_task_id")} title={t("tasks.copy_task_id")} onClick={() => void globalThis.navigator?.clipboard?.writeText(id)}><Copy className="size-3.5" /></Button></div>;
}

const fieldLabels: Record<TaskWorkbenchField, string> = { assignee: "tasks.field_assignee", start: "tasks.field_start", due: "tasks.field_due", creator: "tasks.field_creator", assigner: "tasks.field_assigner", followers: "tasks.field_followers", created: "tasks.field_created", completed: "tasks.field_completed", updated: "tasks.field_updated", id: "tasks.field_id", list: "tasks.field_list" };
const fieldIcons: Partial<Record<TaskWorkbenchField, LucideIcon>> = { assignee: UserRound, start: CalendarDays, due: CalendarDays, creator: UserRound, assigner: UserRound, followers: UserRound, created: CalendarDays, completed: CalendarDays, updated: CalendarDays, id: Link2, list: ListTodo };

type TimeGroupKey = "elapsed" | "today" | "tomorrow" | "next7" | "later" | "unscheduled";
const timeGroupOrder: TimeGroupKey[] = ["elapsed", "today", "tomorrow", "next7", "later", "unscheduled"];

function addLocalDays(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

export function taskTimeGroup(value: string | null, kind: "start" | "due", now = new Date()): TimeGroupKey {
  if (!value) return "unscheduled";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unscheduled";
  if (date.getTime() <= now.getTime()) return "elapsed";
  const tomorrow = addLocalDays(now, 1);
  const dayAfterTomorrow = addLocalDays(now, 2);
  const afterNextSevenDays = addLocalDays(now, 8);
  if (date < tomorrow) return "today";
  if (date < dayAfterTomorrow) return "tomorrow";
  if (date < afterNextSevenDays) return "next7";
  return "later";
}

function timeGroupLabel(key: TimeGroupKey, kind: "start" | "due") {
  if (key === "elapsed") return t(kind === "start" ? "tasks.group_started" : "tasks.group_overdue");
  return t(`tasks.group_time_${key}`);
}

function groupValue(task: DenProductTask, group: TaskWorkbenchGroup, presentation: TaskPresentation, now: Date) {
  if (group === "list") return { key: task.listId ?? "", label: task.listId ? presentation.listById.get(task.listId)?.name ?? shortId(task.listId) : t("tasks.no_list") };
  if (group === "creator") return { key: task.creatorMemberId, label: taskMemberName(task.creatorMemberId, presentation.memberById) };
  if (group === "start" || group === "due") {
    const key = taskTimeGroup(group === "start" ? task.startAt : task.dueAt, group, now);
    return { key, label: timeGroupLabel(key, group) };
  }
  return { key: "", label: "" };
}

type InlineCreatePosition = "top" | "bottom";
export type TaskQuickCreateDefaults = { listId?: string; startAt?: string | null; dueAt?: string | null };

export function taskGroupCreateDefaults(group: TaskWorkbenchGroup, key: string, now = new Date()): TaskQuickCreateDefaults {
  if (group === "list") return key ? { listId: key } : {};
  if (group !== "start" && group !== "due") return {};
  let value: string | null = null;
  if (key === "elapsed") value = now.toISOString();
  else if (key === "today") value = new Date((now.getTime() + addLocalDays(now, 1).getTime()) / 2).toISOString();
  else if (key === "tomorrow") value = new Date(addLocalDays(now, 1).getTime() + 12 * 60 * 60 * 1000).toISOString();
  else if (key === "next7") value = new Date(addLocalDays(now, 2).getTime() + 12 * 60 * 60 * 1000).toISOString();
  else if (key === "later") value = new Date(addLocalDays(now, 8).getTime() + 12 * 60 * 60 * 1000).toISOString();
  return group === "start" ? { startAt: value } : { dueAt: value };
}

function InlineCreateField(props: { field: TaskWorkbenchField; memberId: string | null; createdAt: string; defaults: TaskQuickCreateDefaults; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList> }) {
  if (props.field === "assignee" || props.field === "creator" || props.field === "assigner") return props.memberId ? <MemberCell ids={[props.memberId]} members={props.members} /> : <span className="text-dls-secondary/70">{t("tasks.unassigned")}</span>;
  if (props.field === "followers") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "start") return props.defaults.startAt ? <>{formatDate(props.defaults.startAt)}</> : <CalendarDays className="size-4 text-dls-secondary/45" aria-label={t(fieldLabels[props.field])} />;
  if (props.field === "due") return props.defaults.dueAt ? <>{formatDate(props.defaults.dueAt)}</> : <CalendarDays className="size-4 text-dls-secondary/45" aria-label={t(fieldLabels[props.field])} />;
  if (props.field === "created" || props.field === "updated") return <>{formatDate(props.createdAt)}</>;
  if (props.field === "completed") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "id") return <span className="font-mono">-</span>;
  return props.defaults.listId ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{props.lists.get(props.defaults.listId)?.name ?? shortId(props.defaults.listId)}</span> : <span className="text-dls-secondary/70">{t("tasks.no_list")}</span>;
}

function TaskFieldCell(props: { field: TaskWorkbenchField; task: DenProductTask; taskMembers: DenProductTaskMember[]; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList> }) {
  const assigneeIds = props.taskMembers.filter((member) => member.role === "assignee").map((member) => member.memberId);
  const followerIds = props.taskMembers.filter((member) => member.role === "follower").map((member) => member.memberId);
  const assignerIds = [...new Set(props.taskMembers.filter((member) => member.role === "assignee").map((member) => member.createdByMemberId).filter((memberId): memberId is string => Boolean(memberId)))];
  if (props.field === "assignee") return <MemberCell ids={assigneeIds} members={props.members} />;
  if (props.field === "creator") return <MemberCell ids={[props.task.creatorMemberId]} members={props.members} />;
  if (props.field === "assigner") return <MemberCell ids={assignerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "followers") return <MemberCell ids={followerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "start") return <>{formatDate(props.task.startAt)}</>;
  if (props.field === "due") return <>{formatDate(props.task.dueAt)}</>;
  if (props.field === "created") return <>{formatDate(props.task.createdAt)}</>;
  if (props.field === "completed") return <>{formatDate(props.task.completedAt)}</>;
  if (props.field === "updated") return <>{formatDate(props.task.updatedAt)}</>;
  if (props.field === "id") return <TaskIdCell id={props.task.id} displayNumber={props.task.displayNumber} />;
  return props.task.listId ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{props.lists.get(props.task.listId)?.name ?? shortId(props.task.listId)}</span> : <>{t("tasks.no_list")}</>;
}

function InlineCreateRow(props: { testId: string; fields: TaskWorkbenchField[]; title: string; pending: boolean; memberId: string | null; createdAt: string; defaults: TaskQuickCreateDefaults; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList>; onTitleChange: (title: string) => void; onSubmit: () => void; onCancel: () => void }) {
  return <tr data-testid={props.testId} className="h-12 bg-dls-active/80"><td className="border-b border-blue-6/40 py-1.5 pl-[38px] align-middle"><form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}><span className="size-4 shrink-0 rounded-full border border-dls-secondary/70" aria-hidden="true" /><input autoFocus aria-label={t("tasks.field_title")} placeholder={t("tasks.title_placeholder")} value={props.title} disabled={props.pending} onChange={(event) => props.onTitleChange(event.target.value)} onBlur={() => { if (props.pending) return; if (props.title.trim()) props.onSubmit(); else props.onCancel(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onCancel(); } }} className="h-9 min-w-0 flex-1 rounded-sm border border-blue-8 bg-dls-surface px-2 text-sm text-dls-text outline-none ring-1 ring-blue-8/20 placeholder:text-dls-secondary/60 focus:ring-2 focus:ring-blue-8/35" /></form></td>{props.fields.map((field) => <td key={field} className="border-b border-blue-6/40 px-4 py-2 align-middle whitespace-nowrap text-dls-secondary"><InlineCreateField field={field} memberId={props.memberId} createdAt={props.createdAt} defaults={props.defaults} members={props.members} lists={props.lists} /></td>)}</tr>;
}

export function TaskListTable(props: TaskPresentation & { fields: TaskWorkbenchField[]; group: TaskWorkbenchGroup; selectedTaskId: string | null; inlineCreatePosition: InlineCreatePosition | null; inlineCreateGroupKey: string | null; inlineCreateDefaults: TaskQuickCreateDefaults; inlineCreateTitle: string; inlineCreatePending: boolean; inlineCreateMemberId: string | null; inlineCreateCreatedAt: string; onInlineCreatePositionChange: (position: InlineCreatePosition | null, groupKey?: string) => void; onInlineCreateTitleChange: (title: string) => void; onInlineCreateSubmit: () => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen") => void }) {
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const visibleFields = props.fields;
  const groups = new Map<string, { label: string; tasks: DenProductTask[] }>();
  const now = new Date();
  if (props.group === "start" || props.group === "due") {
    for (const key of timeGroupOrder) groups.set(key, { label: timeGroupLabel(key, props.group), tasks: [] });
  }
  if (props.group === "creator" && props.inlineCreateMemberId) {
    groups.set(props.inlineCreateMemberId, { label: taskMemberName(props.inlineCreateMemberId, props.memberById), tasks: [] });
  }
  for (const task of props.tasks) {
    const group = groupValue(task, props.group, props, now);
    const current = groups.get(group.key);
    groups.set(group.key, { label: group.label, tasks: [...(current?.tasks ?? []), task] });
  }
  const rows = props.group === "none" ? [["", { label: "", tasks: props.tasks }] as const] : [...groups.entries()];
  const toggleGroup = (key: string, expanded: boolean) => setGroupExpansion((current) => ({ ...current, [key]: !expanded }));
  const inlineRow = (testId: string) => <InlineCreateRow key={testId} testId={testId} fields={visibleFields} title={props.inlineCreateTitle} pending={props.inlineCreatePending} memberId={props.inlineCreateMemberId} createdAt={props.inlineCreateCreatedAt} defaults={props.inlineCreateDefaults} members={props.memberById} lists={props.listById} onTitleChange={props.onInlineCreateTitleChange} onSubmit={props.onInlineCreateSubmit} onCancel={() => props.onInlineCreatePositionChange(null)} />;
  return <div className="min-h-0 w-full flex-1 overflow-auto" data-testid="assigned-task-table"><table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-sm">
    <colgroup><col style={{ width: 360 }} />{visibleFields.map((field) => <col key={field} style={{ width: field === "id" ? 260 : field === "created" || field === "completed" || field === "updated" ? 180 : 160 }} />)}</colgroup>
    <thead className="sticky top-0 z-10 bg-dls-surface"><tr><th className="py-3 pl-[38px] text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-2" data-testid="task-title-header"><ALargeSmall aria-hidden="true" className="size-4 shrink-0" />{t("tasks.field_title")}</span></th>{visibleFields.map((field) => { const FieldIcon = fieldIcons[field]; return <th key={field} className="px-4 py-3 text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-1.5">{FieldIcon ? <FieldIcon className="size-3.5" /> : null}{t(fieldLabels[field])}</span></th>; })}</tr></thead>
    <tbody>{props.inlineCreatePosition === "top" && props.inlineCreateGroupKey === null ? inlineRow("task-inline-create-row-top") : null}{rows.flatMap(([groupKey, group]) => { const collapseKey = `${props.group}:${groupKey}`; const expanded = props.inlineCreateGroupKey === groupKey || (groupExpansion[collapseKey] ?? group.tasks.length > 0); const groupInlineRow = props.inlineCreateGroupKey === groupKey ? inlineRow(`task-inline-create-row-group-${groupKey}`) : null; return [props.group !== "none" ? <tr key={`group:${groupKey}`} data-testid={`task-group-row-${groupKey}`} className="group/task-group"><th colSpan={visibleFields.length + 1} className="border-b border-dls-border px-6 py-2.5 text-left text-sm font-semibold text-dls-text"><div className="flex items-center gap-1"><button type="button" data-testid={`task-group-toggle-${groupKey}`} aria-expanded={expanded} onClick={() => toggleGroup(collapseKey, expanded)} className="inline-flex items-center gap-2 rounded-md px-1 py-1 hover:bg-dls-hover">{expanded ? <ChevronDown className="size-4 text-dls-secondary" /> : <ChevronRight className="size-4 text-dls-secondary" />}{props.group === "creator" ? <CreatorGroupLabel memberId={groupKey} members={props.memberById} /> : <span>{group.label}</span>}<span className="font-normal text-dls-secondary">{group.tasks.length}</span></button>{props.group !== "creator" ? <button type="button" data-testid={`task-group-add-${groupKey}`} aria-label={`${group.label} · ${t("tasks.new_task")}`} onClick={() => { if (!expanded) setGroupExpansion((current) => ({ ...current, [collapseKey]: true })); props.onInlineCreatePositionChange("top", groupKey); }} className="flex size-7 items-center justify-center rounded-md text-dls-secondary opacity-0 transition-opacity hover:bg-dls-hover hover:text-blue-10 focus:opacity-100 group-hover/task-group:opacity-100"><Plus className="size-4" /></button> : null}</div></th></tr> : null, ...(expanded ? [props.inlineCreatePosition === "top" ? groupInlineRow : null, ...group.tasks.map((task) => {
      const taskMembers = props.membersByTaskId[task.id] ?? [];
      const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
      return <tr key={task.id} data-state={props.selectedTaskId === task.id ? "selected" : undefined} className="group h-12 transition-colors hover:bg-dls-hover/75 data-[state=selected]:bg-dls-active"><td className="border-b border-dls-border py-2 pl-[38px] align-middle"><div className="flex items-center gap-2" data-testid={`task-title-cell-${task.id}`}><button type="button" className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors ${task.status === "completed" ? "border-green-8 bg-green-8 text-white" : task.status === "canceled" ? "border-dls-secondary text-dls-secondary" : "border-dls-secondary hover:border-dls-accent"}`} aria-label={task.status === "todo" ? t("tasks.complete") : t("tasks.reopen")} onClick={() => props.onTransition(task, task.status === "todo" ? "complete" : "reopen")}>{task.status === "completed" ? <Check className="size-3" /> : task.status === "canceled" ? <RotateCcw className="size-2.5" /> : null}</button><button type="button" className={`block max-w-[290px] truncate text-left text-sm font-normal leading-5 text-dls-text hover:text-blue-10 ${task.status === "completed" ? "line-through opacity-60" : ""}`} onClick={() => props.onSelect(task.id)}>{task.title}</button></div></td>{visibleFields.map((field) => <td key={field} className={`border-b border-dls-border px-4 py-2 align-middle whitespace-nowrap ${field === "due" && overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}><TaskFieldCell field={field} task={task} taskMembers={taskMembers} members={props.memberById} lists={props.listById} /></td>)}</tr>;
    }), props.group !== "none" && props.inlineCreatePosition === "bottom" ? groupInlineRow : null, props.group !== "none" && props.group !== "creator" ? <tr key={`create:${groupKey}`}><td className="py-2.5 pl-[38px]" colSpan={visibleFields.length + 1}><button type="button" data-testid={`task-inline-create-group-trigger-${groupKey}`} onClick={() => props.onInlineCreatePositionChange("bottom", groupKey)} className="text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10">{t("tasks.new_task")}</button></td></tr> : null] : groupInlineRow ? [groupInlineRow] : [])]; })}{props.group === "none" && props.inlineCreatePosition === "bottom" ? inlineRow("task-inline-create-row-bottom") : null}{props.group === "none" ? <tr><td className="py-2.5 pl-[38px]" colSpan={visibleFields.length + 1}><button type="button" data-testid="task-inline-create-bottom-trigger" onClick={() => props.onInlineCreatePositionChange("bottom")} className="flex items-center gap-2 text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10"><span className="size-4 shrink-0" aria-hidden="true" />{t("tasks.new_task")}</button></td></tr> : null}</tbody>
  </table></div>;
}

export function TaskLoadMore(props: { visible: boolean; pending: boolean; onLoad: () => void }) {
  return props.visible ? <div className="flex justify-center border-t border-dls-border p-3"><Button variant="outline" disabled={props.pending} onClick={props.onLoad}>{props.pending ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : null;
}

import { useEffect, useState } from "react";
import { ALargeSmall, CalendarDays, Check, ChevronDown, ChevronRight, Copy, Ellipsis, Flag, Link2, ListTodo, Pencil, Plus, RotateCcw, Trash2, UserRound, UserRoundPlus, type LucideIcon } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskCompletionPolicy, DenProductTaskList, DenProductTaskMember, DenProductTaskReminder } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { TaskDateTimeCell, type TaskReminderDraft, type TaskTimeField } from "./task-date-time-cell";
import type { TaskCustomGroup, TaskWorkbenchField, TaskWorkbenchGroup } from "./task-view-state";

export type TaskPresentation = {
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

function EmptyAssigneeIcon() {
  return <UserRoundPlus className="size-[18px] text-dls-secondary/45" aria-label={t("tasks.unassigned")} />;
}

function EmptyTimeIcon({ field }: { field: "start" | "due" }) {
  return <CalendarDays className="size-[18px] text-dls-secondary/45" aria-label={t(fieldLabels[field])} />;
}

function AssigneeCell(props: { task: DenProductTask; ids: string[]; members: Map<string, DenOrganizationMember>; onChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean> }) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(props.ids);
  const [completionPolicy, setCompletionPolicy] = useState(props.task.completionPolicy);
  const [pending, setPending] = useState(false);
  useEffect(() => setSelectedIds(props.ids), [props.ids]);
  useEffect(() => setCompletionPolicy(props.task.completionPolicy), [props.task.completionPolicy]);
  if (!props.onChange && !props.onCompletionPolicyChange) return <MemberCell ids={props.ids} members={props.members} />;
  const options = [...props.members.values()].filter((member) => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return true;
    return [member.user.name, member.user.account, member.user.email].some((value) => value?.toLocaleLowerCase().includes(query));
  });
  const toggle = async (memberId: string) => {
    if (pending) return;
    const next = selectedIds.includes(memberId) ? selectedIds.filter((id) => id !== memberId) : [...selectedIds, memberId];
    setPending(true);
    if (!props.onChange) return;
    const saved = await props.onChange(props.task, next);
    if (saved) setSelectedIds(next);
    setPending(false);
  };
  const updateCompletionPolicy = async (policy: DenProductTaskCompletionPolicy) => {
    if (pending || policy === completionPolicy || !props.onCompletionPolicyChange) return;
    setPending(true);
    const saved = await props.onCompletionPolicyChange(props.task, policy);
    if (saved) setCompletionPolicy(policy);
    setPending(false);
  };
  return <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}>
    <PopoverTrigger render={<button type="button" data-testid={`task-assignee-trigger-${props.task.id}`} aria-label={t("tasks.edit_assignees")} className="flex min-h-8 min-w-28 items-center rounded-md px-1 text-left outline-none transition-colors hover:bg-dls-hover data-popup-open:bg-dls-active data-popup-open:ring-1 data-popup-open:ring-blue-8 focus-visible:ring-2 focus-visible:ring-blue-8" />}>{selectedIds.length ? <MemberCell ids={selectedIds} members={props.members} /> : <EmptyAssigneeIcon />}</PopoverTrigger>
    <PopoverContent align="start" side="bottom" sideOffset={5} data-testid={`task-assignee-picker-${props.task.id}`} className="w-96 gap-0 rounded-xl border border-dls-border bg-dls-surface p-0 shadow-xl">
      <div className="border-b border-dls-border px-4 pt-3"><div className="inline-flex h-10 items-center border-b-2 border-blue-9 px-0.5 font-medium text-blue-10">{t("tasks.assign_to_people")}</div></div>
      <div className="p-3"><input autoFocus data-testid={`task-assignee-search-${props.task.id}`} aria-label={t("tasks.search_assignees")} placeholder={t("tasks.add_assignee")} value={search} onChange={(event) => setSearch(event.currentTarget.value)} className="h-10 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text outline-none placeholder:text-dls-secondary focus:border-blue-8 focus:ring-2 focus:ring-blue-8/20" /></div>
      <div className="max-h-80 overflow-y-auto px-2 pb-3">{options.length ? options.map((member) => { const active = selectedIds.includes(member.id); const name = taskMemberName(member.id, props.members); return <button key={member.id} type="button" role="checkbox" data-testid={`task-assignee-option-${props.task.id}-${member.id}`} aria-checked={active} disabled={pending} onClick={() => void toggle(member.id)} className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"><Avatar><AvatarImage src={member.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className={`min-w-0 flex-1 truncate ${active ? "text-blue-10" : ""}`}>{name}</span>{active ? <Check className="size-4 shrink-0 text-blue-10" /> : null}</button>; }) : <div className="px-3 py-6 text-center text-sm text-dls-secondary">{t("tasks.no_matching_members")}</div>}</div>
      <div className="border-t border-dls-border px-3 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" data-testid={`task-completion-policy-trigger-${props.task.id}`} disabled={pending || !props.onCompletionPolicyChange} className="flex h-9 max-w-full items-center gap-2 rounded-lg bg-dls-hover px-3 text-left text-sm text-dls-text outline-none transition-colors hover:bg-dls-active data-popup-open:bg-dls-active disabled:cursor-default disabled:opacity-60" />}><span className="truncate">{t(`tasks.completion_policy_${completionPolicy}`)}</span><ChevronDown className="size-4 shrink-0 text-dls-secondary" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-auto min-w-72 rounded-xl border border-dls-border bg-dls-surface p-1.5 shadow-xl">
            {(["all_assignees", "any_assignee"] as const).map((policy) => { const active = completionPolicy === policy; return <DropdownMenuItem key={policy} data-testid={`task-completion-policy-${props.task.id}-${policy}`} disabled={pending || !props.onCompletionPolicyChange} onClick={() => void updateCompletionPolicy(policy)} className={`flex h-10 cursor-pointer items-center rounded-lg px-3 text-sm ${active ? "bg-dls-hover text-blue-10" : "text-dls-text"}`}><span className="min-w-0 flex-1 truncate">{t(`tasks.completion_policy_${policy}`)}</span>{active ? <Check className="size-4 shrink-0 text-blue-10" /> : null}</DropdownMenuItem>; })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </PopoverContent>
  </Popover>;
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

export function TaskListCell(props: { task: DenProductTask; lists: Map<string, DenProductTaskList>; onChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onCreate?: (task: DenProductTask, name: string) => Promise<string | null> }) {
  const [search, setSearch] = useState("");
  const [selectedListId, setSelectedListId] = useState(props.task.listId ?? "");
  const [pending, setPending] = useState(false);
  useEffect(() => setSelectedListId(props.task.listId ?? ""), [props.task.listId]);
  const query = search.trim();
  const options = [...props.lists.values()].filter((list) => list.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const exact = [...props.lists.values()].some((list) => list.name.trim().toLocaleLowerCase() === query.toLocaleLowerCase());
  const select = async (listId: string) => {
    if (pending || listId === selectedListId || !props.onChange) return;
    setPending(true);
    const saved = await props.onChange(props.task, listId);
    if (saved) setSelectedListId(listId);
    setPending(false);
  };
  const create = async () => {
    if (pending || !query || exact || !props.onCreate) return;
    setPending(true);
    const listId = await props.onCreate(props.task, query);
    if (listId) { setSelectedListId(listId); setSearch(""); }
    setPending(false);
  };
  const selected = selectedListId ? props.lists.get(selectedListId) : null;
  if (!props.onChange && !props.onCreate) return selected ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{selected.name}</span> : <>{t("tasks.no_list")}</>;
  return <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}>
    <PopoverTrigger render={<button type="button" data-testid={`task-list-trigger-${props.task.id}`} className="flex min-h-8 min-w-24 max-w-48 items-center rounded-md px-1 text-left outline-none transition-colors hover:bg-dls-hover data-popup-open:ring-1 data-popup-open:ring-blue-8" />}><span className={`truncate ${selected ? "rounded-md bg-dls-hover px-2 py-1 text-dls-text/85" : "text-dls-secondary"}`}>{selected?.name ?? t("tasks.no_list")}</span></PopoverTrigger>
    <PopoverContent align="start" side="bottom" sideOffset={5} data-testid={`task-list-picker-${props.task.id}`} className="w-80 gap-0 rounded-xl border border-dls-border bg-dls-surface p-0 shadow-xl">
      <div className="p-3"><input autoFocus data-testid={`task-list-search-${props.task.id}`} aria-label={t("tasks.search_or_create_list")} placeholder={t("tasks.search_or_create_list")} value={search} disabled={pending} onChange={(event) => setSearch(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && query && !exact) { event.preventDefault(); void create(); } }} className="h-10 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text outline-none placeholder:text-dls-secondary focus:border-blue-8 focus:ring-2 focus:ring-blue-8/20" /></div>
      <div className="max-h-72 overflow-y-auto px-2 pb-2">
        {!query ? <button type="button" data-testid={`task-list-option-${props.task.id}-none`} disabled={pending} onClick={() => void select("")} className="flex h-11 w-full items-center rounded-lg px-3 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"><span className="min-w-0 flex-1 truncate">{t("tasks.no_list")}</span>{selectedListId === "" ? <Check className="size-4 text-blue-10" /> : null}</button> : null}
        {options.map((list) => <button key={list.id} type="button" data-testid={`task-list-option-${props.task.id}-${list.id}`} disabled={pending} onClick={() => void select(list.id)} className="flex h-11 w-full items-center rounded-lg px-3 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"><span className={`min-w-0 flex-1 truncate ${selectedListId === list.id ? "text-blue-10" : ""}`}>{list.name}</span>{selectedListId === list.id ? <Check className="size-4 text-blue-10" /> : null}</button>)}
        {query && !exact ? <button type="button" data-testid={`task-list-create-${props.task.id}`} disabled={pending} onClick={() => void create()} className="mt-1 flex min-h-12 w-full items-center gap-2 rounded-lg bg-dls-hover px-3 text-left text-sm text-dls-secondary hover:bg-dls-active disabled:opacity-60"><Plus className="size-5 shrink-0" /><span>{t("tasks.create_list_inline")}</span><strong className="min-w-0 truncate font-semibold text-dls-text">{query}</strong></button> : null}
      </div>
    </PopoverContent>
  </Popover>;
}

const fieldLabels: Record<TaskWorkbenchField, string> = { assignee: "tasks.field_assignee", start: "tasks.field_start", due: "tasks.field_due", creator: "tasks.field_creator", assigner: "tasks.field_assigner", followers: "tasks.field_followers", created: "tasks.field_created", completed: "tasks.field_completed", updated: "tasks.field_updated", id: "tasks.field_id", priority: "tasks.field_priority", list: "tasks.field_list" };
const fieldIcons: Partial<Record<TaskWorkbenchField, LucideIcon>> = { assignee: UserRound, start: CalendarDays, due: CalendarDays, creator: UserRound, assigner: UserRound, followers: UserRound, created: CalendarDays, completed: CalendarDays, updated: CalendarDays, id: Link2, priority: Flag, list: ListTodo };

function TaskPriorityCell({ priority }: { priority: DenProductTask["priority"] }) {
  const color = priority === "high" ? "text-red-9" : priority === "medium" ? "text-amber-10" : priority === "low" ? "text-blue-10" : "text-dls-secondary/80";
  return <span data-testid={`task-priority-${priority}`} className={`inline-flex items-center gap-1.5 ${color}`}><Flag className="size-3.5" />{t(`tasks.priority_${priority}`)}</span>;
}

export type TimeGroupKey = "elapsed" | "today" | "tomorrow" | "next7" | "later" | "unscheduled";
export const timeGroupOrder: TimeGroupKey[] = ["elapsed", "today", "tomorrow", "next7", "later", "unscheduled"];
export const defaultCustomTaskGroupKey = "custom-default";

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

export function timeGroupLabel(key: TimeGroupKey, kind: "start" | "due") {
  if (key === "elapsed") return t(kind === "start" ? "tasks.group_started" : "tasks.group_overdue");
  return t(`tasks.group_time_${key}`);
}

export function taskGroupValue(task: DenProductTask, group: TaskWorkbenchGroup, presentation: TaskPresentation, now: Date, customGroupLabel: string) {
  if (group === "custom") return { key: defaultCustomTaskGroupKey, label: customGroupLabel };
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

function InlineCreateField(props: { field: TaskWorkbenchField; creatorMemberId: string | null; createdAt: string; defaults: TaskQuickCreateDefaults; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList> }) {
  if (props.field === "assignee") return <EmptyAssigneeIcon />;
  if (props.field === "creator") return props.creatorMemberId ? <MemberCell ids={[props.creatorMemberId]} members={props.members} /> : <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "assigner") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "followers") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "start") return props.defaults.startAt ? <>{formatDate(props.defaults.startAt)}</> : <EmptyTimeIcon field="start" />;
  if (props.field === "due") return props.defaults.dueAt ? <>{formatDate(props.defaults.dueAt)}</> : <EmptyTimeIcon field="due" />;
  if (props.field === "created" || props.field === "updated") return <>{formatDate(props.createdAt)}</>;
  if (props.field === "completed") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "id") return <span className="font-mono">-</span>;
  if (props.field === "priority") return <TaskPriorityCell priority="none" />;
  return props.defaults.listId ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{props.lists.get(props.defaults.listId)?.name ?? shortId(props.defaults.listId)}</span> : <span className="text-dls-secondary/70">{t("tasks.no_list")}</span>;
}

function TaskFieldCell(props: { field: TaskWorkbenchField; task: DenProductTask; taskMembers: DenProductTaskMember[]; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList>; onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean>; onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate?: (task: DenProductTask, name: string) => Promise<string | null> }) {
  const assigneeIds = props.taskMembers.filter((member) => member.role === "assignee").map((member) => member.memberId);
  const followerIds = props.taskMembers.filter((member) => member.role === "follower").map((member) => member.memberId);
  const assignerIds = [...new Set(props.taskMembers.filter((member) => member.role === "assignee").map((member) => member.createdByMemberId).filter((memberId): memberId is string => Boolean(memberId)))];
  if (props.field === "assignee") return <AssigneeCell task={props.task} ids={assigneeIds} members={props.members} onChange={props.onAssigneesChange} onCompletionPolicyChange={props.onCompletionPolicyChange} />;
  if (props.field === "creator") return <MemberCell ids={[props.task.creatorMemberId]} members={props.members} />;
  if (props.field === "assigner") return <MemberCell ids={assignerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "followers") return <MemberCell ids={followerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "start") return <TaskDateTimeCell task={props.task} field="startAt" onChange={props.onTimeChange} />;
  if (props.field === "due") return <TaskDateTimeCell task={props.task} field="dueAt" onChange={props.onTimeChange} onLoadReminders={props.onLoadReminders} onReminderChange={props.onReminderChange} />;
  if (props.field === "created") return <>{formatDate(props.task.createdAt)}</>;
  if (props.field === "completed") return <>{formatDate(props.task.completedAt)}</>;
  if (props.field === "updated") return <>{formatDate(props.task.updatedAt)}</>;
  if (props.field === "id") return <TaskIdCell id={props.task.id} displayNumber={props.task.displayNumber} />;
  if (props.field === "priority") return <TaskPriorityCell priority={props.task.priority} />;
  return <TaskListCell task={props.task} lists={props.lists} onChange={props.onListChange} onCreate={props.onListCreate} />;
}

function InlineCreateRow(props: { testId: string; fields: TaskWorkbenchField[]; title: string; pending: boolean; creatorMemberId: string | null; createdAt: string; defaults: TaskQuickCreateDefaults; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList>; onTitleChange: (title: string) => void; onSubmit: (title?: string) => void; onCancel: () => void }) {
  return <tr data-testid={props.testId} className="h-12 bg-dls-active/80"><td className="border-b border-blue-6/40 py-1.5 pl-[38px] align-middle"><form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}><span className="size-4 shrink-0 rounded-full border border-dls-secondary/70" aria-hidden="true" /><input autoFocus aria-label={t("tasks.field_title")} placeholder={t("tasks.title_placeholder")} value={props.title} disabled={props.pending} onChange={(event) => props.onTitleChange(event.currentTarget?.value ?? event.target.value)} onBlur={(event) => { if (props.pending) return; const title = event.currentTarget.value.trim(); if (title) props.onSubmit(title); else props.onCancel(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onCancel(); } }} className="h-9 min-w-0 flex-1 rounded-sm border border-blue-8 bg-dls-surface px-2 text-sm text-dls-text outline-none ring-1 ring-blue-8/20 placeholder:text-dls-secondary/60 focus:ring-2 focus:ring-blue-8/35" /></form></td>{props.fields.map((field) => <td key={field} className="border-b border-blue-6/40 px-4 py-2 align-middle whitespace-nowrap text-dls-secondary"><InlineCreateField field={field} creatorMemberId={props.creatorMemberId} createdAt={props.createdAt} defaults={props.defaults} members={props.members} lists={props.lists} /></td>)}</tr>;
}

function TaskGroupHeader(props: { groupKey: string; group: TaskWorkbenchGroup; label: string; count: number; expanded: boolean; columnCount: number; members: Map<string, DenOrganizationMember>; renaming: boolean; renameDraft: string; onRenameDraftChange: (value: string) => void; onRenameStart: () => void; onRenameFinish: () => void; onRenameCancel: () => void; onDelete: () => void; onToggle: () => void; onAdd: () => void }) {
  const custom = props.group === "custom";
  const protectedGroup = props.groupKey === defaultCustomTaskGroupKey;
  return <tr data-testid={`task-group-row-${props.groupKey}`} className="group/task-group"><th colSpan={props.columnCount} className="border-b border-dls-border px-6 py-2.5 text-left text-sm font-semibold text-dls-text"><div className="flex items-center gap-1">
    <button type="button" data-testid={`task-group-toggle-${props.groupKey}`} aria-expanded={props.expanded} aria-label={props.renaming ? props.label : undefined} onClick={props.onToggle} className="inline-flex items-center gap-2 rounded-md px-1 py-1 hover:bg-dls-hover">
      {props.expanded ? <ChevronDown className="size-4 text-dls-secondary" /> : <ChevronRight className="size-4 text-dls-secondary" />}
      {props.renaming ? null : props.group === "creator" ? <CreatorGroupLabel memberId={props.groupKey} members={props.members} /> : <span>{props.label}</span>}
      {props.renaming ? null : <span className="font-normal text-dls-secondary">{props.count}</span>}
    </button>
    {props.renaming ? <input autoFocus data-testid="task-custom-group-name-input" aria-label={t("tasks.group_name")} value={props.renameDraft} maxLength={80} onChange={(event) => props.onRenameDraftChange(event.currentTarget.value)} onBlur={props.onRenameFinish} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); props.onRenameFinish(); } else if (event.key === "Escape") { event.preventDefault(); props.onRenameCancel(); } }} className="h-8 w-48 rounded-md border border-blue-8 bg-dls-surface px-2 text-sm font-semibold text-dls-text outline-none ring-2 ring-blue-8/20" /> : null}
    {!props.renaming && props.group !== "creator" ? <button type="button" data-testid={`task-group-add-${props.groupKey}`} aria-label={`${props.label} · ${t("tasks.new_task")}`} onClick={props.onAdd} className="flex size-7 items-center justify-center rounded-md text-dls-secondary opacity-0 transition-opacity hover:bg-dls-hover hover:text-blue-10 focus:opacity-100 group-hover/task-group:opacity-100"><Plus className="size-4" /></button> : null}
    {!props.renaming && custom ? <DropdownMenu><span data-testid={`task-custom-group-actions-${props.groupKey}`} className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/task-group:opacity-100 data-[popup-open]:opacity-100"><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.custom_group_actions")} className="size-7 rounded-md text-dls-secondary data-popup-open:bg-dls-hover" />}><Ellipsis className="size-4" /></DropdownMenuTrigger></span><DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-auto min-w-32 rounded-xl p-1"><DropdownMenuItem data-testid={`task-custom-group-rename-${props.groupKey}`} onClick={props.onRenameStart} className="rounded-lg px-2.5"><Pencil className="size-4" />{t("tasks.rename_group")}</DropdownMenuItem><DropdownMenuItem data-testid={`task-custom-group-delete-${props.groupKey}`} disabled={protectedGroup} onClick={props.onDelete} className="rounded-lg px-2.5"><Trash2 className="size-4" />{t("tasks.delete_group")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
  </div></th></tr>;
}

export function TaskListTable(props: TaskPresentation & { fields: TaskWorkbenchField[]; group: TaskWorkbenchGroup; customGroupName: string; customGroups: TaskCustomGroup[]; customGroupAssignments: Record<string, string>; selectedTaskId: string | null; currentMemberId: string | null; inlineCreatePosition: InlineCreatePosition | null; inlineCreateGroupKey: string | null; inlineCreateDefaults: TaskQuickCreateDefaults; inlineCreateTitle: string; inlineCreatePending: boolean; inlineCreateMemberId: string | null; inlineCreateCreatedAt: string; onCustomGroupsChange: (groups: TaskCustomGroup[]) => void; onCustomGroupNameChange: (name: string) => void; onInlineCreatePositionChange: (position: InlineCreatePosition | null, groupKey?: string) => void; onInlineCreateTitleChange: (title: string) => void; onInlineCreateSubmit: () => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen") => void; onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean>; onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate?: (task: DenProductTask, name: string) => Promise<string | null> }) {
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const [renamingCustomGroupKey, setRenamingCustomGroupKey] = useState<string | null>(null);
  const [customGroupNameDraft, setCustomGroupNameDraft] = useState("");
  const [creatingCustomGroup, setCreatingCustomGroup] = useState(false);
  const [customGroupCreateDraft, setCustomGroupCreateDraft] = useState("");
  const visibleFields = props.fields;
  const groups = new Map<string, { label: string; tasks: DenProductTask[] }>();
  const now = new Date();
  const customGroupLabel = props.customGroupName.trim() || t("tasks.group_default");
  if (props.group === "custom") {
    groups.set(defaultCustomTaskGroupKey, { label: customGroupLabel, tasks: [] });
    for (const group of props.customGroups) groups.set(group.id, { label: group.name, tasks: [] });
  }
  if (props.group === "start" || props.group === "due") {
    for (const key of timeGroupOrder) groups.set(key, { label: timeGroupLabel(key, props.group), tasks: [] });
  }
  if (props.group === "creator" && props.inlineCreateMemberId) {
    groups.set(props.inlineCreateMemberId, { label: taskMemberName(props.inlineCreateMemberId, props.memberById), tasks: [] });
  }
  for (const task of props.tasks) {
    const assignedCustomGroup = props.group === "custom" ? props.customGroupAssignments[task.id] : undefined;
    const group = assignedCustomGroup && groups.has(assignedCustomGroup)
      ? { key: assignedCustomGroup, label: groups.get(assignedCustomGroup)!.label }
      : taskGroupValue(task, props.group, props, now, customGroupLabel);
    const current = groups.get(group.key);
    groups.set(group.key, { label: group.label, tasks: [...(current?.tasks ?? []), task] });
  }
  const rows = props.group === "none" ? [["", { label: "", tasks: props.tasks }] as const] : [...groups.entries()];
  const toggleGroup = (key: string, expanded: boolean) => setGroupExpansion((current) => ({ ...current, [key]: !expanded }));
  const startCustomGroupRename = (key: string, label: string) => { setCustomGroupNameDraft(label); setRenamingCustomGroupKey(key); };
  const finishCustomGroupRename = () => {
    const name = customGroupNameDraft.trim().slice(0, 80);
    const key = renamingCustomGroupKey;
    setRenamingCustomGroupKey(null);
    if (!name || !key) return;
    if (key === defaultCustomTaskGroupKey) {
      if (name !== customGroupLabel) props.onCustomGroupNameChange(name);
    } else {
      props.onCustomGroupsChange(props.customGroups.map((group) => group.id === key ? { ...group, name } : group));
    }
  };
  const finishCustomGroupCreate = () => {
    const name = customGroupCreateDraft.trim().slice(0, 80);
    setCreatingCustomGroup(false);
    setCustomGroupCreateDraft("");
    if (!name) return;
    props.onCustomGroupsChange([...props.customGroups, { id: `custom-${crypto.randomUUID()}`, name }]);
  };
  const inlineRow = (testId: string) => <InlineCreateRow key={testId} testId={testId} fields={visibleFields} title={props.inlineCreateTitle} pending={props.inlineCreatePending} creatorMemberId={props.inlineCreateMemberId} createdAt={props.inlineCreateCreatedAt} defaults={props.inlineCreateDefaults} members={props.memberById} lists={props.listById} onTitleChange={props.onInlineCreateTitleChange} onSubmit={props.onInlineCreateSubmit} onCancel={() => props.onInlineCreatePositionChange(null)} />;
  return <div className="min-h-0 w-full flex-1 overflow-auto" data-testid="assigned-task-table"><table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-sm [&_tbody_tr.group]:relative [&_tbody_tr.group]:after:pointer-events-none [&_tbody_tr.group]:after:absolute [&_tbody_tr.group]:after:bottom-0 [&_tbody_tr.group]:after:left-[38px] [&_tbody_tr.group]:after:right-6 [&_tbody_tr.group]:after:h-px [&_tbody_tr.group]:after:bg-dls-border [&_tbody_tr.group]:after:content-[''] [&_tbody_tr.group_td]:border-b-0">
    <colgroup><col style={{ width: 360 }} />{visibleFields.map((field) => <col key={field} style={{ width: field === "id" ? 260 : field === "created" || field === "completed" || field === "updated" ? 180 : 160 }} />)}</colgroup>
    <thead className="sticky top-0 z-10 bg-dls-surface"><tr><th className="py-3 pl-[38px] text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-2" data-testid="task-title-header"><ALargeSmall aria-hidden="true" className="size-4 shrink-0" />{t("tasks.field_title")}</span></th>{visibleFields.map((field) => { const FieldIcon = fieldIcons[field]; return <th key={field} className="px-4 py-3 text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-1.5">{FieldIcon ? <FieldIcon className="size-3.5" /> : null}{t(fieldLabels[field])}</span></th>; })}</tr></thead>
    <tbody>{props.inlineCreatePosition === "top" && props.inlineCreateGroupKey === null ? inlineRow("task-inline-create-row-top") : null}{rows.flatMap(([groupKey, group]) => { const collapseKey = `${props.group}:${groupKey}`; const expanded = props.inlineCreateGroupKey === groupKey || (groupExpansion[collapseKey] ?? group.tasks.length > 0); const groupInlineRow = props.inlineCreateGroupKey === groupKey ? inlineRow(`task-inline-create-row-group-${groupKey}`) : null; return [props.group !== "none" ? <TaskGroupHeader key={`group:${groupKey}`} groupKey={groupKey} group={props.group} label={group.label} count={group.tasks.length} expanded={expanded} columnCount={visibleFields.length + 1} members={props.memberById} renaming={props.group === "custom" && groupKey === renamingCustomGroupKey} renameDraft={customGroupNameDraft} onRenameDraftChange={setCustomGroupNameDraft} onRenameStart={() => startCustomGroupRename(groupKey, group.label)} onRenameFinish={finishCustomGroupRename} onRenameCancel={() => setRenamingCustomGroupKey(null)} onDelete={() => props.onCustomGroupsChange(props.customGroups.filter((item) => item.id !== groupKey))} onToggle={() => toggleGroup(collapseKey, expanded)} onAdd={() => { if (!expanded) setGroupExpansion((current) => ({ ...current, [collapseKey]: true })); props.onInlineCreatePositionChange("top", groupKey); }} /> : null, ...(expanded ? [props.inlineCreatePosition === "top" ? groupInlineRow : null, ...group.tasks.map((task) => {
      const taskMembers = props.membersByTaskId[task.id] ?? [];
      const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
      const currentAssigneeCompleted = task.status === "todo" && task.completionPolicy === "all_assignees" && taskMembers.some((member) => member.role === "assignee" && member.memberId === props.currentMemberId && Boolean(member.completedAt));
      return <tr key={task.id} data-state={props.selectedTaskId === task.id ? "selected" : undefined} className="group h-12 transition-colors hover:bg-dls-hover/75 data-[state=selected]:bg-dls-active"><td className="border-b border-dls-border py-2 pl-[38px] align-middle"><div className="flex items-center gap-2" data-testid={`task-title-cell-${task.id}`}><button type="button" disabled={currentAssigneeCompleted} className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-default ${task.status === "completed" ? "border-green-8 bg-green-8 text-white" : currentAssigneeCompleted ? "border-blue-8 bg-blue-8 text-white" : task.status === "canceled" ? "border-dls-secondary text-dls-secondary" : "border-dls-secondary hover:border-dls-accent"}`} aria-label={currentAssigneeCompleted ? t("tasks.assignee_completed") : task.status === "todo" ? t("tasks.complete") : t("tasks.reopen")} title={currentAssigneeCompleted ? t("tasks.waiting_for_assignees") : undefined} onClick={() => { if (!currentAssigneeCompleted) props.onTransition(task, task.status === "todo" ? "complete" : "reopen"); }}>{task.status === "completed" || currentAssigneeCompleted ? <Check className="size-3" /> : task.status === "canceled" ? <RotateCcw className="size-2.5" /> : null}</button><button type="button" className={`block max-w-[290px] truncate text-left text-sm font-normal leading-5 text-dls-text hover:text-blue-10 ${task.status === "completed" ? "line-through opacity-60" : ""}`} onClick={() => props.onSelect(task.id)}>{task.title}</button></div></td>{visibleFields.map((field) => <td key={field} className={`border-b border-dls-border px-4 py-2 align-middle whitespace-nowrap ${field === "due" && overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}><TaskFieldCell field={field} task={task} taskMembers={taskMembers} members={props.memberById} lists={props.listById} onAssigneesChange={props.onAssigneesChange} onCompletionPolicyChange={props.onCompletionPolicyChange} onTimeChange={props.onTimeChange} onLoadReminders={props.onLoadReminders} onReminderChange={props.onReminderChange} onListChange={props.onListChange} onListCreate={props.onListCreate} /></td>)}</tr>;
    }), props.group !== "none" && props.inlineCreatePosition === "bottom" ? groupInlineRow : null, props.group !== "none" && props.group !== "creator" ? <tr key={`create:${groupKey}`}><td className="py-2.5 pl-[38px]" colSpan={visibleFields.length + 1}><button type="button" data-testid={`task-inline-create-group-trigger-${groupKey}`} onClick={() => props.onInlineCreatePositionChange("bottom", groupKey)} className="text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10">{t("tasks.new_task")}</button></td></tr> : null] : groupInlineRow ? [groupInlineRow] : [])]; })}{props.group === "custom" ? <tr data-testid="task-custom-group-create-row"><td className="py-3 pl-[38px]" colSpan={visibleFields.length + 1}>{creatingCustomGroup ? <div className="flex items-center gap-2"><ChevronRight className="size-4 text-dls-secondary" /><input autoFocus data-testid="task-custom-group-create-input" aria-label={t("tasks.group_name")} placeholder={t("tasks.group_title_placeholder")} value={customGroupCreateDraft} maxLength={80} onChange={(event) => setCustomGroupCreateDraft(event.currentTarget.value)} onBlur={finishCustomGroupCreate} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishCustomGroupCreate(); } else if (event.key === "Escape") { event.preventDefault(); setCreatingCustomGroup(false); setCustomGroupCreateDraft(""); } }} className="h-9 w-80 rounded-md border border-blue-8 bg-dls-surface px-3 text-sm text-dls-text outline-none ring-2 ring-blue-8/20 placeholder:text-dls-secondary/65" /></div> : null}<button type="button" data-testid="task-custom-group-create-trigger" onClick={() => setCreatingCustomGroup(true)} className="mt-2 flex items-center gap-2 text-sm font-semibold text-dls-secondary/65 transition-colors hover:text-blue-10"><Plus className="size-4" />{t("tasks.new_group")}</button></td></tr> : null}{props.group === "none" && props.inlineCreatePosition === "bottom" ? inlineRow("task-inline-create-row-bottom") : null}{props.group === "none" ? <tr><td className="py-2.5 pl-[38px]" colSpan={visibleFields.length + 1}><button type="button" data-testid="task-inline-create-bottom-trigger" onClick={() => props.onInlineCreatePositionChange("bottom")} className="flex items-center gap-2 text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10"><span className="size-4 shrink-0" aria-hidden="true" />{t("tasks.new_task")}</button></td></tr> : null}</tbody>
  </table></div>;
}

export function TaskLoadMore(props: { visible: boolean; pending: boolean; onLoad: () => void }) {
  return props.visible ? <div className="flex justify-center border-t border-dls-border p-3"><Button variant="outline" disabled={props.pending} onClick={props.onLoad}>{props.pending ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : null;
}

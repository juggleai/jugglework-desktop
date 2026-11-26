import { createContext, Fragment, useContext, useEffect, useEffectEvent, useRef, useState, type DragEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ALargeSmall, CalendarDays, Check, ChevronDown, ChevronRight, Copy, CornerUpLeft, Ellipsis, Flag, GripVertical, Link2, ListTodo, ListTree, MessageSquare, Paperclip, Pencil, Plus, RotateCcw, Trash2, UserRound, UserRoundPlus, type LucideIcon } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskCompletionPolicy, DenProductTaskList, DenProductTaskMember, DenProductTaskPage, DenProductTaskReminder } from "@/app/lib/den";
import { DenApiError, productTaskListIds } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale, t } from "@/i18n";
import { TaskDateTimeCell, type TaskReminderDraft, type TaskTimeField } from "./task-date-time-cell";
import { splitTaskAttachments } from "./task-description-markdown";
import { TaskPrioritySelect, type EditableTaskPriority } from "./task-priority-select";
import { isInvalidTaskCursor } from "./task-queries";
import { taskMarkerShape } from "./task-marker";
import { moveTaskWithinGroup, type TaskCustomGroup, type TaskOrderPlacement, type TaskWorkbenchField, type TaskWorkbenchGroup } from "./task-view-state";

export type TaskPresentation = {
  tasks: DenProductTask[];
  membersByTaskId: Record<string, DenProductTaskMember[]>;
  memberById: Map<string, DenOrganizationMember>;
  listById: Map<string, DenProductTaskList>;
};

function shortId(value: string) { return value.length > 12 ? `${value.slice(0, 8)}...` : value; }

export const TaskListSyncContext = createContext(false);

export function taskListName(id: string, lists: Map<string, DenProductTaskList>, syncing: boolean) {
  return lists.get(id)?.name ?? t(syncing ? "tasks.list_syncing" : "tasks.list_unavailable");
}

export function taskListLabel(task: DenProductTask, lists: Map<string, DenProductTaskList>, syncing: boolean) {
  return productTaskListIds(task).map((id) => taskListName(id, lists, syncing)).join(", ") || t("tasks.no_list");
}
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

const maxAssigneeSlots = 4;
type AssigneeAvatarPerson = { id: string; name: string; avatar?: string; completed: boolean };

function assigneeAvatarLabel(person: AssigneeAvatarPerson) {
  return person.completed ? `${person.name} · ${t("tasks.completed")}` : person.name;
}

export function AssigneeCompletionBadge() {
  return <span aria-hidden="true" data-testid="task-assignee-completed" className="absolute end-0 bottom-0 z-10 grid size-3 place-items-center rounded-full bg-green-9 text-white ring-1 ring-dls-surface"><Check className="size-2" strokeWidth={3} /></span>;
}

function AssigneeAvatars({ people, detail, avatarOnly }: { people: AssigneeAvatarPerson[]; detail: boolean; avatarOnly?: boolean }) {
  const single = people.length === 1;
  const slots = avatarOnly ? 2 : maxAssigneeSlots;
  const visibleAssigneeCount = people.length > slots ? slots - 1 : slots;
  const hidden = people.slice(visibleAssigneeCount);
  const completed = detail && !single ? people.filter((person) => person.completed).length : 0;
  const summary = avatarOnly ? null : single ? people[0].name : !detail ? null : completed > 0
    ? t("tasks.assignees_progress", { completed, total: people.length })
    : t("tasks.assignees_count", { count: people.length });
  const label = people.map(assigneeAvatarLabel).join(", ");
  return <span className={`isolate inline-flex items-center ${summary ? "min-w-0 gap-1.5 rounded-full bg-dls-hover py-0.5 ps-0.5 pe-2 text-sm text-dls-text" : "shrink-0"}`} role="img" aria-label={detail && !single ? `${summary} · ${label}` : label}>
    <span className="inline-flex shrink-0 items-center -space-x-1">
      {people.slice(0, visibleAssigneeCount).map((person) => <Avatar key={person.id} className={single ? "size-7" : "size-7 ring-2 ring-dls-surface"}>
        <AvatarImage src={person.avatar} />
        <AvatarFallback className="text-xs">{Array.from(person.name)[0]?.toUpperCase()}</AvatarFallback>
        {person.completed ? <AssigneeCompletionBadge /> : null}
      </Avatar>)}
      {hidden.length ? <span data-testid="task-assignee-overflow" className="relative inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-1 text-xs tabular-nums text-muted-foreground ring-2 ring-dls-surface">+{hidden.length}</span> : null}
    </span>
    {summary ? <span className={single ? "max-w-28 truncate" : "min-w-0 truncate"}>{summary}</span> : null}
  </span>;
}

function AssigneeNamesTooltip({ people, detail, children }: { people: AssigneeAvatarPerson[]; detail: boolean; children: ReactNode }) {
  const separator = currentLocale().startsWith("zh") ? "、" : ", ";
  return <Tooltip>{children}{people.length ? <TooltipContent sideOffset={8} positionerClassName={detail ? "z-[60]" : undefined} className="whitespace-normal shadow-lg"><span className="[overflow-wrap:anywhere]">{people.map((person) => person.name).join(separator)}</span></TooltipContent> : null}</Tooltip>;
}

function EmptyAssigneeIcon() {
  return <UserRoundPlus className="size-[18px] text-dls-secondary/45" aria-label={t("tasks.unassigned")} />;
}

function EmptyTimeIcon({ field }: { field: "start" | "due" }) {
  return <CalendarDays className="size-[18px] text-dls-secondary/45" aria-label={t(fieldLabels[field])} />;
}

export function AssigneeCell(props: { task: DenProductTask; ids: string[]; members: Map<string, DenOrganizationMember>; detail?: boolean; avatarOnly?: boolean; draftOwner?: string; completedIds?: ReadonlySet<string>; onChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean> }) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState(props.ids);
  const [completionPolicy, setCompletionPolicy] = useState(props.task.completionPolicy);
  const [pending, setPending] = useState(false);
  useEffect(() => setSelectedIds(props.ids), [props.ids]);
  useEffect(() => setCompletionPolicy(props.task.completionPolicy), [props.task.completionPolicy]);
  const canEdit = Boolean(props.onChange || props.onCompletionPolicyChange);
  const detail = Boolean(props.detail);
  // Inline subtask pickers are controlled by the refreshed child projection (or local draft).
  const ids = canEdit && !props.avatarOnly ? selectedIds : props.ids;
  // Whole-task completion has an actor, not a per-assignee timestamp.
  const taskCompletionActor = ids.length === 1 && props.task.status === "completed" && props.task.completionPolicy === "any_assignee" ? props.task.completedByMemberId : null;
  const people = ids.map((id) => ({ id, name: taskMemberName(id, props.members), avatar: props.members.get(id)?.user.avatar ?? undefined, completed: id === taskCompletionActor || (props.task.completionPolicy === "all_assignees" && Boolean(props.completedIds?.has(id))) }));
  const content = people.length ? <AssigneeAvatars people={people} detail={detail} avatarOnly={props.avatarOnly} /> : canEdit || props.avatarOnly ? <EmptyAssigneeIcon /> : <span className="text-dls-secondary/80">{t("tasks.unassigned")}</span>;
  if (!canEdit) return people.length ? <AssigneeNamesTooltip people={people} detail={detail}><TooltipTrigger delay={250} render={<span className="inline-flex min-w-0 max-w-full rounded-full focus-visible:outline-2 focus-visible:outline-blue-8" tabIndex={0} />}>{content}</TooltipTrigger></AssigneeNamesTooltip> : content;
  const query = search.trim().toLocaleLowerCase();
  const options = [...props.members.values()].filter((member) => {
    if (!query) return true;
    return [member.user.name, member.user.account, member.user.email].some((value) => value?.toLocaleLowerCase().includes(query));
  });
  const toggle = async (memberId: string) => {
    if (pending || !props.onChange) return;
    const next = ids.includes(memberId) ? ids.filter((id) => id !== memberId) : [...ids, memberId];
    setPending(true);
    try {
      if (await props.onChange(props.task, next) && !props.avatarOnly) setSelectedIds(next);
    } finally { setPending(false); }
  };
  const updateCompletionPolicy = async (policy: DenProductTaskCompletionPolicy) => {
    if (pending || policy === completionPolicy || !props.onCompletionPolicyChange) return;
    setPending(true);
    try {
      if (await props.onCompletionPolicyChange(props.task, policy)) setCompletionPolicy(policy);
    } finally { setPending(false); }
  };
  const trigger = <button type="button" data-testid={`task-assignee-trigger-${props.task.id}`} aria-label={t("tasks.edit_assignees")} aria-description={people.map(assigneeAvatarLabel).join(", ") || t("tasks.unassigned")} className={`flex min-h-8 min-w-8 items-center rounded-md text-left outline-none transition-colors hover:bg-dls-hover data-popup-open:bg-dls-active data-popup-open:ring-1 data-popup-open:ring-blue-8 focus-visible:ring-2 focus-visible:ring-blue-8 ${props.avatarOnly ? "justify-center px-0.5" : "px-1"}`} />;
  const picker = <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}>
    <PopoverTrigger render={<TooltipTrigger delay={250} disabled={!people.length} render={trigger} />}>{content}</PopoverTrigger>
    <PopoverContent align="start" side="bottom" sideOffset={5} data-task-draft-owner={props.draftOwner} data-testid={`task-assignee-picker-${props.task.id}`} className="w-96 gap-0 rounded-xl border border-dls-border bg-dls-surface p-0 shadow-xl">
      <div className="border-b border-dls-border px-4 pt-3"><div className="inline-flex h-10 items-center border-b-2 border-blue-9 px-0.5 font-medium text-blue-10">{t("tasks.assign_to_people")}</div></div>
      <div className="p-3"><input autoFocus data-testid={`task-assignee-search-${props.task.id}`} aria-label={t("tasks.search_assignees")} placeholder={t("tasks.add_assignee")} value={search} onInput={(event) => setSearch(event.currentTarget.value)} className="h-10 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text outline-none placeholder:text-dls-secondary focus:border-blue-8 focus:ring-2 focus:ring-blue-8/20" /></div>
      <div className="max-h-80 overflow-y-auto px-2 pb-3">{options.length ? options.map((member) => { const active = ids.includes(member.id); const name = taskMemberName(member.id, props.members); return <button key={member.id} type="button" role="checkbox" data-testid={`task-assignee-option-${props.task.id}-${member.id}`} aria-checked={active} disabled={pending} onClick={() => void toggle(member.id)} className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"><Avatar><AvatarImage src={member.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className={`min-w-0 flex-1 truncate ${active ? "text-blue-10" : ""}`}>{name}</span>{active ? <Check className="size-4 shrink-0 text-blue-10" /> : null}</button>; }) : <div className="px-3 py-6 text-center text-sm text-dls-secondary">{t("tasks.no_matching_members")}</div>}</div>
      {props.onCompletionPolicyChange ? <div className="border-t border-dls-border px-3 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger render={<button type="button" data-testid={`task-completion-policy-trigger-${props.task.id}`} disabled={pending || !props.onCompletionPolicyChange} className="flex h-9 max-w-full items-center gap-2 rounded-lg bg-dls-hover px-3 text-left text-sm text-dls-text outline-none transition-colors hover:bg-dls-active data-popup-open:bg-dls-active disabled:cursor-default disabled:opacity-60" />}><span className="truncate">{t(`tasks.completion_policy_${completionPolicy}`)}</span><ChevronDown className="size-4 shrink-0 text-dls-secondary" /></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-auto min-w-72 rounded-xl border border-dls-border bg-dls-surface p-1.5 shadow-xl">
            {(["all_assignees", "any_assignee"] as const).map((policy) => { const active = completionPolicy === policy; return <DropdownMenuItem key={policy} data-testid={`task-completion-policy-${props.task.id}-${policy}`} disabled={pending || !props.onCompletionPolicyChange} onClick={() => void updateCompletionPolicy(policy)} className={`flex h-10 cursor-pointer items-center rounded-lg px-3 text-sm ${active ? "bg-dls-hover text-blue-10" : "text-dls-text"}`}><span className="min-w-0 flex-1 truncate">{t(`tasks.completion_policy_${policy}`)}</span>{active ? <Check className="size-4 shrink-0 text-blue-10" /> : null}</DropdownMenuItem>; })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div> : null}
    </PopoverContent>
  </Popover>;
  return <AssigneeNamesTooltip people={people} detail={detail}>{picker}</AssigneeNamesTooltip>;
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

export function TaskListCell(props: { task: DenProductTask; lists: Map<string, DenProductTaskList>; addOnly?: boolean; disabled?: boolean; onChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onCreate?: (task: DenProductTask, name: string) => Promise<string | null> }) {
  const syncingLists = useContext(TaskListSyncContext);
  const [search, setSearch] = useState("");
  const selectedIds = productTaskListIds(props.task);
  const [pending, setPending] = useState(false);
  const query = search.trim();
  const normalizedQuery = query.toLocaleLowerCase();
  const availableLists = [...props.lists.values()];
  const options = availableLists.filter((list) => (!props.addOnly || (!selectedIds.includes(list.id) && !list.archivedAt)) && list.name.toLocaleLowerCase().includes(normalizedQuery));
  const exact = availableLists.some((list) => list.name.trim().toLocaleLowerCase() === normalizedQuery);
  const canCreate = Boolean(query && !exact && props.onCreate);
  const busy = pending || props.disabled;
  const select = async (listId: string) => {
    if (pending || props.disabled || !props.onChange || (props.addOnly && selectedIds.includes(listId))) return;
    setPending(true);
    try { if (await props.onChange(props.task, listId) && props.addOnly) setSearch(""); } finally { setPending(false); }
  };
  const create = async () => {
    if (pending || props.disabled || !query || exact || !props.onCreate) return;
    setPending(true);
    try { if (await props.onCreate(props.task, query)) setSearch(""); } finally { setPending(false); }
  };
  const label = taskListLabel(props.task, props.lists, syncingLists);
  if (!props.onChange && !props.onCreate) return <span>{label}</span>;
  return <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}>
    <PopoverTrigger render={<button type="button" title={props.addOnly ? undefined : label} disabled={props.disabled} data-testid={`task-list-trigger-${props.task.id}`} className={`flex min-h-8 items-center rounded-md text-left outline-none transition-colors hover:bg-dls-hover focus-visible:ring-2 focus-visible:ring-blue-8 data-popup-open:ring-1 data-popup-open:ring-blue-8 disabled:opacity-60 ${props.addOnly ? "gap-1.5 px-2 text-sm text-dls-secondary" : "min-w-24 max-w-48 px-1"}`} />}>
      {props.addOnly ? <><Plus className="size-4" aria-hidden="true" />{t("tasks.add_to_list")}</> : <span className={`truncate ${selectedIds.length ? "rounded-md bg-dls-hover px-2 py-1 text-dls-text/85" : "text-dls-secondary"}`}>{label}</span>}
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" sideOffset={5} positionerClassName={props.addOnly ? "z-[60]" : undefined} data-testid={`task-list-picker-${props.task.id}`} className="w-80 gap-0 rounded-xl border border-dls-border bg-dls-surface p-0 shadow-xl">
      <div className="p-3"><input autoFocus data-testid={`task-list-search-${props.task.id}`} aria-label={t("tasks.search_or_create_list")} placeholder={t("tasks.search_or_create_list")} value={search} disabled={busy} onChange={(event) => setSearch(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && canCreate) { event.preventDefault(); void create(); } }} className="h-10 w-full rounded-lg border border-dls-border bg-dls-surface px-3 text-sm text-dls-text outline-none placeholder:text-dls-secondary focus:border-blue-8 focus:ring-2 focus:ring-blue-8/20" /></div>
      <div className="max-h-72 overflow-y-auto px-2 pb-2">
        {options.map((list) => <button key={list.id} type="button" aria-pressed={props.addOnly ? undefined : selectedIds.includes(list.id)} data-testid={`task-list-option-${props.task.id}-${list.id}`} disabled={busy} onClick={() => void select(list.id)} className="flex h-11 w-full items-center rounded-lg px-3 text-left text-sm text-dls-text hover:bg-dls-hover disabled:opacity-60"><span className="min-w-0 flex-1 truncate">{list.name}</span>{selectedIds.includes(list.id) ? <Check className="size-4 text-blue-10" /> : null}</button>)}
        {canCreate ? <button type="button" data-testid={`task-list-create-${props.task.id}`} disabled={busy} onClick={() => void create()} className="mt-1 flex min-h-12 w-full items-center gap-2 rounded-lg bg-dls-hover px-3 text-left text-sm text-dls-secondary hover:bg-dls-active disabled:opacity-60"><Plus className="size-5 shrink-0" /><span>{t("tasks.create_list_inline")}</span><strong className="min-w-0 truncate font-semibold text-dls-text">{query}</strong></button> : null}
        {props.addOnly && options.length === 0 && !canCreate ? <p className="px-3 py-2 text-sm text-dls-secondary">{t(syncingLists ? "tasks.list_syncing" : "tasks.no_lists_to_add")}</p> : null}
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
const priorityGroupOrder = ["high", "medium", "low", "none"] as const satisfies readonly DenProductTask["priority"][];

export function priorityTaskGroups() {
  return priorityGroupOrder.map((key) => ({ key, label: t(`tasks.priority_${key}`) }));
}

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

export function taskGroupValues(task: DenProductTask, group: TaskWorkbenchGroup, presentation: TaskPresentation, now: Date, customGroupLabel: string, syncingLists = false) {
  if (group === "custom") return [{ key: defaultCustomTaskGroupKey, label: customGroupLabel }];
  if (group === "list") {
    const ids = productTaskListIds(task);
    return ids.length ? ids.map((key) => ({ key, label: taskListName(key, presentation.listById, syncingLists) })) : [{ key: "", label: t("tasks.no_list") }];
  }
  if (group === "creator") return [{ key: task.creatorMemberId, label: taskMemberName(task.creatorMemberId, presentation.memberById) }];
  if (group === "priority") return [{ key: task.priority, label: t(`tasks.priority_${task.priority}`) }];
  if (group === "start" || group === "due") {
    const key = taskTimeGroup(group === "start" ? task.startAt : task.dueAt, group, now);
    return [{ key, label: timeGroupLabel(key, group) }];
  }
  return [{ key: "", label: "" }];
}

type InlineCreatePosition = "top" | "bottom";
export type TaskQuickCreateDefaults = { listId?: string; startAt?: string | null; dueAt?: string | null; priority?: DenProductTask["priority"] };

const taskTitleInset = 38;
// The task's 20px toggle is offset by 24px, so this puts its center at the group chevron's 36px center.
const groupedTaskTitleInset = 50;
const titleInsetAtDepth = (inset: number, depth: number) => inset + Math.min(depth, 8) * 20;

export function taskGroupCreateDefaults(group: TaskWorkbenchGroup, key: string, now = new Date()): TaskQuickCreateDefaults {
  if (group === "list") return key ? { listId: key } : {};
  if (group === "priority") {
    const priority = priorityGroupOrder.find((value) => value === key);
    return priority ? { priority } : {};
  }
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
  const syncingLists = useContext(TaskListSyncContext);
  if (props.field === "assignee") return <EmptyAssigneeIcon />;
  if (props.field === "creator") return props.creatorMemberId ? <MemberCell ids={[props.creatorMemberId]} members={props.members} /> : <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "assigner") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "followers") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "start") return props.defaults.startAt ? <>{formatDate(props.defaults.startAt)}</> : <EmptyTimeIcon field="start" />;
  if (props.field === "due") return props.defaults.dueAt ? <>{formatDate(props.defaults.dueAt)}</> : <EmptyTimeIcon field="due" />;
  if (props.field === "created" || props.field === "updated") return <>{formatDate(props.createdAt)}</>;
  if (props.field === "completed") return <span className="text-dls-secondary/70">{t("tasks.unavailable")}</span>;
  if (props.field === "id") return <span className="font-mono">-</span>;
  if (props.field === "priority") return <TaskPriorityCell priority={props.defaults.priority ?? "none"} />;
  return props.defaults.listId ? <span className="inline-flex rounded-md bg-dls-hover px-2 py-1 text-dls-text/85">{taskListName(props.defaults.listId, props.lists, syncingLists)}</span> : <span className="text-dls-secondary/70">{t("tasks.no_list")}</span>;
}

function TaskFieldCell(props: { field: TaskWorkbenchField; task: DenProductTask; taskMembers: DenProductTaskMember[]; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList>; onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean>; onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate?: (task: DenProductTask, name: string) => Promise<string | null>; onPriorityChange?: (task: DenProductTask, priority: EditableTaskPriority) => Promise<boolean> }) {
  if (props.field === "assignee") {
    const assignees = props.taskMembers.filter((member) => member.role === "assignee");
    const completedIds = new Set(assignees.filter((member) => member.completedAt).map((member) => member.memberId));
    return <AssigneeCell task={props.task} ids={assignees.map((member) => member.memberId)} completedIds={completedIds} members={props.members} onChange={props.onAssigneesChange} onCompletionPolicyChange={props.onCompletionPolicyChange} />;
  }
  const followerIds = props.taskMembers.filter((member) => member.role === "follower").map((member) => member.memberId);
  const assignerIds = [...new Set(props.taskMembers.filter((member) => member.role === "assignee").map((member) => member.createdByMemberId).filter((memberId): memberId is string => Boolean(memberId)))];
  if (props.field === "creator") return <MemberCell ids={[props.task.creatorMemberId]} members={props.members} />;
  if (props.field === "assigner") return <MemberCell ids={assignerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "followers") return <MemberCell ids={followerIds} members={props.members} emptyLabel={t("tasks.unavailable")} />;
  if (props.field === "start") return <TaskDateTimeCell task={props.task} field="startAt" onChange={props.onTimeChange} />;
  if (props.field === "due") return <TaskDateTimeCell task={props.task} field="dueAt" onChange={props.onTimeChange} onLoadReminders={props.onLoadReminders} onReminderChange={props.onReminderChange} />;
  if (props.field === "created") return <>{formatDate(props.task.createdAt)}</>;
  if (props.field === "completed") return <>{formatDate(props.task.completedAt)}</>;
  if (props.field === "updated") return <>{formatDate(props.task.updatedAt)}</>;
  if (props.field === "id") return <TaskIdCell id={props.task.id} displayNumber={props.task.displayNumber} />;
  if (props.field === "priority") {
    const { task, onPriorityChange } = props;
    return onPriorityChange
      ? <TaskPrioritySelect testId={`task-priority-trigger-${task.id}`} value={task.priority} onChange={(priority) => onPriorityChange(task, priority)} />
      : <TaskPriorityCell priority={task.priority} />;
  }
  return <TaskListCell task={props.task} lists={props.lists} onChange={props.onListChange} onCreate={props.onListCreate} />;
}

function InlineCreateRow(props: { testId: string; titleInset: number; fields: TaskWorkbenchField[]; title: string; pending: boolean; creatorMemberId: string | null; createdAt: string; defaults: TaskQuickCreateDefaults; members: Map<string, DenOrganizationMember>; lists: Map<string, DenProductTaskList>; onTitleChange: (title: string) => void; onSubmit: (title?: string) => void; onCancel: () => void }) {
  return <tr data-testid={props.testId} className="h-12 bg-dls-active/80"><td className="border-b border-blue-6/40 py-1.5 align-middle" style={{ paddingInlineStart: props.titleInset }}><form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}><span className="size-4 shrink-0 rounded-full border border-dls-secondary/70" aria-hidden="true" /><input autoFocus aria-label={t("tasks.field_title")} placeholder={t("tasks.title_placeholder")} value={props.title} disabled={props.pending} onChange={(event) => props.onTitleChange(event.currentTarget?.value ?? event.target.value)} onBlur={(event) => { if (props.pending) return; const title = event.currentTarget.value.trim(); if (title) props.onSubmit(title); else props.onCancel(); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onCancel(); } }} className="h-9 min-w-0 flex-1 rounded-sm border border-blue-8 bg-dls-surface px-2 text-sm text-dls-text outline-none ring-1 ring-blue-8/20 placeholder:text-dls-secondary/60 focus:ring-2 focus:ring-blue-8/35" /></form></td>{props.fields.map((field) => <td key={field} className="border-b border-blue-6/40 px-4 py-2 align-middle whitespace-nowrap text-dls-secondary"><InlineCreateField field={field} creatorMemberId={props.creatorMemberId} createdAt={props.createdAt} defaults={props.defaults} members={props.members} lists={props.lists} /></td>)}</tr>;
}

type TaskRowDropHandlers = Pick<React.ComponentProps<"tr">, "onDragOver" | "onDragLeave" | "onDrop">;

function TaskGroupHeader(props: { groupKey: string; group: TaskWorkbenchGroup; label: string; count: number; expanded: boolean; columnCount: number; members: Map<string, DenOrganizationMember>; renaming: boolean; renameDraft: string; onRenameDraftChange: (value: string) => void; onRenameStart: () => void; onRenameFinish: () => void; onRenameCancel: () => void; onDelete: () => void; onToggle: () => void; onAdd: () => void; dropHandlers?: TaskRowDropHandlers; dropTarget: boolean }) {
  const custom = props.group === "custom";
  const protectedGroup = props.groupKey === defaultCustomTaskGroupKey;
  return <tr data-testid={`task-group-row-${props.groupKey}`} data-drop-placement={props.dropTarget ? "group" : undefined} className="group/task-group data-[drop-placement=group]:bg-blue-3" {...props.dropHandlers}><th colSpan={props.columnCount} className="px-6 py-2.5 text-left text-sm font-semibold text-dls-text"><div className="flex items-center gap-1">
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

export type TaskSubtaskLoading = {
  /** Fetch authorized direct children, independent of the root list's filters. */
  onLoadSubtasks?: (parentTaskId: string, cursor?: string) => Promise<DenProductTaskPage>;
  /** Advance after invalidating child data to reload open placements and discard pending results. */
  subtasksRevision?: string | number;
};

function completionIndicatorClass({ status, isMilestone }: DenProductTask) {
  const color = status === "completed" ? "border-green-8 bg-green-8 text-white" : "border-dls-secondary";
  return `flex size-4 shrink-0 items-center justify-center ${taskMarkerShape(isMilestone)} border ${color}`;
}

function completionMark(status: DenProductTask["status"]) {
  if (status === "completed") return <Check className="size-3" />;
  return status === "canceled" ? <RotateCcw className="size-2.5" /> : null;
}

export type SaveTaskTitle = (task: DenProductTask, previousTitle: string, title: string) => Promise<"saved" | "failed" | "conflict">;
type TitleDraft = { original: string; value: string; status: "editing" | "saving" | "failed" | "conflict" };

function TaskListTitle({ task, draft, setDraft, onSave, onSelect }: {
  task: DenProductTask; draft?: TitleDraft; setDraft: (draft?: TitleDraft) => void; onSave?: SaveTaskTitle; onSelect: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const canceled = useRef(false);
  const save = async (value: string) => {
    if (!draft || !onSave || draft.status === "saving" || canceled.current) return;
    const title = value.trim();
    if (!title || title === draft.original) { setDraft(); return; }
    setDraft({ ...draft, value, status: "saving" });
    const result = await onSave(task, draft.original, title).catch(() => "failed" as const);
    setDraft(result === "saved" ? undefined : { ...draft, value, status: result });
  };
  if (!draft) return <button type="button" title={task.title} className={`block min-w-0 max-w-[290px] truncate text-left text-sm font-normal leading-5 text-dls-text hover:text-blue-10 ${task.status === "completed" ? "line-through opacity-60" : ""}`} onClick={() => {
    if (!onSave) { onSelect(task.id); return; }
    canceled.current = false;
    flushSync(() => setDraft({ original: task.title, value: task.title, status: "editing" }));
    input.current?.focus();
  }}>{task.title}</button>;
  const failed = draft.status === "conflict" || draft.status === "failed";
  return <div className="min-w-0 flex-1" data-task-title-editor>
    <input ref={input} aria-label={t("tasks.field_title")} value={draft.value} readOnly={draft.status === "saving"} aria-invalid={failed || undefined}
      className="h-7 w-full min-w-0 rounded border border-blue-8 bg-dls-surface px-1 text-sm text-dls-text outline-none"
      onChange={event => setDraft({ ...draft, value: event.currentTarget.value, status: "editing" })}
      onBlur={event => void save(event.currentTarget.value)} onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || draft.status === "saving") return;
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); canceled.current = true; setDraft(); }
      }} />
    {failed ? <span role="alert" className="block text-xs text-red-9">{t(draft.status === "conflict" ? "tasks.list_title_conflict" : "tasks.list_title_save_error")}</span> : null}
  </div>;
}

function renderTaskTitleCell(props: { task: DenProductTask; title: ReactNode; depth: number; titleInset: number; expanded: boolean; reorderHandle?: ReactNode; onToggle?: () => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete-whole" | "reopen", anchor?: HTMLElement) => void }) {
  const { task, depth } = props;
  const attachments = splitTaskAttachments(task.description).files.length;
  const subtasks = task.subtaskCount ?? 0;
  const completed = task.completedSubtaskCount ?? 0;
  const comments = task.commentCount ?? 0;
  const parent = depth === 0 ? task.parentTask : undefined;
  const expandLabel = props.onToggle ? t(props.expanded ? "tasks.collapse_subtasks" : "tasks.expand_subtasks", { title: task.title }) : undefined;
  return <td className="border-b border-dls-border py-2 pe-2 align-middle" style={{ paddingInlineStart: titleInsetAtDepth(props.titleInset, depth) }}>
    <div className="relative flex items-center gap-2" data-testid={`task-title-cell-${task.id}`}>
      {props.reorderHandle}
      {depth > 0 ? <span aria-hidden="true" className="pointer-events-none absolute -start-9 bottom-1/2 h-6 w-3 rounded-es border-b border-s border-dls-border" /> : null}
      {props.onToggle ? <button type="button" data-testid={`task-subtasks-toggle-${task.id}`} aria-label={expandLabel} title={expandLabel} aria-expanded={props.expanded} onClick={props.onToggle} className="absolute -start-6 flex size-5 items-center justify-center rounded text-dls-secondary hover:bg-dls-active hover:text-dls-text focus-visible:outline-2 focus-visible:outline-blue-8">{props.expanded ? <ChevronDown aria-hidden="true" className="size-3" /> : <ChevronRight aria-hidden="true" className="size-3 rtl:rotate-180" />}</button> : null}
      <button type="button" className={`${completionIndicatorClass(task)} transition-colors hover:border-dls-accent`} aria-description={task.isMilestone ? t("tasks.milestone") : undefined} aria-label={t(task.status === "todo" ? "tasks.complete" : "tasks.reopen")} onClick={(event) => props.onTransition(task, task.status === "todo" ? "complete-whole" : "reopen", event?.currentTarget)}>{completionMark(task.status)}</button>
      {props.title}
      {parent ? <button type="button" data-testid={`task-parent-link-${task.id}`} title={parent.title} aria-label={t("tasks.parent_task", { title: parent.title })} onClick={() => props.onSelect(parent.id)} className="flex min-w-0 max-w-28 items-center gap-1 rounded text-xs text-dls-secondary hover:text-blue-10 hover:underline focus-visible:outline-2 focus-visible:outline-blue-8"><CornerUpLeft aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{parent.title}</span></button> : null}
      {subtasks > 0 || attachments > 0 || comments > 0 ? <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-dls-secondary">
        {subtasks > 0 ? <TaskTitleCount kind="subtasks" label={t("tasks.subtasks_progress", { completed, total: subtasks })} icon={ListTree} value={`${completed}/${subtasks}`} /> : null}
        {attachments > 0 ? <TaskTitleCount kind="attachments" label={t("tasks.attachment_count", { count: attachments })} icon={Paperclip} value={attachments} /> : null}
        {comments > 0 ? <TaskTitleCount kind="comments" label={t("tasks.comment_count", { count: comments })} icon={MessageSquare} value={comments} /> : null}
      </span> : null}
    </div>
  </td>;
}

function TaskTitleCount({ kind, label, value, icon: Icon }: { kind: string; label: string; value: string | number; icon: LucideIcon }) {
  return <span data-testid={`task-title-count-${kind}`} className="inline-flex items-center gap-1" title={label}><Icon aria-hidden="true" className="size-3.5" /><span aria-hidden="true">{value}</span><span className="sr-only">{label}</span></span>;
}

type SubtaskPageRequest = { cursor?: string; revision?: TaskSubtaskLoading["subtasksRevision"] };
type SubtaskPageResult = {
  request: SubtaskPageRequest;
  revision: TaskSubtaskLoading["subtasksRevision"];
  pages: DenProductTaskPage[];
  failed: boolean;
  retryCursor?: string;
};

// Collapsing a branch drops its pages. Background refreshes keep its mounted
// rows until the same number of pages has been read using fresh cursors.
function TaskSubtaskRows(props: { parentId: string; revision?: TaskSubtaskLoading["subtasksRevision"]; path: string[]; titleInset: number; columnCount: number; onLoad: NonNullable<TaskSubtaskLoading["onLoadSubtasks"]>; renderRow: (task: DenProductTask, members?: DenProductTaskMember[]) => ReactNode }) {
  const [request, setRequest] = useState<SubtaskPageRequest>({});
  const [result, setResult] = useState<SubtaskPageResult>();
  const loadPage = useEffectEvent((cursor?: string) => props.onLoad(props.parentId, cursor));
  const loadedPages = useEffectEvent(() => result?.pages ?? []);
  const revision = props.revision;
  useEffect(() => {
    let active = true;
    const previous = loadedPages();
    const appendCursor = request.revision === revision ? request.cursor : undefined;
    async function load() {
      const pages = appendCursor ? [...previous] : [];
      const count = appendCursor ? 1 : Math.max(previous.length, 1);
      let cursor = appendCursor;
      try {
        for (let i = 0; i < count; i++) {
          const page = await loadPage(cursor);
          if (!active) return;
          const nextCursor = page.nextCursor === cursor ? "" : page.nextCursor;
          pages.push({ ...page, nextCursor });
          if (!nextCursor) break;
          cursor = nextCursor;
        }
        setResult({ pages, request, revision, failed: false });
      } catch (error) {
        if (!active) return;
        if (appendCursor && isInvalidTaskCursor(error)) {
          setRequest({});
          return;
        }
        const inaccessible = error instanceof DenApiError && [401, 403, 404, 410].includes(error.status);
        setResult({ pages: inaccessible ? [] : previous, request, revision, failed: true, retryCursor: inaccessible ? undefined : appendCursor });
      }
    }
    void load();
    return () => { active = false; };
  }, [props.parentId, revision, request]);

  const items = new Map<string, DenProductTask>();
  const members: NonNullable<DenProductTaskPage["membersByTaskId"]> = {};
  for (const page of result?.pages ?? []) {
    for (const task of page.items) {
      if (!task.deletedAt && (!task.parentTask || task.parentTask.id === props.parentId) && !props.path.includes(task.id)) items.set(task.id, task);
    }
    Object.assign(members, page.membersByTaskId);
  }
  const children = [...items.values()];
  const nextCursor = result?.pages.at(-1)?.nextCursor;
  const pending = result?.request !== request || result?.revision !== revision;
  const status = !result ? <span role="status">{t("tasks.loading")}</span>
    : result.failed ? <><span role="alert">{t("tasks.subtasks_load_error")}</span><button type="button" disabled={pending} className="hover:underline" onClick={() => setRequest({ cursor: result.retryCursor, revision })}>{t("tasks.retry")}</button></>
    : nextCursor ? <button type="button" disabled={pending} className="hover:underline" onClick={() => setRequest({ cursor: nextCursor, revision })}>{t("tasks.load_more_subtasks")}</button>
    : children.length === 0 ? <span>{t("tasks.no_visible_subtasks")}</span> : null;
  return <>{children.map((task) => props.renderRow(task, members[task.id]))}{status ? <tr data-testid={`task-subtasks-status-${props.parentId}`}><td colSpan={props.columnCount} style={{ paddingInlineStart: titleInsetAtDepth(props.titleInset, props.path.length) }} className="py-2 text-xs text-dls-secondary"><div className="flex items-center gap-2">{status}</div></td></tr> : null}</>;
}

type TaskListDragging = {
  onReorder?: (taskIds: string[]) => void;
  groupMove?: TaskGroupMove;
  showFilingTargets?: boolean;
  reserveDragHandle?: boolean;
  dragDisabled?: boolean;
};
export type TaskGroupMove = (task: DenProductTask, source: string, destination: string) => (() => void | Promise<boolean>) | undefined;

export function addTaskListGroupTargets(groups: Map<string, { label: string; tasks: DenProductTask[] }>, lists: Map<string, DenProductTaskList>) {
  groups.set("", { label: t("tasks.no_list"), tasks: [] });
  for (const list of lists.values()) if (!list.archivedAt) groups.set(list.id, { label: list.name, tasks: [] });
}
type TaskDragRow = { id: string; group: TaskWorkbenchGroup; groupKey: string };
type TaskDropMarker = Omit<TaskDragRow, "id"> & { id?: string; placement: TaskOrderPlacement | "group" };

function taskDropPlacement(event: DragEvent<HTMLTableRowElement>): TaskOrderPlacement {
  const { top, height } = event.currentTarget.getBoundingClientRect();
  return event.clientY < top + height / 2 ? "before" : "after";
}

export function TaskListTable(props: TaskPresentation & TaskSubtaskLoading & TaskListDragging & { onTitleChange?: SaveTaskTitle; fields: TaskWorkbenchField[]; group: TaskWorkbenchGroup; customGroupName: string; customGroups: TaskCustomGroup[]; customGroupAssignments: Record<string, string>; selectedTaskId: string | null; inlineCreatePosition: InlineCreatePosition | null; inlineCreateGroupKey: string | null; inlineCreateDefaults: TaskQuickCreateDefaults; inlineCreateTitle: string; inlineCreatePending: boolean; inlineCreateMemberId: string | null; inlineCreateCreatedAt: string; onCustomGroupsChange: (groups: TaskCustomGroup[]) => void; onCustomGroupNameChange: (name: string) => void; onInlineCreatePositionChange: (position: InlineCreatePosition | null, groupKey?: string) => void; onInlineCreateTitleChange: (title: string) => void; onInlineCreateSubmit: () => void; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete-whole" | "reopen", anchor?: HTMLElement) => void; onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onLoadReminders?: (task: DenProductTask) => Promise<DenProductTaskReminder[]>; onReminderChange?: (task: DenProductTask, reminder: TaskReminderDraft) => Promise<boolean>; onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate?: (task: DenProductTask, name: string) => Promise<string | null>; onPriorityChange?: (task: DenProductTask, priority: EditableTaskPriority) => Promise<boolean> }) {
  // Nested rows can remount when a list refreshes. Keep unfinished edits with their placement.
  const [titleDrafts, setTitleDrafts] = useState<Record<string, TitleDraft>>({});
  const setTitleDraft = (placement: string, draft?: TitleDraft) => setTitleDrafts(current => {
    const next = { ...current };
    if (draft) next[placement] = draft;
    else delete next[placement];
    return next;
  });
  const [groupExpansion, setGroupExpansion] = useState<Record<string, boolean>>({});
  const [collapsedPlacements, setCollapsedPlacements] = useState<Set<string>>(() => new Set());
  const [renamingCustomGroupKey, setRenamingCustomGroupKey] = useState<string | null>(null);
  const [customGroupNameDraft, setCustomGroupNameDraft] = useState("");
  const [creatingCustomGroup, setCreatingCustomGroup] = useState(false);
  const [customGroupCreateDraft, setCustomGroupCreateDraft] = useState("");
  const dragSource = useRef<TaskDragRow | null>(null);
  const [dropMarker, setDropMarker] = useState<TaskDropMarker | null>(null);
  const [dragPreview, setDragPreview] = useState<{ placement: string; task: DenProductTask } | null>(null);
  const previewElement = useRef<HTMLDivElement>(null);
  const endDrag = () => { dragSource.current = null; setDropMarker(null); setDragPreview(null); };
  const visibleFields = props.fields;
  const titleInset = (props.group === "none" ? taskTitleInset : groupedTaskTitleInset) + (props.reserveDragHandle ? 12 : 0);
  const groups = new Map<string, { label: string; tasks: DenProductTask[] }>();
  const syncingLists = useContext(TaskListSyncContext);
  const now = new Date();
  const customGroupLabel = props.customGroupName.trim() || t("tasks.group_default");
  if (props.group === "list" && props.showFilingTargets) addTaskListGroupTargets(groups, props.listById);
  if (props.group === "custom") {
    groups.set(defaultCustomTaskGroupKey, { label: customGroupLabel, tasks: [] });
    for (const group of props.customGroups) groups.set(group.id, { label: group.name, tasks: [] });
  }
  if (props.group === "start" || props.group === "due") {
    for (const key of timeGroupOrder) groups.set(key, { label: timeGroupLabel(key, props.group), tasks: [] });
  }
  if (props.group === "priority") {
    for (const { key, label } of priorityTaskGroups()) groups.set(key, { label, tasks: [] });
  }
  if (props.group === "creator" && props.inlineCreateMemberId) {
    groups.set(props.inlineCreateMemberId, { label: taskMemberName(props.inlineCreateMemberId, props.memberById), tasks: [] });
  }
  for (const task of props.tasks) {
    const assignedCustomGroup = props.group === "custom" ? props.customGroupAssignments[task.id] : undefined;
    const values = assignedCustomGroup && groups.has(assignedCustomGroup)
      ? [{ key: assignedCustomGroup, label: groups.get(assignedCustomGroup)!.label }]
      : taskGroupValues(task, props.group, props, now, customGroupLabel, syncingLists);
    for (const { key, label } of values) {
      if (!groups.has(key)) groups.set(key, { label, tasks: [] });
      groups.get(key)!.tasks.push(task);
    }
  }
  const rows = props.group === "none" ? [["", { label: "", tasks: props.tasks }] as const] : [...groups.entries()];
  const siblingsFor = (groupKey: string) => props.group === "none" ? props.tasks : groups.get(groupKey)?.tasks ?? [];
  const moveTask = (source: string, anchor: string, groupKey: string, position: TaskOrderPlacement) => {
    if (!props.onReorder || props.dragDisabled) return;
    const visible = props.tasks.map((task) => task.id);
    const next = moveTaskWithinGroup(visible, siblingsFor(groupKey).map((task) => task.id), source, anchor, position);
    if (next !== visible) props.onReorder(next);
  };
  const getDrop = (groupKey: string, id?: string) => {
    const source = dragSource.current;
    if (props.dragDisabled || !source || source.group !== props.group) return null;
    const task = siblingsFor(source.groupKey).find(({ id }) => id === source.id);
    if (!task) return null;
    if (source.groupKey !== groupKey) {
      const move = props.groupMove?.(task, source.groupKey, groupKey);
      return move ? { action: "group" as const, move } : null;
    }
    return id && source.id !== id && props.onReorder ? { source, action: "reorder" as const } : null;
  };
  const matchesDropTarget = (marker: TaskDropMarker | null, groupKey: string, id?: string) => marker?.group === props.group && marker.groupKey === groupKey && marker.id === id;
  const dropHandlers = (groupKey: string, id?: string): TaskRowDropHandlers => ({
    onDragOver: (event) => {
      const drop = getDrop(groupKey, id);
      if (!drop) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const placement = drop.action === "group" ? "group" : taskDropPlacement(event);
      setDropMarker((current) => matchesDropTarget(current, groupKey, id) && current?.placement === placement ? current : { id, group: props.group, groupKey, placement });
    },
    onDragLeave: (event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
        setDropMarker((current) => matchesDropTarget(current, groupKey, id) ? null : current);
      }
    },
    onDrop: (event) => {
      const drop = getDrop(groupKey, id);
      if (!drop) return;
      event.preventDefault();
      endDrag();
      if (drop.action === "group") void drop.move();
      else if (id) moveTask(drop.source.id, id, groupKey, taskDropPlacement(event));
    },
  });
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
  const inlineRow = (testId: string) => <InlineCreateRow key={testId} testId={testId} titleInset={titleInset} fields={visibleFields} title={props.inlineCreateTitle} pending={props.inlineCreatePending} creatorMemberId={props.inlineCreateMemberId} createdAt={props.inlineCreateCreatedAt} defaults={props.inlineCreateDefaults} members={props.memberById} lists={props.listById} onTitleChange={props.onInlineCreateTitleChange} onSubmit={props.onInlineCreateSubmit} onCancel={() => props.onInlineCreatePositionChange(null)} />;
  const renderTaskRow = (task: DenProductTask, groupKey: string, ancestors: string[] = [], projectedMembers?: DenProductTaskMember[]): ReactNode => {
    const path = [...ancestors, task.id];
    const placement = JSON.stringify([props.group, groupKey, ...path]);
    const taskMembers = projectedMembers ?? props.membersByTaskId[task.id] ?? [];
    const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
    const loadSubtasks = (task.subtaskCount ?? 0) > 0 ? props.onLoadSubtasks : undefined;
    const expanded = Boolean(loadSubtasks && !collapsedPlacements.has(placement));
    const onToggle = loadSubtasks ? () => setCollapsedPlacements((current) => {
      const next = new Set(current);
      if (next.has(placement)) next.delete(placement);
      else next.add(placement);
      return next;
    }) : undefined;
    const outer = ancestors.length === 0;
    const canDrag = outer && (Boolean(props.onReorder) || Boolean(props.groupMove && [...groups.keys()].some((target) => props.groupMove?.(task, groupKey, target))));
    const canReceiveDrop = outer && !props.dragDisabled && Boolean(props.onReorder || props.groupMove);
    const marker = canReceiveDrop && matchesDropTarget(dropMarker, groupKey, task.id) ? dropMarker?.placement : undefined;
    const reorderHandle = canDrag ? <button type="button" data-testid={`task-reorder-${task.id}`} draggable={!props.dragDisabled} aria-disabled={props.dragDisabled || undefined}
      aria-label={t(props.onReorder ? "tasks.reorder_task" : "tasks.move_task_to_group", { title: task.title })} title={t(props.onReorder ? "tasks.reorder_field_hint" : "tasks.move_task_to_group_hint")}
      className="pointer-events-none absolute -start-12 grid size-6 cursor-grab place-items-center rounded-md text-dls-secondary opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-dls-active focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-8 active:cursor-grabbing aria-disabled:cursor-default"
      onDragStart={(event) => {
        if (props.dragDisabled) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        dragSource.current = { id: task.id, group: props.group, groupKey };
        // Native drag images must be in the DOM before dragstart returns.
        flushSync(() => setDragPreview({ placement, task }));
        const preview = previewElement.current;
        if (preview) {
          const gripCenter = 32; // Snapshot padding, card padding and half the grip width.
          const x = getComputedStyle(preview).direction === "rtl" ? preview.offsetWidth - gripCenter : gripCenter;
          event.dataTransfer.setDragImage(preview, x, preview.offsetHeight / 2);
          // After the snapshot the platform moves its own copy with the pointer.
          requestAnimationFrame(() => { preview.hidden = true; });
        }
      }} onDragEnd={endDrag}
      onKeyDown={props.onReorder ? (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        if (props.dragDisabled || event.repeat) return;
        const siblings = siblingsFor(groupKey);
        const offset = event.key === "ArrowUp" ? -1 : 1;
        const target = siblings[siblings.findIndex(({ id }) => id === task.id) + offset];
        if (target) moveTask(task.id, target.id, groupKey, offset < 0 ? "before" : "after");
      } : undefined}><GripVertical aria-hidden="true" className="size-4" /></button> : undefined;
    return <Fragment key={placement}>
      <tr data-task-id={task.id} data-task-depth={ancestors.length} data-state={props.selectedTaskId === task.id ? "selected" : undefined} data-drop-placement={marker} data-dragging={dragPreview?.placement === placement || undefined}
        tabIndex={0} aria-label={`${t("tasks.detail")} · ${task.title}`}
        onKeyDown={event => { if (event.target === event.currentTarget && event.key === "Enter") { event.preventDefault(); props.onSelect(task.id); } }}
        onClick={event => {
          const target = event.target;
          if (target === event.currentTarget || (target instanceof Element && target.closest("tr") === event.currentTarget
            && target.matches("td, div") && !target.closest("button, a, [role=button], [data-task-title-editor]"))) props.onSelect(task.id);
        }}
        className="group h-12 cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-blue-8 hover:bg-dls-hover/75 data-[dragging=true]:bg-dls-hover data-[dragging=true]:[&>td:first-child>div]:opacity-30 data-[state=selected]:bg-dls-active data-[drop-placement=group]:bg-blue-3 data-[drop-placement=before]:shadow-[inset_0_2px_0] data-[drop-placement=after]:shadow-[inset_0_-2px_0] shadow-blue-9"
        {...(canReceiveDrop ? dropHandlers(groupKey, task.id) : undefined)}>
        {renderTaskTitleCell({ task, title: <TaskListTitle task={task} draft={titleDrafts[placement]} setDraft={draft => setTitleDraft(placement, draft)} onSave={props.onTitleChange} onSelect={props.onSelect} />, depth: ancestors.length, titleInset, expanded, reorderHandle, onToggle, onSelect: props.onSelect, onTransition: props.onTransition })}
        {visibleFields.map((field) => <td key={field} className={`border-b border-dls-border px-4 py-2 align-middle whitespace-nowrap ${field === "due" && overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}><TaskFieldCell field={field} task={task} taskMembers={taskMembers} members={props.memberById} lists={props.listById} onAssigneesChange={props.onAssigneesChange} onCompletionPolicyChange={props.onCompletionPolicyChange} onTimeChange={props.onTimeChange} onLoadReminders={props.onLoadReminders} onReminderChange={props.onReminderChange} onListChange={props.onListChange} onListCreate={props.onListCreate} onPriorityChange={props.onPriorityChange} /></td>)}
      </tr>
      {expanded && loadSubtasks ? <TaskSubtaskRows revision={props.subtasksRevision} parentId={task.id} path={path} titleInset={titleInset} columnCount={visibleFields.length + 1} onLoad={loadSubtasks} renderRow={(child, members) => renderTaskRow(child, groupKey, path, members)} /> : null}
    </Fragment>;
  };
  return <div className="min-h-0 w-full flex-1 overflow-auto" data-testid="assigned-task-table">
    {dragPreview ? <div key={dragPreview.placement} ref={previewElement} aria-hidden="true" className="pointer-events-none fixed start-0 top-0 z-50 select-none p-4">
      <div className="flex h-12 w-[min(30rem,calc(100vw-2rem))] items-center gap-3 rounded-md bg-dls-surface px-2 shadow-lg">
        <GripVertical className="size-4 shrink-0 text-dls-secondary" />
        <span className={completionIndicatorClass(dragPreview.task)}>{completionMark(dragPreview.task.status)}</span>
        <span className={`truncate text-sm text-dls-text ${dragPreview.task.status === "completed" ? "line-through opacity-60" : ""}`}>{dragPreview.task.title}</span>
      </div>
    </div> : null}
    <table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-sm [&_tbody_tr.group]:relative [&_tbody_tr.group]:after:pointer-events-none [&_tbody_tr.group]:after:absolute [&_tbody_tr.group]:after:bottom-0 [&_tbody_tr.group]:after:left-[38px] [&_tbody_tr.group]:after:right-6 [&_tbody_tr.group]:after:h-px [&_tbody_tr.group]:after:bg-dls-border [&_tbody_tr.group]:after:content-[''] [&_tbody_tr.group_td]:border-b-0">
    <colgroup><col style={{ width: 360 }} />{visibleFields.map((field) => <col key={field} style={{ width: field === "id" ? 260 : field === "created" || field === "completed" || field === "updated" ? 180 : 160 }} />)}</colgroup>
    <thead className="sticky top-0 z-10 bg-dls-surface"><tr><th className="py-3 text-left text-[12px] font-normal text-dls-secondary" style={{ paddingInlineStart: titleInset }}><span className="inline-flex items-center gap-2" data-testid="task-title-header"><ALargeSmall aria-hidden="true" className="size-4 shrink-0" />{t("tasks.field_title")}</span></th>{visibleFields.map((field) => { const FieldIcon = fieldIcons[field]; return <th key={field} className="px-4 py-3 text-left text-[12px] font-normal text-dls-secondary"><span className="inline-flex items-center gap-1.5">{FieldIcon ? <FieldIcon className="size-3.5" /> : null}{t(fieldLabels[field])}</span></th>; })}</tr></thead>
    <tbody>
      {props.inlineCreatePosition === "top" && props.inlineCreateGroupKey === null ? inlineRow("task-inline-create-row-top") : null}
      {rows.map(([groupKey, group]) => {
        const collapseKey = `${props.group}:${groupKey}`;
        const expanded = props.inlineCreateGroupKey === groupKey || (groupExpansion[collapseKey] ?? group.tasks.length > 0);
        const groupInlineRow = props.inlineCreateGroupKey === groupKey ? inlineRow(`task-inline-create-row-group-${groupKey}`) : null;
        return <Fragment key={groupKey}>
          {props.group !== "none" ? <TaskGroupHeader groupKey={groupKey} group={props.group} label={group.label} count={group.tasks.length} expanded={expanded} columnCount={visibleFields.length + 1} members={props.memberById} renaming={props.group === "custom" && groupKey === renamingCustomGroupKey} renameDraft={customGroupNameDraft} onRenameDraftChange={setCustomGroupNameDraft} onRenameStart={() => startCustomGroupRename(groupKey, group.label)} onRenameFinish={finishCustomGroupRename} onRenameCancel={() => setRenamingCustomGroupKey(null)} onDelete={() => props.onCustomGroupsChange(props.customGroups.filter((item) => item.id !== groupKey))} onToggle={() => toggleGroup(collapseKey, expanded)} onAdd={() => { if (!expanded) setGroupExpansion((current) => ({ ...current, [collapseKey]: true })); props.onInlineCreatePositionChange("top", groupKey); }} dropHandlers={props.groupMove && !props.dragDisabled ? dropHandlers(groupKey) : undefined} dropTarget={Boolean(props.groupMove) && !props.dragDisabled && matchesDropTarget(dropMarker, groupKey)} /> : null}
          {expanded ? <>
            {props.inlineCreatePosition === "top" ? groupInlineRow : null}
            {group.tasks.map((task) => renderTaskRow(task, groupKey))}
            {props.group !== "none" && props.inlineCreatePosition === "bottom" ? groupInlineRow : null}
            {props.group !== "none" && props.group !== "creator" ? <tr><td className="py-2.5" style={{ paddingInlineStart: titleInset }} colSpan={visibleFields.length + 1}><button type="button" data-testid={`task-inline-create-group-trigger-${groupKey}`} onClick={() => props.onInlineCreatePositionChange("bottom", groupKey)} className="flex items-center gap-2 text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10"><span className="size-4 shrink-0" aria-hidden="true" />{t("tasks.new_task")}</button></td></tr> : null}
          </> : groupInlineRow}
        </Fragment>;
      })}
      {props.group === "custom" ? <tr data-testid="task-custom-group-create-row"><td className="py-3 pl-[38px]" colSpan={visibleFields.length + 1}>{creatingCustomGroup ? <div className="flex items-center gap-2"><ChevronRight className="size-4 text-dls-secondary" /><input autoFocus data-testid="task-custom-group-create-input" aria-label={t("tasks.group_name")} placeholder={t("tasks.group_title_placeholder")} value={customGroupCreateDraft} maxLength={80} onChange={(event) => setCustomGroupCreateDraft(event.currentTarget.value)} onBlur={finishCustomGroupCreate} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishCustomGroupCreate(); } else if (event.key === "Escape") { event.preventDefault(); setCreatingCustomGroup(false); setCustomGroupCreateDraft(""); } }} className="h-9 w-80 rounded-md border border-blue-8 bg-dls-surface px-3 text-sm font-semibold text-dls-text outline-none ring-2 ring-blue-8/20 placeholder:text-dls-secondary/65" /></div> : null}<button type="button" data-testid="task-custom-group-create-trigger" onClick={() => setCreatingCustomGroup(true)} className="mt-2 flex items-center gap-2 text-sm font-semibold text-dls-secondary/65 transition-colors hover:text-blue-10"><Plus className="size-4" />{t("tasks.new_group")}</button></td></tr> : null}
      {props.group === "none" && props.inlineCreatePosition === "bottom" ? inlineRow("task-inline-create-row-bottom") : null}
      {props.group === "none" ? <tr><td className="py-2.5 pl-[38px]" colSpan={visibleFields.length + 1}><button type="button" data-testid="task-inline-create-bottom-trigger" onClick={() => props.onInlineCreatePositionChange("bottom")} className="flex items-center gap-2 text-[13px] text-dls-secondary/65 transition-colors hover:text-blue-10"><span className="size-4 shrink-0" aria-hidden="true" />{t("tasks.new_task")}</button></td></tr> : null}
    </tbody>
  </table></div>;
}

export function TaskLoadMore(props: { visible: boolean; pending: boolean; onLoad: () => void }) {
  return props.visible ? <div className="flex justify-center border-t border-dls-border p-3"><Button variant="outline" disabled={props.pending} onClick={props.onLoad}>{props.pending ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : null;
}

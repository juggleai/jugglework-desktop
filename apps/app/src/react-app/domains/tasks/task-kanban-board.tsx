import { Calendar, CalendarDays, Check, Plus, RotateCcw } from "lucide-react";
import { useState, type DragEvent } from "react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskList, DenProductTaskMember } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { t } from "@/i18n";
import { TaskDateTimeCell, type TaskTimeField } from "./task-date-time-cell";
import { defaultCustomTaskGroupKey, taskGroupCreateDefaults, taskGroupValue, taskMemberName, timeGroupLabel, timeGroupOrder, type TaskPresentation, type TaskQuickCreateDefaults } from "./task-list-table";
import type { TaskWorkbenchSettings } from "./task-view-state";

export function TaskKanbanBoard(props: { tasks: DenProductTask[]; membersByTaskId: Record<string, DenProductTaskMember[]>; memberById: Map<string, DenOrganizationMember>; listById: Map<string, DenProductTaskList>; currentMemberId: string | null; settings: TaskWorkbenchSettings; quickCreatePending?: boolean; onSettingsChange: (settings: TaskWorkbenchSettings) => void; onQuickCreate?: (title: string, defaults: TaskQuickCreateDefaults) => Promise<boolean | string>; onTimeChange?: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onSelect: (id: string) => void; onTransition: (task: DenProductTask, operation: "complete" | "reopen" | "cancel") => void }) {
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [creatingTaskGroup, setCreatingTaskGroup] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDraft, setTaskDraft] = useState<TaskQuickCreateDefaults>({});
  const [submitting, setSubmitting] = useState(false);
  const finishGroupCreate = (liveValue?: string) => { const name = (liveValue ?? groupDraft).trim(); setCreatingGroup(false); setGroupDraft(""); if (name) props.onSettingsChange({ ...props.settings, customGroups: [...props.settings.customGroups, { id: `custom-${crypto.randomUUID()}`, name }] }); };
  const presentation: TaskPresentation = { tasks: props.tasks, membersByTaskId: props.membersByTaskId, memberById: props.memberById, listById: props.listById };
  const groups = new Map<string, { label: string; tasks: DenProductTask[] }>();
  const customLabel = props.settings.customGroupName.trim() || t("tasks.group_default");
  if (props.settings.group === "custom") {
    groups.set(defaultCustomTaskGroupKey, { label: customLabel, tasks: [] });
    for (const group of props.settings.customGroups) groups.set(group.id, { label: group.name, tasks: [] });
  }
  if (props.settings.group === "start" || props.settings.group === "due") {
    for (const key of timeGroupOrder) groups.set(key, { label: timeGroupLabel(key, props.settings.group), tasks: [] });
  }
  for (const task of props.tasks) {
    const assigned = props.settings.group === "custom" ? props.settings.customGroupAssignments[task.id] : undefined;
    const group = assigned && groups.has(assigned) ? { key: assigned, label: groups.get(assigned)!.label } : taskGroupValue(task, props.settings.group === "none" ? "custom" : props.settings.group, presentation, new Date(), customLabel);
    const current = groups.get(group.key);
    groups.set(group.key, { label: group.label, tasks: [...(current?.tasks ?? []), task] });
  }
  const createDefaults = (key: string) => ({ ...taskGroupCreateDefaults(props.settings.group, key), ...taskDraft });
  const closeCreate = () => { setCreatingTaskGroup(null); setTaskTitle(""); setTaskDraft({}); };
  const submitTask = async (key: string, liveTitle?: string) => {
    const title = (liveTitle ?? taskTitle).trim();
    if (!title || submitting || !props.onQuickCreate) return;
    setSubmitting(true);
    const created = await props.onQuickCreate(title, createDefaults(key));
    if (typeof created === "string" && props.settings.group === "custom" && key !== defaultCustomTaskGroupKey) props.onSettingsChange({ ...props.settings, customGroupAssignments: { ...props.settings.customGroupAssignments, [created]: key } });
    if (created) closeCreate();
    setSubmitting(false);
  };
  const dropTask = async (event: DragEvent<HTMLElement>, key: string) => {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("text/plain");
    const task = props.tasks.find((item) => item.id === taskId);
    if (!task) return;
    if (props.settings.group === "custom") {
      const assignments = { ...props.settings.customGroupAssignments };
      if (key === defaultCustomTaskGroupKey) delete assignments[task.id]; else assignments[task.id] = key;
      props.onSettingsChange({ ...props.settings, customGroupAssignments: assignments });
      return;
    }
    if ((props.settings.group === "start" || props.settings.group === "due") && props.onTimeChange) {
      const defaults = taskGroupCreateDefaults(props.settings.group, key);
      const field = props.settings.group === "start" ? "startAt" : "dueAt";
      await props.onTimeChange(task, field, defaults[field] ?? null);
    }
  };
  const draftTask = (groupKey: string): DenProductTask => ({ id: `board-draft-${groupKey}`, displayNumber: null, creatorMemberId: props.currentMemberId ?? "", listId: null, title: taskTitle, description: "", priority: "none", visibility: "private", completionPolicy: "any_assignee", status: "todo", version: 1, startAt: taskDraft.startAt ?? null, dueAt: taskDraft.dueAt ?? null, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return <div className="flex min-h-0 w-full flex-1 items-start gap-5 overflow-auto px-6 pb-6 pt-2" data-testid="assigned-task-board">{[...groups.entries()].map(([key, group]) => <section key={key} data-testid={`task-board-group-${key}`} onDragOver={(event) => { if (props.settings.group !== "creator") { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={(event) => void dropTask(event, key)} className="w-[300px] shrink-0" aria-label={group.label}>
    <header className="mb-2 flex h-9 items-center gap-2 px-1"><h3 className="min-w-0 truncate text-sm font-semibold text-dls-text">{group.label}</h3><span className="text-sm text-dls-secondary">{group.tasks.length}</span></header>
    <div className="space-y-2">{group.tasks.map((task) => {
      const taskMembers = props.membersByTaskId[task.id] ?? [];
      const assignees = taskMembers.filter((member) => member.role === "assignee").map((member) => member.memberId);
      const currentAssigneeCompleted = task.status === "todo" && task.completionPolicy === "all_assignees" && taskMembers.some((member) => member.role === "assignee" && member.memberId === props.currentMemberId && Boolean(member.completedAt));
      const overdue = task.status === "todo" && Boolean(task.dueAt && new Date(task.dueAt).getTime() < Date.now());
      return <article key={task.id} draggable={props.settings.group !== "creator"} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); }} data-testid={`task-board-card-${task.id}`} className="rounded-xl border border-dls-border bg-dls-surface p-3 shadow-sm"><div className="flex items-start gap-2"><button type="button" disabled={currentAssigneeCompleted} className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-dls-secondary text-white disabled:cursor-default" aria-label={currentAssigneeCompleted ? t("tasks.assignee_completed") : task.status === "todo" ? t("tasks.complete") : t("tasks.reopen")} onClick={() => { if (!currentAssigneeCompleted) props.onTransition(task, task.status === "todo" ? "complete" : "reopen"); }}>{task.status === "completed" || currentAssigneeCompleted ? <Check className="size-3 text-green-8" /> : task.status === "canceled" ? <RotateCcw className="size-2.5 text-dls-secondary" /> : null}</button><button type="button" className={`min-w-0 flex-1 text-left text-sm leading-5 text-dls-text hover:text-blue-10 ${task.status === "completed" ? "line-through opacity-60" : ""}`} onClick={() => props.onSelect(task.id)}>{task.title}</button></div>
        <div className="mt-3 flex items-center justify-between gap-2"><AvatarGroup>{assignees.slice(0, 3).map((id) => { const member = props.memberById.get(id); const name = taskMemberName(id, props.memberById); return <Avatar key={id} size="sm" title={name}><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>; })}{assignees.length > 3 ? <AvatarGroupCount>+{assignees.length - 3}</AvatarGroupCount> : null}</AvatarGroup>{task.dueAt ? <span className={`flex items-center gap-1 text-xs ${overdue ? "font-medium text-red-9" : "text-dls-secondary"}`}><Calendar className="size-3" />{new Date(task.dueAt).toLocaleDateString()}</span> : null}</div>
        <div className="mt-2 flex items-center gap-2"><span className="truncate text-xs text-dls-secondary">{task.listId ? props.listById.get(task.listId)?.name ?? task.listId : t("tasks.no_list")}</span></div>
      </article>;
    })}{!group.tasks.length && creatingTaskGroup !== key ? <div className="rounded-xl border border-dashed border-dls-border p-5 text-center text-xs text-dls-secondary">{t("tasks.empty_column")}</div> : null}{creatingTaskGroup === key ? <div data-testid={`task-board-create-card-${key}`} className="rounded-xl border border-blue-8 bg-dls-surface p-3 shadow-sm ring-2 ring-blue-8/15"><div className="flex items-start gap-2"><span className="mt-0.5 size-4 shrink-0 rounded-full border border-dls-secondary/60" /><input autoFocus data-testid={`task-board-create-title-${key}`} value={taskTitle} disabled={submitting || props.quickCreatePending} placeholder={t("tasks.inline_create_placeholder")} onChange={(event) => setTaskTitle(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitTask(key, event.currentTarget.value); } else if (event.key === "Escape") closeCreate(); }} className="min-w-0 flex-1 bg-transparent text-sm text-dls-text outline-none placeholder:text-dls-secondary" /></div><div className="mt-4 flex items-center"><TaskDateTimeCell task={draftTask(key)} field="dueAt" onChange={async (_task, field, value) => { setTaskDraft((current) => ({ ...current, [field]: value })); return true; }} /><span className="ml-1 text-xs text-dls-secondary">{taskDraft.dueAt ? new Date(taskDraft.dueAt).toLocaleString() : t("tasks.field_due")}</span></div></div> : <button type="button" data-testid={`task-board-create-trigger-${key}`} onClick={() => { setCreatingTaskGroup(key); setTaskDraft(taskGroupCreateDefaults(props.settings.group, key)); }} className="mt-2 flex h-9 items-center gap-2 px-2 text-sm text-dls-secondary hover:text-blue-10"><Plus className="size-4" />{t("tasks.new_task")}</button>}</div>
  </section>)}{props.settings.group === "custom" ? <section className="w-[300px] shrink-0" data-testid="task-board-new-group">{creatingGroup ? <input autoFocus data-testid="task-board-new-group-input" aria-label={t("tasks.group_name")} placeholder={t("tasks.group_title_placeholder")} value={groupDraft} maxLength={80} onChange={(event) => setGroupDraft(event.currentTarget.value)} onBlur={(event) => finishGroupCreate(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishGroupCreate(event.currentTarget.value); } else if (event.key === "Escape") { setCreatingGroup(false); setGroupDraft(""); } }} className="h-10 w-full rounded-lg border border-blue-8 bg-dls-surface px-3 text-sm text-dls-text outline-none ring-2 ring-blue-8/20" /> : <button type="button" data-testid="task-board-new-group-trigger" onClick={() => setCreatingGroup(true)} className="flex h-10 items-center gap-2 px-1 text-sm font-medium text-dls-secondary hover:text-blue-10"><Plus className="size-4" />{t("tasks.new_group")}</button>}</section> : null}</div>;
}

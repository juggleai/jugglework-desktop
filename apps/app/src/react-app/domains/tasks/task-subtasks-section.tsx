import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, GripVertical, ListTree, Plus, RotateCcw, X } from "lucide-react";

import type { DenOrganizationMember, DenProductTask, DenProductTaskMember, DenProductTaskPage, DenProductTaskResult, DenProductTaskSubtaskOrder } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { TaskDateTimeCell } from "./task-date-time-cell";
import { AssigneeCell, type SaveTaskTitle } from "./task-list-table";

export type TaskSubtaskCreateInput = { title: string; dueAt?: string | null; assigneeIds: string[]; idempotencyKey: string };

const subtaskMetadataClass = "flex min-w-0 shrink-0 items-center justify-end gap-2 text-xs text-dls-secondary";
const subtaskDeadlineClass = "flex h-8 min-w-8 max-w-40 items-center justify-end gap-1.5 whitespace-nowrap rounded-md px-1.5 tabular-nums enabled:hover:bg-dls-active focus-visible:outline-2 focus-visible:outline-blue-8 data-popup-open:bg-dls-active";
const subtaskHoverAction = "pointer-events-none opacity-0 group-hover/subtask:pointer-events-auto group-hover/subtask:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100";
const subtaskRowClass = "group/subtask flex min-h-10 items-center gap-2.5 rounded-xl py-1 pe-2 ps-8 hover:bg-dls-hover";
const subtaskArrowClass = "grid size-8 shrink-0 place-items-center rounded-md hover:bg-dls-active focus-visible:outline-2 focus-visible:outline-blue-8";

type TaskSubtasksSectionProps = {
  task: DenProductTask;
  members: DenOrganizationMember[];
  currentMemberId: string | null;
  canCreate: boolean;
  page: DenProductTaskPage | undefined;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onSelect: (taskId: string) => void;
  onCreate: (input: TaskSubtaskCreateInput) => Promise<boolean>;
  onTransition: (task: DenProductTask, op: "complete" | "reopen", anchor?: HTMLElement) => void;
  onReorder?: (task: DenProductTask, order: DenProductTaskSubtaskOrder) => Promise<boolean>;
  editing?: {
    load: (task: DenProductTask) => Promise<DenProductTaskResult | undefined>;
    title: SaveTaskTitle;
    completionPolicy?: React.ComponentProps<typeof AssigneeCell>["onCompletionPolicyChange"];
    due: (task: DenProductTask, dueAt: string | null) => Promise<boolean>;
    assignees: (task: DenProductTask, ids: string[], previousIds: string[]) => Promise<boolean>;
  };
};

export function TaskSubtasksSection({ task, members, currentMemberId, canCreate, page, loading, loadingMore, error, onRetry, onLoadMore, onSelect, onCreate, onTransition, onReorder, editing }: TaskSubtasksSectionProps) {
  useLocale();
  const headingId = useId();
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const total = task.subtaskCount;
  const supported = total !== undefined;
  const completed = task.completedSubtaskCount ?? 0;
  const canAdd = canCreate && !task.deletedAt;
  const [composerOpen, setComposerOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const composerId = `${headingId}-composer`;
  const closeComposer = (restoreFocus: boolean) => { setComposerOpen(false); if (restoreFocus) addButton.current?.focus(); };
  // The page comes from the direct-children endpoint. A parent summary is optional.
  const children = page?.items.filter((child) => !child.deletedAt && child.id !== task.id && (!child.parentTask || child.parentTask.id === task.id)) ?? [];
  const canReorder = canAdd && task.subtaskOrderSupported === true && !!onReorder && children.length > 1;
  const source = useRef<string | null>(null);
  const savingOrder = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DenProductTaskSubtaskOrder | null>(null);
  const [ordering, setOrdering] = useState(false);
  const [orderFailed, setOrderFailed] = useState(false);
  const endDrag = () => { source.current = null; setDraggedId(null); setDropAt(null); };
  const reorder = async (movedId: string, order: DenProductTaskSubtaskOrder) => {
    endDrag();
    if (!canReorder || !onReorder || loading || loadingMore || savingOrder.current || movedId === order.anchorTaskId) return;
    const from = children.findIndex((child) => child.id === movedId);
    const anchor = children.findIndex((child) => child.id === order.anchorTaskId);
    if (from < 0 || anchor < 0 || (order.placement === "before" ? from === anchor - 1 : from === anchor + 1)) return;
    savingOrder.current = true;
    setOrdering(true);
    setOrderFailed(false);
    try { setOrderFailed(!await onReorder(children[from]!, order)); }
    catch { setOrderFailed(true); }
    finally { savingOrder.current = false; setOrdering(false); }
  };

  return <section aria-labelledby={headingId} data-testid="task-subtasks-section" className="space-y-2 border-y border-dls-border py-3">
    <div className="flex min-h-6 items-center gap-4">
      <ListTree aria-hidden="true" className="size-4 text-dls-secondary" />
      <h3 id={headingId} className={total ? "sr-only" : "text-sm font-semibold text-dls-text"}>{t("tasks.subtasks")}</h3>
      {total ? <>
        <span aria-hidden="true" className="text-sm tabular-nums text-dls-secondary" data-testid="task-subtasks-progress">{completed} / {total}</span>
        <div role="progressbar" aria-label={t("tasks.subtasks_progress", { completed, total })} aria-valuenow={completed} aria-valuemax={total} data-testid="task-subtasks-progress-bar" className="h-2.5 w-14 overflow-hidden rounded-full bg-gray-6">
          {completed > 0 ? <div className={`h-full rounded-full ${completed >= total ? "bg-green-9" : "bg-blue-9"}`} style={{ width: `${Math.min(completed / total, 1) * 100}%` }} /> : null}
        </div>
      </> : null}
    </div>

    {children.length > 0 ? <ul aria-busy={ordering} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropAt(null); }}>{children.map((child, index) => <TaskSubtaskRow key={child.id} child={child}
      projectedMembers={page?.memberProjectionKnownByTaskId?.[child.id] === false ? undefined : page?.membersByTaskId?.[child.id]}
      members={memberById} currentMemberId={currentMemberId} onSelect={onSelect} onTransition={onTransition} editing={editing}
      sorting={canReorder ? {
        disabled: ordering || loading || loadingMore,
        dragged: draggedId === child.id,
        marker: dropAt?.anchorTaskId === child.id ? dropAt.placement : undefined,
        start: () => { source.current = child.id; setDraggedId(child.id); },
        end: endDrag,
        over: (placement) => { if (!source.current || savingOrder.current) return false; setDropAt(source.current === child.id ? null : { anchorTaskId: child.id, placement }); return true; },
        drop: (placement) => { const moved = source.current; if (!moved) return false; void reorder(moved, { anchorTaskId: child.id, placement }); return true; },
        step: (offset) => { const anchor = children[index + offset]; if (anchor) void reorder(child.id, { anchorTaskId: anchor.id, placement: offset < 0 ? "before" : "after" }); },
      } : undefined} />)}</ul> : null}
    {orderFailed ? <p role="alert" className="ps-8 text-xs text-red-9">{t("tasks.subtask_order_error")}</p> : null}

    {loading || loadingMore ? <p role="status" className="text-xs text-dls-secondary">{t("tasks.loading")}</p> : null}
    {error && !loading && !loadingMore ? <div className="flex flex-wrap items-center gap-2 text-sm">
      <span role="alert" className="text-red-9">{t("tasks.subtasks_load_error")}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onRetry}>{t("tasks.retry")}</Button>
    </div> : null}
    {page?.nextCursor && !error ? <Button type="button" variant="ghost" size="sm" disabled={loading || loadingMore || ordering} onClick={onLoadMore}>{t("tasks.load_more_subtasks")}</Button> : null}
    {!canAdd && !loading && !loadingMore && !error && !page?.nextCursor && !children.length && (page || total === 0) ? <p className="ps-8 text-sm text-dls-secondary">{t("tasks.no_visible_subtasks")}</p> : null}

    {canAdd && supported && composerOpen ? <TaskSubtaskComposer id={composerId} titleInput={titleInput} taskId={task.id} members={memberById} onCreate={onCreate} onClose={closeComposer} /> : null}
    {canAdd ? <Button ref={addButton} type="button" variant="ghost" size="sm" data-testid="task-add-subtask" data-task-draft-owner={composerId} className="ms-6 gap-1.5 text-dls-secondary hover:text-blue-10" disabled={!supported} aria-expanded={supported ? composerOpen : undefined} aria-controls={composerOpen ? composerId : undefined} aria-describedby={!supported ? `${headingId}-unsupported` : undefined} onClick={() => { if (composerOpen) titleInput.current?.focus(); else setComposerOpen(true); }}><Plus aria-hidden="true" className="size-4" />{t("tasks.add_subtask")}</Button> : null}
    {!supported && canAdd ? <p id={`${headingId}-unsupported`} className="ps-8 text-xs text-dls-secondary">{t("tasks.subtasks_server_unsupported")}</p> : null}
  </section>;
}

function SubtaskDeadline({ task, draftOwner, onChange }: { task: DenProductTask; draftOwner?: string; onChange?: (value: string | null) => Promise<boolean> }) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const save = async (value: string | null) => {
    if (!onChange || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    try { return await onChange(value); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <div data-testid={`task-subtask-deadline-${task.id}`} className={`group/deadline relative min-w-8 ${task.dueAt ? "" : subtaskHoverAction}`}>
    {(task.dueAt || onChange) ? <TaskDateTimeCell task={task} field="dueAt" dueOnly compactDeadline draftOwner={draftOwner} triggerClassName={subtaskDeadlineClass} onChange={onChange ? (_task, _field, value) => save(value) : undefined} /> : null}
    {task.dueAt && onChange ? <button type="button" data-testid={`task-subtask-clear-due-${task.id}`} aria-label={t("tasks.clear_subtask_deadline")} title={t("tasks.clear_subtask_deadline")} disabled={pending} onClick={() => void save(null)} className="pointer-events-none absolute inset-y-0 end-0 my-auto grid size-7 place-items-center rounded-md bg-dls-hover opacity-0 group-hover/deadline:pointer-events-auto group-hover/deadline:opacity-100 hover:bg-dls-active focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-8 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"><X aria-hidden="true" className="size-4" /></button> : null}
  </div>;
}

type Placement = DenProductTaskSubtaskOrder["placement"];

function TaskSubtaskRow({ child, projectedMembers, members, currentMemberId, onSelect, onTransition, editing, sorting }: {
  child: DenProductTask;
  projectedMembers?: DenProductTaskMember[];
  members: Map<string, DenOrganizationMember>;
  currentMemberId: string | null;
  onSelect: TaskSubtasksSectionProps["onSelect"];
  onTransition: TaskSubtasksSectionProps["onTransition"];
  editing: TaskSubtasksSectionProps["editing"];
  sorting?: { disabled: boolean; dragged: boolean; marker?: Placement; start: () => void; end: () => void; over: (placement: Placement) => boolean; drop: (placement: Placement) => boolean; step: (offset: -1 | 1) => void };
}) {
  const [detail, setDetail] = useState<DenProductTaskResult>();
  const lookup = useRef<Promise<DenProductTaskResult | undefined> | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const previousTitle = useRef("");
  const wantsTitleEdit = useRef(false);
  const composing = useRef(false);
  const saveRequest = useRef<Promise<boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<"failed" | "conflict" | null>(null);
  const load = () => {
    if (!editing) return Promise.resolve(undefined);
    if (detail && detail.task.version >= child.version) return Promise.resolve(detail);
    return lookup.current ??= editing.load(child).then((loaded) => {
      if (loaded?.task.id === child.id) { setDetail(loaded); return loaded; }
      return undefined;
    }).catch(() => undefined).finally(() => { lookup.current = null; });
  };
  const beginEdit = async () => {
    if (!editing || wantsTitleEdit.current) return;
    wantsTitleEdit.current = true;
    try {
      const loaded = await load();
      if (loaded?.permissions.canEditContent && !loaded.tombstone) {
        previousTitle.current = loaded.task.title;
        setTitle(loaded.task.title);
        setFailure(null);
      }
    } finally { wantsTitleEdit.current = false; }
  };
  const commitTitle = (value: string): Promise<boolean> => {
    if (saveRequest.current) return saveRequest.current;
    if (composing.current || !editing) return Promise.resolve(false);
    const next = value.trim();
    const previous = previousTitle.current;
    if (!next || next === previous) { setTitle(null); setFailure(null); return Promise.resolve(true); }
    setFailure(null);
    setSaving(true);
    return saveRequest.current = editing.title(child, previous, next).then((status) => {
      if (status === "saved") { setTitle(null); return true; }
      setFailure(status);
      return false;
    }).catch(() => { setFailure("failed"); return false; }).finally(() => { saveRequest.current = null; setSaving(false); });
  };
  const rowTask = detail && detail.task.version > child.version ? detail.task : child;
  const permissions = !detail?.tombstone ? detail?.permissions : undefined;
  const canAssign = permissions?.canAssign ?? permissions?.canManageMembers;
  const assignees = (detail && detail.task.version >= child.version && !detail.tombstone ? detail.members : projectedMembers)?.filter((member) => member.role === "assignee") ?? [];
  const ids = assignees.map((member) => member.memberId);
  const completedIds = new Set(assignees.filter((member) => member.completedAt).map((member) => member.memberId));
  const ownComplete = !rowTask.assigneeCompletionActionsSupported && rowTask.status === "todo" && currentMemberId !== null && completedIds.has(currentMemberId);
  const completed = rowTask.status === "completed";
  const operation = rowTask.status === "todo" ? "complete" : "reopen";
  const operationLabel = t(ownComplete ? "tasks.assignee_completed" : operation === "reopen" ? "tasks.reopen" : rowTask.completionPolicy === "all_assignees" ? "tasks.complete_my_part" : "tasks.complete");
  const openDetail = async () => {
    if (title !== null && !await commitTitle(title)) return;
    onSelect(child.id);
  };

  const dropPlacement = (event: React.DragEvent<HTMLLIElement>): Placement => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };
  return <li data-testid={`task-subtask-row-${child.id}`} onPointerEnter={() => void load()} onFocus={() => void load()}
    onDragOver={sorting && !sorting.disabled ? (event) => { if (sorting.over(dropPlacement(event))) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } } : undefined}
    onDrop={sorting && !sorting.disabled ? (event) => { if (sorting.drop(dropPlacement(event))) event.preventDefault(); } : undefined}>
    <div data-drop-placement={sorting?.marker} className={`${subtaskRowClass} relative ${sorting?.dragged ? "opacity-50" : ""} ${sorting?.marker ? "after:pointer-events-none after:absolute after:inset-x-2 after:h-0.5 after:rounded-full after:bg-blue-9 data-[drop-placement=before]:after:top-0 data-[drop-placement=after]:after:bottom-0" : ""}`}>
      {sorting ? <button type="button" draggable={!sorting.disabled} aria-disabled={sorting.disabled} data-testid={`task-subtask-reorder-${child.id}`} aria-label={t("tasks.reorder_subtask", { title: rowTask.title })} title={t("tasks.reorder_field_hint")}
        className="pointer-events-none absolute start-0 grid size-7 cursor-grab place-items-center rounded-md text-dls-secondary/60 opacity-0 group-hover/subtask:pointer-events-auto group-hover/subtask:opacity-100 hover:bg-dls-active hover:text-dls-secondary focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-8 active:cursor-grabbing aria-disabled:cursor-default"
        onDragStart={(event) => { if (sorting.disabled) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", child.id); sorting.start(); }}
        onDragEnd={sorting.end} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); if (!sorting.disabled && !event.repeat) sorting.step(event.key === "ArrowUp" ? -1 : 1); } }}>
        <GripVertical aria-hidden="true" className="size-4" />
      </button> : null}
      <button type="button" data-testid={`task-subtask-transition-${child.id}`} disabled={ownComplete} aria-label={operationLabel} aria-description={rowTask.title} title={ownComplete ? t("tasks.waiting_for_assignees") : operationLabel} onClick={(event) => onTransition(rowTask, operation, event?.currentTarget)} className={`grid size-[18px] shrink-0 place-items-center rounded-full border text-dls-secondary focus-visible:outline-2 focus-visible:outline-blue-8 ${completed ? "border-green-8 bg-green-8 text-white" : ownComplete ? "border-blue-8 bg-blue-8 text-white" : "border-dls-secondary hover:border-blue-8 hover:bg-dls-hover"}`}>
        {completed || ownComplete ? <Check aria-hidden="true" className="size-3" /> : rowTask.status === "canceled" ? <RotateCcw aria-hidden="true" className="size-2.5" /> : null}
      </button>
      {title !== null ? <input autoFocus aria-label={t("tasks.field_title")} data-testid={`task-subtask-title-input-${child.id}`} value={title} readOnly={saving} className="h-8 min-w-0 flex-1 rounded bg-transparent text-sm text-dls-text outline-none focus-visible:ring-1 focus-visible:ring-blue-8"
        onChange={(event) => { setTitle(event.currentTarget.value); setFailure(null); }}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onBlur={(event) => void commitTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) void commitTitle(event.currentTarget.value); }
          else if (event.key === "Escape" && !saveRequest.current) { event.preventDefault(); event.stopPropagation(); setTitle(null); setFailure(null); }
        }} /> : editing && permissions?.canEditContent !== false && !detail?.tombstone ? <button type="button" data-testid={`task-subtask-edit-title-${child.id}`} title={rowTask.title} onClick={() => void beginEdit()} className={`min-w-0 flex-1 truncate rounded text-start text-sm text-dls-text focus-visible:outline-2 focus-visible:outline-blue-8 ${completed ? "line-through opacity-60" : ""}`}>{rowTask.title}</button> : <span className={`min-w-0 flex-1 truncate text-sm text-dls-text ${completed ? "line-through opacity-60" : ""}`} title={rowTask.title}>{rowTask.title}</span>}
      <div className={subtaskMetadataClass}>
        <SubtaskDeadline task={rowTask} onChange={editing && permissions?.canEditTime ? (value) => editing.due(rowTask, value) : undefined} />
        <div className={`flex min-w-8 justify-center ${ids.length ? "" : subtaskHoverAction}`}>
          {ids.length || canAssign ? <AssigneeCell task={rowTask} ids={ids} completedIds={completedIds} members={members} avatarOnly onCompletionPolicyChange={canAssign && permissions?.canManageMembers ? editing?.completionPolicy : undefined} onChange={editing && canAssign ? (_task, next) => editing.assignees(rowTask, next, ids) : undefined} /> : null}
        </div>
        <button type="button" data-testid={`task-subtask-open-${child.id}`} aria-label={t("tasks.open_subtask", { title: rowTask.title })} onClick={() => void openDetail()} className={`${subtaskArrowClass} ${subtaskHoverAction}`}><ChevronRight aria-hidden="true" className="size-4 rtl:rotate-180" /></button>
      </div>
    </div>
    {failure ? <p role="alert" className="mt-1 ps-8 text-xs text-red-9">{t(failure === "conflict" ? "tasks.subtask_title_conflict" : "tasks.subtask_title_save_error")}</p> : null}
  </li>;
}

type SubtaskDraft = { title: string; dueAt: string | null; assigneeIds: string[] };
export type StagedSubtask = SubtaskDraft & { id: string };

export function TaskCreateSubtasks({ items, onChange, members }: {
  items: StagedSubtask[];
  onChange: React.Dispatch<React.SetStateAction<StagedSubtask[]>>;
  members: DenOrganizationMember[];
}) {
  const [editing, setEditing] = useState<{ id: string; original?: StagedSubtask } | null>(null);
  const memberById = useMemo(() => new Map(members.map(member => [member.id, member])), [members]);
  const addButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const composerId = useId();
  const nextDraftId = useRef(0);
  const edit = (item: StagedSubtask) => setEditing({ id: item.id, original: item });
  const add = () => {
    const empty = items.find(item => !item.title.trim());
    if (empty) { setEditing({ id: empty.id }); titleInput.current?.focus(); return; }
    const item = { id: `draft-${++nextDraftId.current}`, title: "", dueAt: null, assigneeIds: [] };
    onChange(current => [...current, item]);
    setEditing({ id: item.id });
  };
  return <section aria-label={t("tasks.subtasks")} className="space-y-1">
    {items.map(item => {
      if (editing?.id === item.id) return <TaskSubtaskComposer key={item.id} id={composerId} taskId={item.id} members={memberById} titleInput={titleInput}
        draft={item} onDraftChange={value => onChange(current => current.map(row => row.id === item.id ? { ...row, ...value } : row))}
        onCancel={() => {
          const original = editing.original;
          onChange(current => original ? current.map(row => row.id === item.id ? original : row) : current.filter(row => row.id !== item.id));
        }}
        onClose={restoreFocus => { setEditing(current => current?.id === item.id ? null : current); if (restoreFocus) addButton.current?.focus(); }} />;
      const task = subtaskDraftTask(item.id, item);
      return <div key={item.id} className={subtaskRowClass}>
        <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border border-dls-secondary" />
        <button type="button" onClick={() => edit(item)} className="min-w-0 flex-1 truncate text-start text-sm text-dls-text">{item.title}</button>
        <div className={subtaskMetadataClass}>
          <SubtaskDeadline task={task} onChange={async dueAt => { onChange(current => current.map(row => row.id === item.id ? { ...row, dueAt } : row)); return true; }} />
          <div className={item.assigneeIds.length ? "" : subtaskHoverAction}><AssigneeCell task={task} ids={item.assigneeIds} members={memberById} avatarOnly onChange={async (_task, assigneeIds) => {
            onChange(current => current.map(row => row.id === item.id ? { ...row, assigneeIds } : row)); return true;
          }} /></div>
          <button type="button" aria-label={`${t("common.remove")} · ${item.title}`} className={`${subtaskArrowClass} ${subtaskHoverAction}`} onClick={() => onChange(current => current.filter(row => row.id !== item.id))}><X className="size-4" /></button>
        </div>
      </div>;
    })}
    <button ref={addButton} type="button" data-testid="task-add-subtask" onClick={add} className="inline-flex min-h-8 items-center gap-3 rounded text-sm text-dls-secondary hover:text-blue-10"><ListTree aria-hidden="true" className="size-4" />{t("tasks.add_subtask")}</button>
  </section>;
}

function subtaskDraftTask(id: string, { title, dueAt }: SubtaskDraft): DenProductTask {
  return {
    id: `subtask-draft-${id}`, displayNumber: null, creatorMemberId: "", listId: null, title, description: "",
    priority: "none", visibility: "private", completionPolicy: "any_assignee", status: "todo", version: 0,
    startAt: null, dueAt, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null,
    deletedAt: null, restoreUntil: null, createdAt: "", updatedAt: "",
  };
}

function TaskSubtaskComposer({ id, titleInput, taskId, members, onCreate, onClose, draft, onDraftChange, onCancel }: {
  id: string; titleInput: React.Ref<HTMLInputElement>; taskId: string; members: Map<string, DenOrganizationMember>;
  onCreate?: TaskSubtasksSectionProps["onCreate"]; onClose: (restoreFocus: boolean) => void;
  draft?: SubtaskDraft; onDraftChange?: (value: SubtaskDraft) => void; onCancel?: () => void;
}) {
  const composing = useRef(false);
  const submitting = useRef(false);
  const lastAttempt = useRef<{ payload: string; key: string } | null>(null);
  const [localDraft, setLocalDraft] = useState<SubtaskDraft>({ title: "", dueAt: null, assigneeIds: [] });
  const value = draft ?? localDraft;
  const { title, dueAt, assigneeIds } = value;
  const change = (patch: Partial<SubtaskDraft>) => (onDraftChange ?? setLocalDraft)({ ...value, ...patch });
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const draftTask = subtaskDraftTask(taskId, value);

  const submit = async (value: string, restoreFocus: boolean) => {
    const trimmed = value.trim();
    if (submitting.current || composing.current) return;
    if (!onCreate) {
      if (!trimmed) onCancel?.();
      onClose(restoreFocus);
      return;
    }
    if (!trimmed) return;
    const submittedAssigneeIds = [...assigneeIds].sort();
    const payload = JSON.stringify([trimmed, dueAt, submittedAssigneeIds]);
    // A failed request may already have created the child. Retry the same payload with the same key.
    if (lastAttempt.current?.payload !== payload) {
      const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      lastAttempt.current = { payload, key: `desktop-create-subtask-${suffix}` };
    }
    submitting.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (await onCreate({ title: trimmed, dueAt, assigneeIds: submittedAssigneeIds, idempotencyKey: lastAttempt.current.key })) onClose(restoreFocus);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  // Picker popups are portaled; mark them as part of the draft along with the row.
  const onOutsideClick = useEffectEvent((event: MouseEvent) => {
    if (event.button !== 0 || event.composedPath().some((target) => target instanceof Element && target.getAttribute("data-task-draft-owner") === id)) return;
    void submit(title, false);
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleClick = (event: MouseEvent) => onOutsideClick(event);
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, []);

  return <div id={id} data-testid="task-subtask-composer" data-task-draft-owner={id}>
    <div className={`${subtaskRowClass} bg-dls-hover focus-within:ring-1 focus-within:ring-dls-border`}>
      <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full border border-dls-secondary bg-background" />
      <input
        ref={titleInput}
        autoFocus
        data-testid="task-subtask-title"
        aria-label={t("tasks.field_title")}
        placeholder={t("tasks.subtask_title_placeholder")}
        value={title}
        className="h-8 min-w-0 flex-1 bg-transparent text-sm text-dls-text outline-none placeholder:text-dls-secondary/80 disabled:opacity-60"
        disabled={pending}
        onChange={(event) => { change({ title: event.currentTarget.value }); setFailed(false); }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (!event.repeat) void submit(event.currentTarget.value, true);
          } else if (event.key === "Escape" && !submitting.current) {
            event.preventDefault();
            event.stopPropagation();
            onCancel?.();
            onClose(true);
          }
        }}
      />
      <div className={subtaskMetadataClass}>
        <SubtaskDeadline task={draftTask} draftOwner={id} onChange={pending ? undefined : async (value) => {
          if (submitting.current) return false;
          change({ dueAt: value });
          setFailed(false);
          return true;
        }} />
        <div className={`flex min-w-8 justify-center ${assigneeIds.length ? "" : subtaskHoverAction}`}><AssigneeCell task={draftTask} ids={assigneeIds} members={members} avatarOnly draftOwner={id} onChange={pending ? undefined : async (_task, ids) => {
          if (submitting.current) return false;
          change({ assigneeIds: ids });
          setFailed(false);
          return true;
        }} /></div>
        <span aria-hidden="true" className="w-8" />
      </div>
    </div>
    {pending ? <p role="status" className="mt-1 ps-8 text-xs text-dls-secondary">{t("common.loading")}</p> : null}
    {failed ? <p role="alert" className="mt-1 ps-8 text-xs text-red-9">{t("tasks.subtask_create_error")}</p> : null}
  </div>;
}

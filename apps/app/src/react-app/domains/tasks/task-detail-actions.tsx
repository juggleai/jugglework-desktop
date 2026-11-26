import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, CircleArrowLeft, CircleArrowRight, RefreshCw, GitBranch, History, Diamond, MoreHorizontal, Trash2, Unlink, type LucideIcon } from "lucide-react";

import { DenApiError, type DenClient, type DenProductTaskResult, type DenRelatedTask, type DenTaskRelationCommand, type DenTaskRelations } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { TaskParentPicker } from "./task-parent-picker";
import { flattenProductTaskPages, productTaskKeys, removeDeletedTaskFromCache, useProductTaskHistory, useProductTasks, type ProductTaskScope } from "./task-queries";

type Connection = { client: DenClient; scope: ProductTaskScope };
type Picker = "set-parent" | "add-predecessor" | "add-successor";
type Direction = "predecessors" | "successors";
type Panel = Picker | Direction | "delete";
const pickerLabels = { "set-parent": "tasks.set_parent", "add-predecessor": "tasks.add_predecessor", "add-successor": "tasks.add_successor" } as const;
const badgeLabel = (direction: Direction, count: number) => t(direction === "predecessors" ? "tasks.predecessors_count" : "tasks.successors_count", { count });
const headerBadge = "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-xs font-medium";
export function TaskMilestoneBadge() {
  return <span className={`${headerBadge} bg-[#fddbd8] text-[#bd302b] dark:bg-red-4 dark:text-red-11`}><Diamond aria-hidden="true" className="size-3.5 fill-current" />{t("tasks.milestone")}</span>;
}
function DependencyGlyph({ incoming }: { incoming: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`size-3.5 ${incoming ? "rotate-180" : ""}`}><circle cx="3.5" cy="8" r="2.5" /><path d="M6 8h8m-3.5-3.5L14 8l-3.5 3.5" /></svg>;
}
const statusLabel = (status: DenRelatedTask["status"]) => t(status === "todo" ? "tasks.status_incomplete" : status === "completed" ? "tasks.completed" : "tasks.board_canceled");
const missing = (error: unknown) => error instanceof DenApiError && error.status === 404;
function writeError(error: unknown, action?: Change["action"]) {
  if (error instanceof DenApiError) {
    if (error.status === 403) return t("tasks.transition_not_allowed");
    if (error.status === 409 && error.code === "task_version_conflict") return t("tasks.action_conflict");
    if (error.status === 404) return t(action === "delete" ? "tasks.activity_unavailable_task" : "tasks.relations_unavailable");
    // Keep the server's reason for rejected cycles, duplicate links, etc.
    if (error.status >= 400 && error.status < 500 && error.message) return error.message;
  }
  return t("tasks.action_failed");
}

function TaskPicker({ client, scope, taskId, relations, pending, onSelect }: Connection & {
  taskId: string; relations: DenTaskRelations; pending: boolean; onSelect: (id: string) => void;
}) {
  const [search, setSearch] = React.useState("");
  const query = useProductTasks({ client, scope, options: { view: "all", search: search.trim() || undefined } });
  // The workbench intentionally keeps its previous page while searching. Such
  // rows must never be selectable as answers to a different picker query.
  const tasks = flattenProductTaskPages(query.isPlaceholderData || query.isError ? undefined : query.data);
  const excluded = new Set([...relations.predecessors, ...relations.successors].map(({ id }) => id));
  const choices = tasks.filter(task => task.id !== taskId && !task.deletedAt && !excluded.has(task.id));
  return <>
    <Input autoFocus aria-label={t("tasks.search")} placeholder={t("tasks.search")} value={search} disabled={pending} onChange={e => setSearch(e.target.value)} />
    <div className="max-h-64 overflow-y-auto" aria-busy={query.isFetching}>
      {query.isError ? <p role="alert">{t("tasks.error_title")} <Button variant="ghost" onClick={() => void query.refetch()}>{t("common.retry")}</Button></p>
        : query.isLoading || query.isPlaceholderData ? <p role="status">{t("tasks.loading")}</p>
        : !choices.length && <p role="status">{t("tasks.no_matching_tasks")}</p>}
      {choices.map(task => <button key={task.id} type="button" disabled={pending} onClick={() => onSelect(task.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start hover:bg-dls-hover focus-visible:outline-blue-8">
        <span className="truncate">{task.title}</span><small className="shrink-0 text-dls-secondary">{statusLabel(task.status)}</small>
      </button>)}
      {query.hasNextPage && !query.isPlaceholderData && !query.isError && <Button variant="ghost" disabled={pending || query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>{t("tasks.load_more")}</Button>}
    </div>
  </>;
}

export function TaskHistory({ client, scope, taskId, getActor, onBack }: Connection & {
  taskId: string; getActor: (id: string) => { name: string; avatar?: string } | undefined; onBack: () => void;
}) {
  const history = useProductTaskHistory({ client, scope, taskId });
  const back = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { back.current?.focus(); }, []);
  const events = history.isError ? [] : history.data?.pages.flatMap(page => page.items) ?? [];
  const groups = new Map<string, typeof events>();
  for (const event of events) {
    const key = new Date(event.createdAt).toDateString();
    const day = groups.get(key);
    if (day) day.push(event);
    else groups.set(key, [event]);
  }
  const locale = currentLocale();
  const today = new Date().toDateString();
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return <section data-testid="task-history-page" aria-label={t("tasks.history_title")} className="flex min-h-0 flex-1 flex-col bg-background">
    <header className="grid min-h-16 shrink-0 grid-cols-[2.25rem_1fr_2.25rem] items-center px-4">
      <Button ref={back} type="button" variant="ghost" size="icon" aria-label={t("common.back")} onClick={onBack}><ChevronLeft aria-hidden="true" className="size-5" /></Button>
      <h2 className="text-center text-base font-semibold text-dls-text">{t("tasks.history_title")}</h2>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-2 sm:px-5">
      {history.isError ? <p role="alert" className="text-sm text-dls-secondary">{missing(history.error) ? t("tasks.activity_unavailable_task") : t("tasks.activity_error_title")} <Button variant="ghost" onClick={() => void history.refetch()}>{t("common.retry")}</Button></p>
        : !history.data ? <p role="status" className="text-sm text-dls-secondary">{t("tasks.activity_loading")}</p>
        : !events.length ? <p className="text-sm text-dls-secondary">{t("tasks.activity_empty_title")}</p>
        : [...groups].map(([key, rows]) => {
          const date = new Date(rows[0]!.createdAt);
          return <div key={key} data-testid="task-history-day" className="mb-5 grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-3">
            <h3 title={date.toLocaleDateString(locale)} className="flex flex-col text-dls-secondary"><span className="text-sm">{key === today ? t("tasks.activity_today") : date.toLocaleDateString(locale, { weekday: "short" })}</span><span className="text-3xl font-semibold leading-tight tabular-nums text-dls-text">{date.getDate()}</span></h3>
            <ol aria-label={date.toLocaleDateString(locale)} className="mt-2 border-t border-dls-border pt-2">
              {rows.map(event => {
                const actor = event.actorMemberId ? getActor(event.actorMemberId) : undefined;
                return <li key={event.id} className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-2 hover:bg-dls-hover sm:gap-4 sm:px-3">
                  <time dateTime={event.createdAt} className="w-10 shrink-0 text-right text-xs tabular-nums text-dls-secondary">{key === "Invalid Date" ? "—" : timeFormat.format(new Date(event.createdAt))}</time>
                  <Avatar size="sm" aria-hidden="true"><AvatarImage src={actor?.avatar} /><AvatarFallback>{actor?.name.slice(0, 1) || "?"}</AvatarFallback></Avatar>
                  <span data-testid="task-history-event-text" className="min-w-0 break-words text-sm text-dls-text">{historyTitle(event.eventType, actor?.name ?? t("tasks.history_unknown_actor"))}</span>
                </li>;
              })}
            </ol>
          </div>;
        })}
      {!history.isError && history.hasNextPage && <Button variant="ghost" disabled={history.isFetching} onClick={() => void history.fetchNextPage({ cancelRefetch: false })}>{t("tasks.history_load_older")}</Button>}
    </div>
  </section>;
}

function historyTitle(type: string, actor: string) {
  // History events are not personalized notifications. Preserve unknown event
  // types, and do not infer a recipient or expose the event payload.
  const labels = {
    "task.created": "tasks.history_created", "task.updated": "tasks.activity_updated", "task.completed": "tasks.activity_completed",
    "task.canceled": "tasks.activity_canceled", "task.reopened": "tasks.activity_reopened", "task.due_changed": "tasks.activity_due_changed",
    "comment.created": "tasks.activity_commented", "task.list_moved": "tasks.activity_list_moved", "task.assignee_added": "tasks.activity_assignee_added",
    "task.follower_added": "tasks.activity_follower_added",
    created: "tasks.history_created", updated: "tasks.activity_updated", completed: "tasks.activity_completed", canceled: "tasks.activity_canceled", reopened: "tasks.activity_reopened",
    assignee_added: "tasks.activity_assignee_added", follower_added: "tasks.activity_follower_added", comment_added: "tasks.activity_commented",
    title_changed: "tasks.history_title_changed", description_changed: "tasks.history_description_changed", priority_changed: "tasks.history_priority_changed",
    visibility_changed: "tasks.history_visibility_changed", time_changed: "tasks.history_time_changed", members_changed: "tasks.history_members_changed",
    list_changed: "tasks.history_list_changed", creator_changed: "tasks.history_creator_changed", viewer_added: "tasks.history_viewer_added",
    assignee_removed: "tasks.history_assignee_removed", follower_removed: "tasks.history_follower_removed", viewer_removed: "tasks.history_viewer_removed",
    comment_deleted: "tasks.history_comment_deleted", reminder_changed: "tasks.history_reminder_changed", reminder_due: "tasks.history_reminder_due",
    assignee_completed: "tasks.history_assignee_completed", deleted: "tasks.history_deleted", restored: "tasks.history_restored",
    "set-parent": "tasks.history_set_parent", "detach-parent": "tasks.history_detach_parent", "child-added": "tasks.history_child_added", "child-removed": "tasks.history_child_removed",
    "set-milestone": "tasks.history_set_milestone", "unset-milestone": "tasks.history_unset_milestone", "add-predecessor": "tasks.history_add_predecessor", "remove-predecessor": "tasks.history_remove_predecessor",
    "add-successor": "tasks.history_add_successor", "remove-successor": "tasks.history_remove_successor",
  } as const;
  return Object.hasOwn(labels, type) ? t(labels[type as keyof typeof labels], { actor }) : `${actor} · ${type}`;
}

type Change = DenTaskRelationCommand | { action: "delete"; relatedTaskId?: never };

/** Mounted only for a visible, live detail; its parent keys it by scope + task. */
export function TaskDetailActions({ client, scope, result, completion, following, onSelect, onDeleted, onViewHistory }: Connection & {
  result: DenProductTaskResult; completion: React.ReactNode; following: React.ReactNode;
  onSelect: (id: string) => void; onDeleted: () => void; onViewHistory: (trigger: HTMLButtonElement | null) => void;
}) {
  const { task, permissions } = result;
  const cache = useQueryClient();
  const key = productTaskKeys.relations(scope, task.id);
  const relations = useQuery({ queryKey: key, queryFn: ({ signal }) => client.getProductTaskRelations(scope.organizationId, task.id, { signal }), retry: false });
  const data = relations.isError ? undefined : relations.data;
  const [panel, setPanel] = React.useState<Panel | null>(null);
  const mounted = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lock = React.useRef(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const opener = React.useRef<HTMLButtonElement | null>(null);
  const write = useMutation({ retry: false,
    onMutate: () => ({ previousParent: data?.parentTaskId }),
    mutationFn: async (change: Change) => {
      const cas = { expectedVersion: task.version, idempotencyKey: crypto.randomUUID() };
      if (change.action === "delete") {
        await client.deleteProductTask(scope.organizationId, task.id, cas);
      } else {
        const updated = await client.changeProductTaskRelation(scope.organizationId, task.id, { ...change, ...cas });
        await cache.cancelQueries({ queryKey: key, exact: true });
        cache.setQueryData(key, updated);
      }
    },
    onSuccess: (_, change) => {
      if (change.action === "delete") {
        onDeleted(); // The page checks the live selection before closing.
      } else if (mounted.current && !change.action.startsWith("remove-")) setPanel(null);
    },
    onError: (error, change) => { if (mounted.current && !panel) toast.error(writeError(error, change.action)); },
    onSettled: async (_, error, change, captured) => {
      try {
        if (change.action === "delete" && !error) {
          await removeDeletedTaskFromCache(cache, scope, task.id);
          return;
        }
        // Refresh permissions/versions even after conflicts or ambiguous failures.
        const ids = new Set([task.id, change.relatedTaskId, captured?.previousParent]);
        await Promise.all([
          cache.invalidateQueries({ queryKey: productTaskKeys.lists(scope) }),
          cache.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(scope) }),
          ...[...ids].filter((id): id is string => !!id).map(id => cache.invalidateQueries({ queryKey: productTaskKeys.detail(scope, id) })),
        ]);
      } finally { lock.current = false; }
    },
  });
  const pending = write.isPending;
  const editable = !!data && permissions.canEditContent && !pending;
  const submit = (change: Change) => {
    if (lock.current || (change.action === "delete" ? !permissions.canDelete : !editable)) return;
    lock.current = true;
    write.mutate(change);
  };
  const open = (next: Panel, from?: HTMLButtonElement) => { opener.current = from ?? trigger.current; write.reset(); setPanel(next); };
  const menuItem = (label: string, Icon: LucideIcon, disabled: boolean, action: () => void) => <DropdownMenuItem disabled={disabled} onClick={action} className="rounded-md px-3 py-2 font-normal focus:bg-gray-100! focus:text-gray-900! data-highlighted:bg-gray-100!">
    <Icon aria-hidden="true" className="size-4 text-gray-500!" />{label}
  </DropdownMenuItem>;
  const unavailable = missing(relations.error) ? t("tasks.relations_unavailable") : relations.isError ? t("tasks.error_title") : !data ? t("tasks.loading") : !permissions.canEditContent ? t("tasks.relations_readonly") : null;
  const inspecting = panel === "predecessors" || panel === "successors" ? panel : null;
  const picking = panel === "add-predecessor" || panel === "add-successor" ? panel : null;
  const linked = inspecting && data ? data[inspecting] : [];
  const badges = (["predecessors", "successors"] as const).map(direction => data?.[direction].length ? <button type="button" key={direction} aria-haspopup="dialog" disabled={pending} onClick={e => open(direction, e.currentTarget)} className={`${headerBadge} focus-visible:outline-2 ${direction === "predecessors" ? "bg-[#cff5ce] text-[#237b32] dark:bg-green-4 dark:text-green-11" : "bg-[#ffe7ce] text-[#b65300] dark:bg-orange-4 dark:text-orange-11"}`}>
    <DependencyGlyph incoming={direction === "predecessors"} />
    {badgeLabel(direction, data[direction].length)}
  </button> : null);
  return <>
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{completion}{(data?.isMilestone ?? task.isMilestone) && <TaskMilestoneBadge />}{badges}</div>
    {following}
    <DropdownMenu onOpenChange={open => { if (open && relations.isError && !missing(relations.error)) void relations.refetch(); }}><DropdownMenuTrigger ref={trigger} aria-label={t("tasks.detail_actions")} render={<Button variant="ghost" size="icon" />}><MoreHorizontal aria-hidden="true" className="size-4" /></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-48 rounded-lg border border-gray-200 bg-white p-1 text-gray-900 shadow-lg">
        <DropdownMenuGroup>
          {menuItem(t(pickerLabels["set-parent"]), GitBranch, !editable, () => open("set-parent"))}
          {editable && data?.parentTaskId && menuItem(t("tasks.detach_parent"), RefreshCw, false, () => submit({ action: "detach-parent" }))}
          {menuItem(t(data?.isMilestone ? "tasks.unset_milestone" : "tasks.set_milestone"), Diamond, !editable, () => submit({ action: data?.isMilestone ? "unset-milestone" : "set-milestone" }))}
          {menuItem(t(pickerLabels["add-predecessor"]), CircleArrowLeft, !editable, () => open("add-predecessor"))}
          {menuItem(t(pickerLabels["add-successor"]), CircleArrowRight, !editable, () => open("add-successor"))}
        </DropdownMenuGroup>
        {unavailable && <p className="max-w-52 px-3 py-1 text-xs text-gray-600">{unavailable}</p>}
        <DropdownMenuSeparator className="my-1 bg-gray-200!" />
        <DropdownMenuGroup>
          {menuItem(t("tasks.history"), History, pending, () => onViewHistory(trigger.current))}
          {menuItem(t("tasks.delete_task_action"), Trash2, pending || !permissions.canDelete, () => open("delete"))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {panel === "set-parent" && <TaskParentPicker client={client} scope={scope} taskId={task.id} pending={pending} unavailable={unavailable} error={write.isError ? writeError(write.error, "set-parent") : null} finalFocus={() => trigger.current} onCancel={() => setPanel(null)} onSave={id => submit({ action: "set-parent", relatedTaskId: id })} />}
    {panel && panel !== "set-parent" && <Dialog open onOpenChange={v => { if (!v && !pending) setPanel(null); }}><DialogContent showCloseButton={false} finalFocus={() => opener.current?.isConnected ? opener.current : trigger.current}>
      <DialogHeader><DialogTitle>{picking ? t(pickerLabels[picking]) : inspecting ? badgeLabel(inspecting, linked.length) : t("tasks.delete_task_action")}</DialogTitle></DialogHeader>
      {panel === "delete" && <DialogDescription>{t("tasks.delete_task_confirm", { title: task.title })}</DialogDescription>}
      {(picking || inspecting) && unavailable && <p role="status">{unavailable}</p>}
      {picking && data && permissions.canEditContent && <TaskPicker key={picking} client={client} scope={scope} taskId={task.id} relations={data} pending={pending} onSelect={id => submit({ action: picking, relatedTaskId: id })} />}
      {inspecting && <ul className="max-h-64 overflow-y-auto">{linked.map(row => <li key={row.id} className="flex items-center gap-2 py-1">
        <Button variant="ghost" disabled={pending} className="min-w-0 flex-1 justify-start" onClick={() => onSelect(row.id)}><span className="truncate">{row.title}</span></Button><small>{statusLabel(row.status)}</small>
        {permissions.canEditContent && <Button variant="ghost" size="icon-sm" disabled={!editable} aria-label={t("tasks.unlink_task", { title: row.title })} onClick={() => submit({ action: inspecting === "predecessors" ? "remove-predecessor" : "remove-successor", relatedTaskId: row.id })}><Unlink aria-hidden="true" className="size-4" /></Button>}
      </li>)}</ul>}
      {write.isError && <p role="alert">{writeError(write.error, write.variables?.action)}</p>}
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setPanel(null)}>{t(panel === "delete" ? "common.cancel" : "common.close")}</Button>
        {panel === "delete" && <Button variant="destructive" disabled={pending || !permissions.canDelete} onClick={() => submit({ action: "delete" })}>{t("tasks.delete_task_action")}</Button>}
      </DialogFooter>
    </DialogContent></Dialog>}
  </>;
}

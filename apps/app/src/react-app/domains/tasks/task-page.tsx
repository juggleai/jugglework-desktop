/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { Archive, Check, CheckSquare, CircleAlert, Inbox, ListChecks, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { DenProductTask, DenProductTaskView } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import { useAddProductTaskComment, useCreateProductTask, useProductTaskListMutations, useProductTaskReminderMutations, useTransitionProductTask, useUpdateProductTask, type ProductTaskConflict } from "./task-mutations";
import { flattenProductTaskPages, useProductTask, useProductTaskActivity, useProductTaskLists, useProductTaskReminders, useProductTasks, type ProductTaskScope } from "./task-queries";

export type TaskShellState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message?: string; onRetry: () => void };

type TaskPageProps = {
  routeTaskId?: string | null;
  workspaceId: string;
  sessionPath: string;
  state?: TaskShellState;
  onOpenAccount: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenReviews: () => void;
  onOpenSettings: () => void;
  onOpenTaskSearch?: () => void;
  onOpenCreateWorkspace?: () => void;
};

type TaskSection = DenProductTaskView | "activity" | "archived";

const taskNavigation: Array<[TaskSection, string, typeof CheckSquare]> = [
  ["today", "tasks.today", ListChecks], ["inbox", "tasks.inbox", Inbox], ["assigned", "tasks.assigned_to_me", CheckSquare],
  ["created", "tasks.created_by_me", CheckSquare], ["following", "tasks.following", CheckSquare], ["activity", "tasks.activity", CheckSquare],
  ["all", "tasks.all", CheckSquare], ["completed", "tasks.completed", CheckSquare], ["trash", "tasks.trash", Trash2], ["archived", "tasks.archived_lists", Archive],
];

function mutationKey(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function TaskPage(props: TaskPageProps) {
  return props.state ? <TaskPageFrame {...props}><TaskShellContent state={props.state} /></TaskPageFrame> : <ConnectedTaskPage {...props} />;
}

function ConnectedTaskPage(props: TaskPageProps) {
  const cloud = useCloudSession();
  const navigate = useNavigate();
  const [section, setSection] = React.useState<TaskSection>("today");
  const [search, setSearch] = React.useState("");
  const [priority, setPriority] = React.useState<"" | "low" | "medium" | "high">("");
  const [sort, setSort] = React.useState<"updated_at" | "due_at" | "created_at" | "priority">("updated_at");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(props.routeTaskId ?? null);
  const [selectedListId, setSelectedListId] = React.useState<string | null>(null);
  const [createTitle, setCreateTitle] = React.useState("");
  const [showFullCreate, setShowFullCreate] = React.useState(false);
  const [conflict, setConflict] = React.useState<ProductTaskConflict | null>(null);
  const scope = React.useMemo<ProductTaskScope | null>(() => cloud.isSignedIn && cloud.user?.id && cloud.activeOrganization?.id
    ? { baseUrl: cloud.baseUrl, userId: cloud.user.id, organizationId: cloud.activeOrganization.id }
    : null, [cloud.activeOrganization?.id, cloud.baseUrl, cloud.isSignedIn, cloud.user?.id]);
  const listOptions = React.useMemo(() => {
    if (section === "activity" || section === "archived") return { view: "all" as const, search };
    const common = {
      view: section,
      search,
      priority: priority ? [priority] : undefined,
      listId: selectedListId ? [selectedListId] : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Today has a dedicated server-defined ordering, while Trash only accepts
    // updated_at. Do not send the generic picker value for either view.
    if (section === "today") return common;
    if (section === "trash") return { ...common, sort: "updated_at" as const, direction: "desc" as const };
    return { ...common, sort, direction: sort === "due_at" ? "asc" as const : "desc" as const };
  }, [priority, search, section, selectedListId, sort]);
  const tasksQuery = useProductTasks({ client: cloud.client, scope, options: listOptions, active: section !== "activity" && section !== "archived" });
  const listsQuery = useProductTaskLists({ client: cloud.client, scope, archived: section === "archived", active: section === "archived" });
  const activeListsQuery = useProductTaskLists({ client: cloud.client, scope, archived: false });
  const detailQuery = useProductTask({ client: cloud.client, scope, taskId: selectedTaskId });
  const activityQuery = useProductTaskActivity({ client: cloud.client, scope, taskId: selectedTaskId });
  const remindersQuery = useProductTaskReminders({ client: cloud.client, scope, taskId: selectedTaskId });
  const createMutation = useCreateProductTask(cloud.client, scope);
  const updateMutation = useUpdateProductTask(cloud.client, scope, setConflict);
  const transitionMutation = useTransitionProductTask(cloud.client, scope);
  const commentMutation = useAddProductTaskComment(cloud.client, scope, selectedTaskId);
  const listMutations = useProductTaskListMutations(cloud.client, scope);
  const reminderMutations = useProductTaskReminderMutations(cloud.client, scope, selectedTaskId);
  const tasks = flattenProductTaskPages(tasksQuery.data);
  React.useEffect(() => setSelectedTaskId(props.routeTaskId ?? null), [props.routeTaskId]);
  const selectTask = (taskId: string | null) => {
    setSelectedTaskId(taskId);
    navigate(taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks");
  };

  const quickCreate = async () => {
    const title = createTitle.trim();
    if (!title || !scope) return;
    const result = await createMutation.mutateAsync({ idempotencyKey: mutationKey("desktop-create-task"), title, visibility: "private" });
    setCreateTitle("");
    selectTask(result.task.id);
  };

  let content: React.ReactNode;
  if (!scope) content = <TaskShellContent state={{ kind: "error", message: t("tasks.sign_in_required"), onRetry: props.onOpenAccount }} />;
  else if (section === "activity") content = <TaskShellContent state={{ kind: "empty" }} />;
  else if (section === "archived") content = listsQuery.isLoading ? <TaskShellContent state={{ kind: "loading" }} /> : listsQuery.isError
    ? <TaskShellContent state={{ kind: "error", onRetry: () => void listsQuery.refetch() }} />
    : <div className="w-full self-start space-y-2">{listsQuery.data?.items.map((list) => <div key={list.id} className="flex items-center rounded-lg border border-dls-border p-3"><div className="flex-1"><div className="font-medium text-dls-text">{list.marker} {list.name}</div><div className="text-sm text-dls-secondary">{list.description}</div></div><Button size="sm" variant="outline" onClick={() => listMutations.transition.mutate({ listId: list.id, operation: "restore", expectedVersion: list.version, idempotencyKey: mutationKey("desktop-restore-list") })}>{t("tasks.restore_list")}</Button></div>)}</div>;
  else if (tasksQuery.isLoading) content = <TaskShellContent state={{ kind: "loading" }} />;
  else if (tasksQuery.isError) content = <TaskShellContent state={{ kind: "error", message: tasksQuery.error instanceof Error ? tasksQuery.error.message : undefined, onRetry: () => void tasksQuery.refetch() }} />;
  else content = <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelect={selectTask} canLoadMore={Boolean(tasksQuery.hasNextPage)} loadingMore={tasksQuery.isFetchingNextPage} onLoadMore={() => void tasksQuery.fetchNextPage()} />;

  return (
    <TaskPageFrame {...props} section={section} onSectionChange={(next) => { setSection(next); setSelectedListId(null); selectTask(null); }} search={search} onSearchChange={setSearch} filters={{ priority, setPriority, sort, setSort }} lists={activeListsQuery.data?.items ?? []} selectedListId={selectedListId} onSelectList={(listId) => { setSection("all"); setSelectedListId(listId); setSearch(""); selectTask(null); }} onCreateList={() => { const name = globalThis.prompt(t("tasks.list_name"))?.trim(); if (name) listMutations.create.mutate({ idempotencyKey: mutationKey("desktop-create-list"), name, visibility: "private" }); }} onArchiveList={(listId, version) => listMutations.transition.mutate({ listId, operation: "archive", expectedVersion: version, idempotencyKey: mutationKey("desktop-archive-list") })}
      quickCreate={{ title: createTitle, setTitle: setCreateTitle, submit: quickCreate, pending: createMutation.isPending, openFull: () => setShowFullCreate(true) }}>
      {conflict ? <ConflictBanner conflict={conflict} onDismiss={() => setConflict(null)} onReload={() => { setConflict(null); void detailQuery.refetch(); }} /> : null}
      {content}
      {selectedTaskId ? <TaskDetail result={detailQuery.data} activity={activityQuery.data} reminders={remindersQuery.data ?? []} loading={detailQuery.isLoading} error={detailQuery.isError} onClose={() => selectTask(null)} onSave={(taskId, patch) => updateMutation.mutate({ taskId, patch })} onComment={(body) => commentMutation.mutate({ body, idempotencyKey: mutationKey("desktop-comment-task") })} onSetReminder={(scheduledAt) => reminderMutations.set.mutate({ idempotencyKey: mutationKey("desktop-set-reminder"), mode: "absolute", scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })} onCancelReminder={() => reminderMutations.cancel.mutate(mutationKey("desktop-cancel-reminder"))} onTransition={(task, operation) => transitionMutation.mutate({ taskId: task.id, operation, expectedVersion: task.version, idempotencyKey: mutationKey(`desktop-${operation}-task`) })} /> : null}
      {showFullCreate ? <TaskCreateDialog initialTitle={createTitle} pending={createMutation.isPending} onClose={() => setShowFullCreate(false)} onCreate={async (input) => { const result = await createMutation.mutateAsync({ ...input, idempotencyKey: mutationKey("desktop-create-task") }); setShowFullCreate(false); setCreateTitle(""); selectTask(result.task.id); }} /> : null}
    </TaskPageFrame>
  );
}

function TaskPageFrame(props: TaskPageProps & { children: React.ReactNode; section?: TaskSection; onSectionChange?: (section: TaskSection) => void; search?: string; onSearchChange?: (value: string) => void; filters?: { priority: string; setPriority: (value: "" | "low" | "medium" | "high") => void; sort: string; setSort: (value: "updated_at" | "due_at" | "created_at" | "priority") => void }; lists?: Array<{ id: string; name: string; marker: string; version: number }>; selectedListId?: string | null; onSelectList?: (id: string) => void; onCreateList?: () => void; onArchiveList?: (id: string, version: number) => void; quickCreate?: { title: string; setTitle: (value: string) => void; submit: () => void; pending: boolean; openFull: () => void } }) {
  const navigate = useNavigate();
  const { leftSidebarWidth } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = { "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth), WebkitAppRegion: "drag" } as CSSProperties;
  const activeSection = props.section ?? "today";
  const heading = taskNavigation.find(([section]) => section === activeSection)?.[1] ?? "tasks.today";
  return <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle}>
    <AppNavigationRail workspaceId={props.workspaceId} onOpenAccount={props.onOpenAccount} onOpenHome={() => navigate(props.sessionPath)} onOpenApps={props.onOpenApps} onOpenChat={props.onOpenChat} onOpenReviews={props.onOpenReviews} onOpenSettings={props.onOpenSettings} onOpenTaskSearch={props.onOpenTaskSearch} onOpenCreateWorkspace={props.onOpenCreateWorkspace} />
    <AppInsetSurface testId="tasks-inset-surface"><div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside aria-label={t("tasks.navigation")} className="w-[var(--jugglework-left-sidebar-width)] shrink-0 border-r border-dls-border bg-[var(--app-secondary-sidebar-bg)] px-3 py-5" data-testid="tasks-sidebar">
        <div className="mb-4 flex items-center gap-2 px-2"><CheckSquare className="size-5 text-dls-accent" /><h1 className="text-base font-semibold text-dls-text">{t("tasks.title")}</h1></div>
        {props.onSearchChange ? <div className="relative mb-3"><Search className="absolute left-2.5 top-2.5 size-4 text-dls-secondary" /><Input aria-label={t("tasks.search")} className="pl-8" value={props.search} onChange={(event) => props.onSearchChange?.(event.target.value)} placeholder={t("tasks.search")} /></div> : null}
        <nav className="space-y-1">{taskNavigation.map(([section, key, Icon]) => <button key={section} type="button" onClick={() => props.onSectionChange?.(section)} aria-current={activeSection === section ? "page" : undefined} className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors ${activeSection === section ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"}`}><Icon className="size-4" />{t(key)}</button>)}</nav>
        <div className="my-4 border-t border-dls-border" /><div className="flex items-center justify-between px-2 text-xs font-medium uppercase tracking-wide text-dls-secondary"><span>{t("tasks.lists")}</span>{props.onCreateList ? <button type="button" onClick={props.onCreateList} aria-label={t("tasks.create_list")}><Plus className="size-3.5" /></button> : null}</div><div className="mt-2 space-y-1">{props.lists?.map((list) => <div key={list.id} className="group flex items-center"><button type="button" className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${props.selectedListId === list.id ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover"}`} onClick={() => props.onSelectList?.(list.id)}>{list.marker} {list.name}</button><button type="button" className="invisible p-1 text-dls-secondary group-hover:visible" aria-label={t("tasks.archive_list")} onClick={() => props.onArchiveList?.(list.id, list.version)}><Archive className="size-3.5" /></button></div>)}</div>
      </aside>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-main">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-dls-border px-6"><h2 className="text-base font-semibold text-dls-text">{t(heading)}</h2><div className="flex items-center gap-2">{props.filters && activeSection !== "archived" && activeSection !== "activity" ? <><select aria-label={t("tasks.priority_filter")} value={props.filters.priority} onChange={(event) => props.filters?.setPriority(event.target.value as "" | "low" | "medium" | "high")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="">{t("tasks.all_priorities")}</option><option value="low">{t("tasks.priority_low")}</option><option value="medium">{t("tasks.priority_medium")}</option><option value="high">{t("tasks.priority_high")}</option></select><select aria-label={t("tasks.sort")} value={props.filters.sort} onChange={(event) => props.filters?.setSort(event.target.value as "updated_at" | "due_at" | "created_at" | "priority")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="updated_at">{t("tasks.sort_updated")}</option><option value="due_at">{t("tasks.sort_due")}</option><option value="created_at">{t("tasks.sort_created")}</option><option value="priority">{t("tasks.sort_priority")}</option></select></> : null}{props.quickCreate ? <Button size="sm" onClick={props.quickCreate.openFull}><Plus className="size-4" />{t("tasks.create")}</Button> : null}</div></div>
        {props.quickCreate && activeSection !== "trash" && activeSection !== "archived" ? <form className="flex gap-2 border-b border-dls-border p-3" onSubmit={(event) => { event.preventDefault(); props.quickCreate?.submit(); }}><Input value={props.quickCreate.title} onChange={(event) => props.quickCreate?.setTitle(event.target.value)} placeholder={t("tasks.quick_create")} /><Button type="submit" disabled={!props.quickCreate.title.trim() || props.quickCreate.pending}>{t("tasks.add")}</Button></form> : null}
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">{props.children}</div>
      </main>
    </div></AppInsetSurface>
  </div>;
}

function TaskList(props: { tasks: DenProductTask[]; selectedTaskId: string | null; onSelect: (id: string) => void; canLoadMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!props.tasks.length) return <TaskShellContent state={{ kind: "empty" }} />;
  return <div className="w-full self-start space-y-2" role="list">{props.tasks.map((task) => <div role="listitem" key={task.id} className={`flex items-center gap-3 rounded-lg border p-3 ${props.selectedTaskId === task.id ? "border-dls-accent bg-dls-active" : "border-dls-border"}`}>
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full border border-dls-border">{task.status === "completed" ? <Check className="size-4" /> : null}</span>
    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => props.onSelect(task.id)}><div className={`truncate font-medium text-dls-text ${task.status === "completed" ? "line-through" : ""}`}>{task.title}</div><div className="mt-1 flex gap-3 text-xs text-dls-secondary"><span>{t(`tasks.priority_${task.priority}`)}</span>{task.dueAt ? <span>{new Date(task.dueAt).toLocaleString()}</span> : null}</div></button>
  </div>)}{props.canLoadMore ? <Button variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? t("tasks.loading") : t("tasks.load_more")}</Button> : null}</div>;
}

function TaskDetail(props: { result: ReturnType<typeof useProductTask>["data"]; activity: ReturnType<typeof useProductTaskActivity>["data"]; reminders: Array<{ scheduledAt: string; state: string }>; loading: boolean; error: boolean; onClose: () => void; onSave: (id: string, patch: { expectedVersion: number; idempotencyKey: string; title: string; description: string }) => void; onComment: (body: string) => void; onSetReminder: (scheduledAt: string) => void; onCancelReminder: () => void; onTransition: (task: DenProductTask, operation: "complete" | "cancel" | "reopen" | "restore") => void }) {
  const task = props.result?.task;
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [comment, setComment] = React.useState("");
  React.useEffect(() => { if (task) { setTitle(task.title); setDescription(task.description); } }, [task]);
  return <aside className="absolute inset-y-0 right-0 z-10 w-[min(480px,90%)] border-l border-dls-border bg-dls-surface p-5 shadow-xl" aria-label={t("tasks.detail")}>
    <div className="mb-5 flex items-center justify-between"><h3 className="font-semibold text-dls-text">{t("tasks.detail")}</h3><Button variant="ghost" size="icon" onClick={props.onClose}><X className="size-4" /></Button></div>
    {props.loading ? <TaskShellContent state={{ kind: "loading" }} /> : props.error || !task ? <TaskShellContent state={{ kind: "error", onRetry: () => undefined }} /> : <div className="space-y-4"><Input value={title} readOnly={!props.result?.permissions.canEditContent} onChange={(event) => setTitle(event.target.value)} /><Textarea value={description} readOnly={!props.result?.permissions.canEditContent} onChange={(event) => setDescription(event.target.value)} />
      <div className="text-sm text-dls-secondary">{t("tasks.assignees")}: {props.result?.members.filter((member) => member.role === "assignee").map((member) => member.memberId).join(", ") || t("tasks.unassigned")}</div>
      <div className="space-y-1 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.activity")}</div>{props.activity?.events.length ? props.activity.events.map((event) => <div key={event.id}>{event.eventType} · {new Date(event.createdAt).toLocaleString()}</div>) : t("tasks.activity_empty")}</div>
      <div className="space-y-2 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.comments")}</div>{props.activity?.comments.length ? props.activity.comments.map((item) => <div key={item.id} className="rounded border border-dls-border p-2">{item.body}</div>) : t("tasks.comments_empty")}{props.result?.permissions.canComment ? <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (comment.trim()) { props.onComment(comment.trim()); setComment(""); } }}><Input value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t("tasks.add_comment")} /><Button type="submit" disabled={!comment.trim()}>{t("tasks.add")}</Button></form> : null}</div>
      <div className="space-y-2 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.reminder")}</div>{props.reminders.find((item) => item.state === "scheduled") ? <div className="flex items-center justify-between"><span>{new Date(props.reminders.find((item) => item.state === "scheduled")!.scheduledAt).toLocaleString()}</span><Button size="sm" variant="outline" onClick={props.onCancelReminder}>{t("tasks.remove_reminder")}</Button></div> : props.result?.permissions.canEditTime ? <input type="datetime-local" aria-label={t("tasks.reminder")} className="rounded border border-dls-border bg-dls-surface p-2" onChange={(event) => { if (event.target.value) props.onSetReminder(new Date(event.target.value).toISOString()); }} /> : t("tasks.no_reminder")}</div>
      <div className="flex flex-wrap gap-2">{props.result?.permissions.canEditContent ? <Button disabled={!title.trim()} onClick={() => props.onSave(task.id, { expectedVersion: task.version, idempotencyKey: mutationKey("desktop-update-task"), title: title.trim(), description })}>{t("tasks.save")}</Button> : null}
      {task.status === "todo" && props.result?.permissions.canComplete ? <Button onClick={() => { const assignees = props.result?.members.filter((member) => member.role === "assignee").length ?? 0; if (assignees <= 1 || globalThis.confirm(t("tasks.complete_multi_confirm"))) props.onTransition(task, "complete"); }}>{t("tasks.complete")}</Button> : null}
      {task.status !== "todo" && props.result?.permissions.canReopen ? <Button variant="outline" onClick={() => props.onTransition(task, "reopen")}>{t("tasks.reopen")}</Button> : null}
      {task.status === "todo" && props.result?.permissions.canCancel ? <Button variant="outline" onClick={() => props.onTransition(task, "cancel")}>{t("tasks.cancel_task")}</Button> : null}</div>
    </div>}
  </aside>;
}

function TaskCreateDialog(props: { initialTitle: string; pending: boolean; onClose: () => void; onCreate: (input: { title: string; description: string; visibility: "private"; priority: "none" | "low" | "medium" | "high" }) => Promise<void> }) {
  const [title, setTitle] = React.useState(props.initialTitle);
  const [description, setDescription] = React.useState("");
  return <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/30 p-5" role="dialog" aria-modal="true" aria-label={t("tasks.create")}><form className="w-full max-w-lg space-y-4 rounded-xl bg-dls-surface p-5 shadow-xl" onSubmit={(event) => { event.preventDefault(); void props.onCreate({ title: title.trim(), description, visibility: "private", priority: "none" }); }}><div className="flex items-center justify-between"><h3 className="font-semibold">{t("tasks.create")}</h3><Button type="button" variant="ghost" size="icon" onClick={props.onClose}><X className="size-4" /></Button></div><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("tasks.title_field")} /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("tasks.description_field")} /><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={props.onClose}>{t("tasks.cancel")}</Button><Button type="submit" disabled={!title.trim() || props.pending}>{t("tasks.create")}</Button></div></form></div>;
}

function ConflictBanner(props: { conflict: ProductTaskConflict; onDismiss: () => void; onReload: () => void }) {
  return <div className="absolute left-4 right-4 top-16 z-20 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 p-3 text-sm" role="alert"><CircleAlert className="size-4" /><span className="flex-1">{t("tasks.conflict")}</span><Button size="sm" variant="outline" onClick={props.onReload}>{t("tasks.load_latest")}</Button><Button size="sm" variant="ghost" onClick={props.onDismiss}>{t("tasks.dismiss")}</Button></div>;
}

export function TaskShellContent({ state }: { state: TaskShellState }) {
  if (state.kind === "loading") return <div className="flex flex-col items-center gap-3 text-center text-dls-secondary" role="status" aria-live="polite"><LoaderCircle className="size-6 animate-spin" /><p className="text-sm">{t("tasks.loading")}</p></div>;
  if (state.kind === "error") return <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert"><CircleAlert className="size-8 text-red-9" /><div><h3 className="font-medium text-dls-text">{t("tasks.error_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{state.message ?? t("tasks.error_description")}</p></div><Button variant="outline" size="sm" onClick={state.onRetry}><RefreshCw className="size-4" />{t("tasks.retry")}</Button></div>;
  return <div className="flex max-w-sm flex-col items-center gap-3 text-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-dls-active text-dls-accent"><ListChecks className="size-6" /></div><div><h3 className="font-medium text-dls-text">{t("tasks.empty_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{t("tasks.empty_description")}</p></div></div>;
}

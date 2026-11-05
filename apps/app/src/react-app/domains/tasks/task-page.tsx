/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlignLeft, CalendarDays, Check, ChevronDown, CircleAlert, ListChecks, ListTodo, LoaderCircle, Plus, RefreshCw, UserRound, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { DenApiError, isPersonalDenOrganization, type DenOrganizationMember, type DenProductTask, type DenProductTaskCreateInput, type DenProductTaskList, type DenProductTaskUpdateInput, type DenProductTaskVisibility } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { AppInsetSurface } from "@/react-app/shell/app-inset-surface";
import { AppNavigationRail } from "@/react-app/shell/app-navigation-rail";
import { usePublishTasksSidebar } from "@/react-app/shell/app-navigation-sidebar-preview";
import { AppSecondarySidebarResizeHandle } from "@/react-app/shell/app-secondary-sidebar-resize-handle";
import { AppSecondarySidebarTopControls } from "@/react-app/shell/app-secondary-sidebar-top-controls";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appInsetSidebarCssWidth, useWorkspaceShellLayout } from "@/react-app/shell/workspace-shell-layout";
import { useAddProductTaskComment, useCreateProductTask, useProductTaskListMutations, useProductTaskReminderMutations, useTransitionProductTask, useUpdateProductTask, type ProductTaskConflict } from "./task-mutations";
import { flattenProductTaskMembers, flattenProductTaskPages, productTaskKeys, productTaskScopeKey, useOrganizationMembers, useProductTask, useProductTaskActivity, useProductTaskLists, useProductTaskReminders, useProductTasks, type ProductTaskScope } from "./task-queries";
import { productTaskEditDraft, readTaskSection, reapplyProductTaskDraft, taskSectionStorageKey, writeTaskSection, type ProductTaskEditDraft, type TaskSection } from "./task-page-state";
import { TaskWorkbench, taskWorkbenchServerSort, taskWorkbenchStatuses } from "./task-workbench";
import { readTaskWorkbenchSettings, writeTaskWorkbenchSettings, type TaskWorkbenchSettings } from "./task-view-state";
import { TasksSidebar, taskSectionHeading, type TasksSidebarRegistration } from "./tasks-sidebar";

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

function mutationKey(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function TaskPage(props: TaskPageProps) {
  return props.state ? <TaskPageFrame {...props}><TaskShellContent state={props.state} /></TaskPageFrame> : <ConnectedTaskPage {...props} />;
}

function ConnectedTaskPage(props: TaskPageProps) {
  const cloud = useCloudSession();
  const scope = React.useMemo<ProductTaskScope | null>(() => cloud.isSignedIn && cloud.user?.id && cloud.activeOrganization?.id
    ? { baseUrl: cloud.baseUrl, userId: cloud.user.id, organizationId: cloud.activeOrganization.id }
    : null, [cloud.activeOrganization?.id, cloud.baseUrl, cloud.isSignedIn, cloud.user?.id]);
  return <ScopedConnectedTaskPage key={productTaskScopeKey(scope)} {...props} />;
}

function ScopedConnectedTaskPage(props: TaskPageProps) {
  const cloud = useCloudSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = React.useMemo<ProductTaskScope | null>(() => cloud.isSignedIn && cloud.user?.id && cloud.activeOrganization?.id
    ? { baseUrl: cloud.baseUrl, userId: cloud.user.id, organizationId: cloud.activeOrganization.id }
    : null, [cloud.activeOrganization?.id, cloud.baseUrl, cloud.isSignedIn, cloud.user?.id]);
  const scopeKey = productTaskScopeKey(scope);
  const [section, setSection] = React.useState<TaskSection>(() => readTaskSection(scope));
  const [priority, setPriority] = React.useState<"" | "low" | "medium" | "high">("");
  const [sort, setSort] = React.useState<"updated_at" | "due_at" | "created_at" | "priority">("updated_at");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(props.routeTaskId ?? null);
  const [selectedListId, setSelectedListId] = React.useState<string | null>(null);
  const [showFullCreate, setShowFullCreate] = React.useState(false);
  const [showCreateList, setShowCreateList] = React.useState(false);
  const [workbenchSettings, setWorkbenchSettings] = React.useState<TaskWorkbenchSettings>(() => readTaskWorkbenchSettings(scope));
  const [conflict, setConflict] = React.useState<ProductTaskConflict | null>(null);
  const [editDrafts, setEditDrafts] = React.useState<Record<string, ProductTaskEditDraft>>({});
  const liveScopeKey = React.useRef(scopeKey);
  const liveConflict = React.useRef<ProductTaskConflict | null>(conflict);
  const liveSelectedTaskId = React.useRef(selectedTaskId);
  const discardedDraftTaskIds = React.useRef(new Set<string>());
  const saveAttemptCounter = React.useRef(0);
  const latestSaveAttempts = React.useRef(new Map<string, number>());
  const conflictLoadAttempt = React.useRef(0);
  const commentAttemptCounter = React.useRef(0);
  const latestCommentAttempts = React.useRef(new Map<string, number>());
  liveScopeKey.current = scopeKey;
  liveConflict.current = conflict;
  liveSelectedTaskId.current = selectedTaskId;
  const listOptions = React.useMemo(() => {
    if (section === "activity") return { view: "all" as const };
    if (section === "assigned") {
      return {
        view: "assigned" as const,
        status: taskWorkbenchStatuses(workbenchSettings),
        priority: workbenchSettings.priorities.length ? workbenchSettings.priorities : undefined,
        listId: workbenchSettings.listIds.length ? workbenchSettings.listIds : undefined,
        assigneeMemberId: workbenchSettings.assigneeMemberIds.length ? workbenchSettings.assigneeMemberIds : undefined,
        assigneeMemberOperator: workbenchSettings.assigneeMemberIds.length || workbenchSettings.assigneeMemberOperator === "empty" || workbenchSettings.assigneeMemberOperator === "not_empty" ? workbenchSettings.assigneeMemberOperator : undefined,
        assignerMemberId: workbenchSettings.assignerMemberIds.length ? workbenchSettings.assignerMemberIds : undefined,
        assignerMemberOperator: workbenchSettings.assignerMemberIds.length || workbenchSettings.assignerMemberOperator === "empty" || workbenchSettings.assignerMemberOperator === "not_empty" ? workbenchSettings.assignerMemberOperator : undefined,
        creatorMemberId: workbenchSettings.creatorMemberIds.length ? workbenchSettings.creatorMemberIds : undefined,
        creatorMemberOperator: workbenchSettings.creatorMemberIds.length || workbenchSettings.creatorMemberOperator === "empty" || workbenchSettings.creatorMemberOperator === "not_empty" ? workbenchSettings.creatorMemberOperator : undefined,
        followerMemberId: workbenchSettings.followerMemberIds.length ? workbenchSettings.followerMemberIds : undefined,
        followerMemberOperator: workbenchSettings.followerMemberIds.length || workbenchSettings.followerMemberOperator === "empty" || workbenchSettings.followerMemberOperator === "not_empty" ? workbenchSettings.followerMemberOperator : undefined,
        overdue: workbenchSettings.overdue || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...taskWorkbenchServerSort(workbenchSettings),
      };
    }
    const common = {
      view: section,
      priority: priority ? [priority] : undefined,
      listId: selectedListId ? [selectedListId] : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Today has dedicated server-defined ordering, so omit the generic sort.
    if (section === "today") return common;
    return { ...common, sort, direction: sort === "due_at" ? "asc" as const : "desc" as const };
  }, [priority, section, selectedListId, sort, workbenchSettings]);
  const tasksQuery = useProductTasks({ client: cloud.client, scope, options: listOptions, active: section !== "activity" });
  const activeListsQuery = useProductTaskLists({ client: cloud.client, scope, archived: false });
  const fallbackMember = React.useMemo(() => {
    const memberId = cloud.activeOrganization?.orgMemberId || cloud.activeOrganization?.membershipId;
    return memberId && cloud.user ? { id: memberId, userId: cloud.user.id, role: cloud.activeOrganization?.role ?? "member", user: { id: cloud.user.id, name: cloud.user.name, account: cloud.user.account ?? null, email: cloud.user.email ?? null, avatar: cloud.user.avatar ?? null } } : null;
  }, [cloud.activeOrganization?.membershipId, cloud.activeOrganization?.orgMemberId, cloud.activeOrganization?.role, cloud.user]);
  const membersQuery = useOrganizationMembers({ client: cloud.client, scope, fallback: fallbackMember, allowUnavailableFallback: isPersonalDenOrganization(cloud.activeOrganization), active: section === "assigned" || showFullCreate });
  const availableMembers = membersQuery.data ?? (fallbackMember ? [fallbackMember] : []);
  const currentMemberId = fallbackMember?.id ?? availableMembers.find((member) => member.userId === cloud.user?.id)?.id ?? null;
  const detailQuery = useProductTask({ client: cloud.client, scope, taskId: selectedTaskId });
  const activityQuery = useProductTaskActivity({ client: cloud.client, scope, taskId: selectedTaskId });
  const remindersQuery = useProductTaskReminders({ client: cloud.client, scope, taskId: selectedTaskId });
  const createMutation = useCreateProductTask(cloud.client, scope);
  const handleConflict = (next: ProductTaskConflict) => {
    if (next.scopeKey !== liveScopeKey.current || latestSaveAttempts.current.get(next.taskId) !== next.attempt || discardedDraftTaskIds.current.has(next.taskId)) return;
    setEditDrafts((current) => ({ ...current, [next.taskId]: productTaskEditDraft(next.taskId, next.draft) }));
    if (liveSelectedTaskId.current === next.taskId) {
      conflictLoadAttempt.current += 1;
      liveConflict.current = next;
      setConflict(next);
    }
  };
  const updateMutation = useUpdateProductTask(cloud.client, scope, handleConflict);
  const transitionMutation = useTransitionProductTask(cloud.client, scope);
  const commentMutation = useAddProductTaskComment(cloud.client, scope);
  const listMutations = useProductTaskListMutations(cloud.client, scope);
  const reminderMutations = useProductTaskReminderMutations(cloud.client, scope, selectedTaskId);
  const tasks = flattenProductTaskPages(tasksQuery.data);
  const membersByTaskId = flattenProductTaskMembers(tasksQuery.data);
  React.useEffect(() => {
    const nextTaskId = props.routeTaskId ?? null;
    conflictLoadAttempt.current += 1;
    liveSelectedTaskId.current = nextTaskId;
    if (liveConflict.current?.taskId !== nextTaskId) liveConflict.current = null;
    setConflict((current) => current && current.taskId !== nextTaskId ? null : current);
    setSelectedTaskId(nextTaskId);
  }, [props.routeTaskId]);
  React.useEffect(() => {
    conflictLoadAttempt.current += 1;
    liveConflict.current = null;
    setSection(readTaskSection(scope));
    setSelectedListId(null);
    setConflict(null);
    setEditDrafts({});
    discardedDraftTaskIds.current.clear();
    latestSaveAttempts.current.clear();
    latestCommentAttempts.current.clear();
    setShowFullCreate(false);
    setShowCreateList(false);
    setWorkbenchSettings(readTaskWorkbenchSettings(scope));
  }, [scopeKey]);
  const selectTask = (taskId: string | null) => {
    conflictLoadAttempt.current += 1;
    liveSelectedTaskId.current = taskId;
    if (liveConflict.current?.taskId !== taskId) liveConflict.current = null;
    setConflict((current) => current && current.taskId !== taskId ? null : current);
    setSelectedTaskId(taskId);
    navigate(taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks");
  };

  const closeTask = () => {
    if (selectedTaskId) {
      discardedDraftTaskIds.current.add(selectedTaskId);
      latestSaveAttempts.current.delete(selectedTaskId);
      latestCommentAttempts.current.delete(selectedTaskId);
      setEditDrafts((current) => {
        const next = { ...current };
        delete next[selectedTaskId];
        return next;
      });
    }
    conflictLoadAttempt.current += 1;
    liveConflict.current = null;
    setConflict(null);
    selectTask(null);
  };

  const selectSection = (next: TaskSection) => {
    writeTaskSection(scope, next);
    setSection(next);
  };

  const updateWorkbenchSettings = (next: TaskWorkbenchSettings) => {
    writeTaskWorkbenchSettings(scope, next);
    setWorkbenchSettings(next);
  };

  const transitionWorkbenchTask = async (task: DenProductTask, operation: "complete" | "reopen" | "cancel") => {
    if (!scope) return;
    const capturedScope = scope;
    const detail = await runMutation(
      () => cloud.client.getProductTask(capturedScope.organizationId, task.id),
      { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) },
    );
    if (!detail) return;
    queryClient.setQueryData(productTaskKeys.detail(capturedScope, task.id), detail);
    const allowed = operation === "complete"
      ? detail.permissions.canComplete
      : operation === "cancel"
        ? detail.permissions.canCancel
        : detail.permissions.canReopen;
    if (!allowed) {
      if (liveScopeKey.current === productTaskScopeKey(capturedScope)) toast.error(t("tasks.transition_not_allowed"));
      return;
    }
    const assigneeCount = detail.members.filter((member) => member.role === "assignee").length;
    if (operation === "complete" && assigneeCount > 1 && !globalThis.confirm(t("tasks.complete_multi_confirm"))) return;
    await runMutation(() => transitionMutation.mutateAsync({ taskId: task.id, operation, expectedVersion: detail.task.version, idempotencyKey: mutationKey(`desktop-${operation}-task`) }));
  };

  const mutationError = (error: unknown, capturedScopeKey = scopeKey) => {
    if (capturedScopeKey !== liveScopeKey.current) return;
    if (error instanceof DenApiError && error.status === 409) {
      toast.warning(t("tasks.conflict"));
      return;
    }
    toast.error(error instanceof Error && error.message ? error.message : t("tasks.error_description"));
  };

  const runMutation = async <T,>(action: () => Promise<T>, options?: { suppressConflictAlert?: boolean; isCurrent?: () => boolean }): Promise<T | undefined> => {
    const capturedScopeKey = scopeKey;
    const isCurrent = () => capturedScopeKey === liveScopeKey.current && (options?.isCurrent?.() ?? true);
    try {
      const result = await action();
      return isCurrent() ? result : undefined;
    } catch (error) {
      if (isCurrent() && !(options?.suppressConflictAlert && error instanceof DenApiError && error.status === 409)) mutationError(error, capturedScopeKey);
      return undefined;
    }
  };

  const saveTask = async (taskId: string, patch: DenProductTaskUpdateInput) => {
    const capturedScopeKey = scopeKey;
    const attempt = ++saveAttemptCounter.current;
    latestSaveAttempts.current.set(taskId, attempt);
    discardedDraftTaskIds.current.delete(taskId);
    setEditDrafts((current) => ({ ...current, [taskId]: productTaskEditDraft(taskId, patch) }));
    const isCurrent = () => latestSaveAttempts.current.get(taskId) === attempt && !discardedDraftTaskIds.current.has(taskId);
    const result = await runMutation(() => updateMutation.mutateAsync({ taskId, attempt, patch }), { suppressConflictAlert: true, isCurrent });
    if (!result || capturedScopeKey !== liveScopeKey.current || !isCurrent()) return;
    setEditDrafts((current) => {
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    setConflict((current) => {
      if (current?.taskId !== taskId || current.attempt > attempt) return current;
      liveConflict.current = null;
      conflictLoadAttempt.current += 1;
      return null;
    });
  };

  const updateBufferedDraft = (draft: ProductTaskEditDraft) => {
    if (!editDrafts[draft.taskId]) return;
    setEditDrafts((current) => ({ ...current, [draft.taskId]: draft }));
  };

  const loadLatestForConflict = async () => {
    if (!conflict || !scope) return;
    const capturedConflict = conflict;
    const capturedScope = scope;
    const capturedLoadAttempt = ++conflictLoadAttempt.current;
    const isCurrent = () => {
      const activeConflict = liveConflict.current;
      return capturedLoadAttempt === conflictLoadAttempt.current
        && capturedConflict.scopeKey === liveScopeKey.current
        && liveSelectedTaskId.current === capturedConflict.taskId
        && activeConflict?.scopeKey === capturedConflict.scopeKey
        && activeConflict.taskId === capturedConflict.taskId
        && activeConflict.attempt === capturedConflict.attempt;
    };
    try {
      const result = await cloud.client.getProductTask(capturedScope.organizationId, capturedConflict.taskId);
      if (!isCurrent()) return;
      queryClient.setQueryData(productTaskKeys.detail(capturedScope, capturedConflict.taskId), result);
      const nextConflict = { ...capturedConflict, currentVersion: result.task.version, latestLoaded: true };
      liveConflict.current = nextConflict;
      setConflict(nextConflict);
    } catch (error) {
      if (isCurrent()) mutationError(error, capturedConflict.scopeKey);
    }
  };

  const dismissConflict = () => {
    conflictLoadAttempt.current += 1;
    liveConflict.current = null;
    setConflict(null);
  };

  const addComment = async (taskId: string, body: string) => {
    const attempt = ++commentAttemptCounter.current;
    latestCommentAttempts.current.set(taskId, attempt);
    return Boolean(await runMutation(async () => {
      await commentMutation.mutateAsync({ taskId, body, idempotencyKey: mutationKey("desktop-comment-task") });
      return true;
    }, { isCurrent: () => liveSelectedTaskId.current === taskId && latestCommentAttempts.current.get(taskId) === attempt }));
  };

  const retryConflictDraft = async () => {
    if (!conflict?.latestLoaded || !conflict.currentVersion || conflict.scopeKey !== scopeKey) return;
    const bufferedDraft = editDrafts[conflict.taskId];
    if (!bufferedDraft) {
      setConflict(null);
      return;
    }
    await saveTask(conflict.taskId, {
      title: bufferedDraft.title,
      description: bufferedDraft.description,
      expectedVersion: conflict.currentVersion,
      idempotencyKey: mutationKey("desktop-retry-update-task"),
    });
  };

  let content: React.ReactNode;
  if (!scope) content = <TaskShellContent state={{ kind: "error", message: t("tasks.sign_in_required"), onRetry: props.onOpenAccount }} />;
  else if (section === "activity") content = <TaskShellContent state={{ kind: "empty" }} />;
  else if (tasksQuery.isLoading) content = <TaskShellContent state={{ kind: "loading" }} />;
  else if (tasksQuery.isError) content = <TaskShellContent state={{ kind: "error", message: tasksQuery.error instanceof Error ? tasksQuery.error.message : undefined, onRetry: () => void tasksQuery.refetch() }} />;
  else if (section === "assigned") content = <TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={availableMembers} lists={activeListsQuery.data?.items ?? []} listJoinError={activeListsQuery.isError ? (activeListsQuery.error instanceof Error ? activeListsQuery.error.message : t("tasks.list_join_error")) : null} memberDirectoryError={membersQuery.isError ? (membersQuery.error instanceof Error ? membersQuery.error.message : t("tasks.member_directory_error")) : null} settings={workbenchSettings} selectedTaskId={selectedTaskId} canLoadMore={Boolean(tasksQuery.hasNextPage)} loadingMore={tasksQuery.isFetchingNextPage} refreshing={tasksQuery.isFetching && !tasksQuery.isFetchingNextPage} quickCreatePending={createMutation.isPending} quickCreateMemberId={currentMemberId} onLoadMore={() => void tasksQuery.fetchNextPage()} onRetryListJoin={() => void activeListsQuery.refetch()} onRetryMemberDirectory={() => void membersQuery.refetch()} onSettingsChange={updateWorkbenchSettings} onSelect={selectTask} onTransition={(task, operation) => void transitionWorkbenchTask(task, operation)} onQuickCreate={async (title, defaults) => Boolean(await runMutation(() => createMutation.mutateAsync({ title, ...defaults, visibility: "private", priority: "none", members: currentMemberId ? [{ memberId: currentMemberId, role: "assignee" }] : [], idempotencyKey: mutationKey("desktop-quick-create-task") })))} />;
  else content = <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelect={selectTask} canLoadMore={Boolean(tasksQuery.hasNextPage)} loadingMore={tasksQuery.isFetchingNextPage} onLoadMore={() => void tasksQuery.fetchNextPage()} />;

  return (
    <TaskPageFrame {...props} section={section} onSectionChange={(next) => { selectSection(next); setSelectedListId(null); selectTask(null); }} filters={{ priority, setPriority, sort, setSort }} lists={activeListsQuery.data?.items ?? []} selectedListId={selectedListId} onSelectList={(listId) => { selectSection("all"); setSelectedListId(listId); selectTask(null); }} onCreateList={() => setShowCreateList(true)} onArchiveList={(listId, version) => void runMutation(() => listMutations.transition.mutateAsync({ listId, operation: "archive", expectedVersion: version, idempotencyKey: mutationKey("desktop-archive-list") }))}
      onCreateTask={() => setShowFullCreate(true)} onCreateTaskList={() => setShowCreateList(true)}>
      {conflict ? <ConflictBanner conflict={conflict} pending={updateMutation.isPending} onDismiss={dismissConflict} onReload={() => void loadLatestForConflict()} onRetry={() => void retryConflictDraft()} /> : null}
      {content}
      {selectedTaskId ? <TaskDetail key={`${scopeKey}:${selectedTaskId}`} result={detailQuery.data} activity={activityQuery.data} reminders={remindersQuery.data ?? []} loading={detailQuery.isLoading} error={detailQuery.isError} savePending={updateMutation.isPending} preservedDraft={editDrafts[selectedTaskId] ?? null} onDraftChange={updateBufferedDraft} onClose={closeTask} onSave={saveTask} onComment={addComment} onSetReminder={(scheduledAt) => void runMutation(() => reminderMutations.set.mutateAsync({ idempotencyKey: mutationKey("desktop-set-reminder"), mode: "absolute", scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }))} onCancelReminder={() => void runMutation(() => reminderMutations.cancel.mutateAsync(mutationKey("desktop-cancel-reminder")))} onTransition={(task, operation) => void runMutation(() => transitionMutation.mutateAsync({ taskId: task.id, operation, expectedVersion: task.version, idempotencyKey: mutationKey(`desktop-${operation}-task`) }))} /> : null}
      {showFullCreate ? <TaskCreateDialog pending={createMutation.isPending} members={availableMembers} memberDirectoryLoading={membersQuery.isLoading && !fallbackMember} memberDirectoryError={membersQuery.isError ? (membersQuery.error instanceof Error ? membersQuery.error.message : t("tasks.member_directory_error")) : null} onRetryMemberDirectory={() => void membersQuery.refetch()} lists={activeListsQuery.data?.items ?? []} currentMemberId={currentMemberId} defaultAssigneeRequired={section === "assigned"} defaultAssigneeMemberId={section === "assigned" ? currentMemberId : null} defaultListId={selectedListId} onClose={() => setShowFullCreate(false)} onCreate={async (input) => { const result = await runMutation(() => createMutation.mutateAsync({ ...input, idempotencyKey: mutationKey("desktop-create-task") })); if (!result) return; setShowFullCreate(false); selectTask(result.task.id); }} /> : null}
      {showCreateList ? <TaskListCreateDialog pending={listMutations.create.isPending} onClose={() => setShowCreateList(false)} onCreate={async (input) => { const result = await runMutation(() => listMutations.create.mutateAsync({ ...input, idempotencyKey: mutationKey("desktop-create-list"), visibility: "private" })); if (result) setShowCreateList(false); }} /> : null}
    </TaskPageFrame>
  );
}

function TaskPageFrame(props: TaskPageProps & { children: React.ReactNode; section?: TaskSection; onSectionChange?: (section: TaskSection) => void; filters?: { priority: string; setPriority: (value: "" | "low" | "medium" | "high") => void; sort: string; setSort: (value: "updated_at" | "due_at" | "created_at" | "priority") => void }; lists?: Array<{ id: string; name: string; marker: string; version: number }>; selectedListId?: string | null; onSelectList?: (id: string) => void; onCreateList?: () => void; onArchiveList?: (id: string, version: number) => void; onCreateTask?: () => void; onCreateTaskList?: () => void }) {
  const navigate = useNavigate();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = { "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth), WebkitAppRegion: "drag" } as CSSProperties;
  const activeSection = props.section ?? "today";
  const heading = taskSectionHeading(activeSection);
  const sidebarRegistration = React.useMemo<TasksSidebarRegistration>(() => ({
    section: activeSection,
    onSectionChange: props.onSectionChange,
    lists: props.lists,
    selectedListId: props.selectedListId,
    onSelectList: props.onSelectList,
    onCreateList: props.onCreateList,
    onArchiveList: props.onArchiveList,
  }), [activeSection, props.lists, props.onArchiveList, props.onCreateList, props.onSectionChange, props.onSelectList, props.selectedListId]);
  usePublishTasksSidebar(sidebarRegistration);
  return <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-dls-sidebar mac:titlebar-drag" style={pageStyle}>
    <AppNavigationRail workspaceId={props.workspaceId} onOpenAccount={props.onOpenAccount} onOpenHome={() => navigate(props.sessionPath)} onOpenApps={props.onOpenApps} onOpenChat={props.onOpenChat} onOpenReviews={props.onOpenReviews} onOpenSettings={props.onOpenSettings} onOpenTaskSearch={props.onOpenTaskSearch} onOpenCreateWorkspace={props.onOpenCreateWorkspace} />
    <AppSecondarySidebarTopControls sidebarOpen={sidebarOpen} onOpenTaskSearch={props.onOpenTaskSearch ?? (() => undefined)} onToggleSidebar={toggleSidebar} />
    <AppInsetSurface testId="tasks-inset-surface"><div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className={`h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-linear ${sidebarOpen ? "w-[var(--jugglework-left-sidebar-width)]" : "w-0"}`} data-app-secondary-sidebar-frame>
        {sidebarOpen ? <TasksSidebar {...sidebarRegistration} /> : null}
      </div>
      {sidebarOpen ? <AppSecondarySidebarResizeHandle resizing={leftSidebarResizing} onPointerDown={startLeftSidebarResize} /> : null}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="tasks-main">
        <div className={`flex h-[54px] shrink-0 items-center justify-between px-7 ${activeSection === "assigned" ? "" : "border-b border-dls-border"}`}><h2 className="text-[17px] font-semibold tracking-[-0.01em] text-dls-text">{t(heading)}</h2><div className="flex items-center gap-2">{props.filters && activeSection !== "activity" && activeSection !== "assigned" ? <><select aria-label={t("tasks.priority_filter")} value={props.filters.priority} onChange={(event) => props.filters?.setPriority(event.target.value as "" | "low" | "medium" | "high")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="">{t("tasks.all_priorities")}</option><option value="low">{t("tasks.priority_low")}</option><option value="medium">{t("tasks.priority_medium")}</option><option value="high">{t("tasks.priority_high")}</option></select><select aria-label={t("tasks.sort")} value={props.filters.sort} onChange={(event) => props.filters?.setSort(event.target.value as "updated_at" | "due_at" | "created_at" | "priority")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="updated_at">{t("tasks.sort_updated")}</option><option value="due_at">{t("tasks.sort_due")}</option><option value="created_at">{t("tasks.sort_created")}</option><option value="priority">{t("tasks.sort_priority")}</option></select></> : null}{activeSection === "assigned" ? <TaskCreateMenu onCreateTask={props.onCreateTask} onCreateList={props.onCreateTaskList} /> : props.onCreateTask ? <Button size="sm" onClick={props.onCreateTask}><Plus className="size-4" />{t("tasks.create")}</Button> : null}</div></div>
        <div className={`flex min-h-0 flex-1 items-center justify-center overflow-auto ${activeSection === "assigned" ? "p-0" : "p-6"}`}>{props.children}</div>
      </main>
    </div></AppInsetSurface>
  </div>;
}

function TaskCreateMenu(props: { onCreateTask?: () => void; onCreateList?: () => void }) {
  return <div className="mac:titlebar-no-drag" data-testid="task-create-menu"><DropdownMenu><DropdownMenuTrigger render={<Button type="button" size="sm" className="h-9 rounded-lg bg-blue-9 px-3.5 text-[13px] font-medium text-white shadow-none hover:bg-blue-10" />}><Plus className="size-4" />{t("tasks.new")}<ChevronDown className="size-3" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-44 rounded-xl border border-dls-border bg-dls-surface p-1.5 shadow-xl"><DropdownMenuItem onClick={props.onCreateTask} className="rounded-lg px-3 py-2 text-sm font-normal">{t("tasks.new_task")}</DropdownMenuItem><DropdownMenuItem onClick={props.onCreateList} className="rounded-lg px-3 py-2 text-sm font-normal">{t("tasks.new_task_list")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>;
}

function TaskList(props: { tasks: DenProductTask[]; selectedTaskId: string | null; onSelect: (id: string) => void; canLoadMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  if (!props.tasks.length) return <TaskShellContent state={{ kind: "empty" }} />;
  return <div className="w-full self-start space-y-2" role="list">{props.tasks.map((task) => <div role="listitem" key={task.id} className={`flex items-center gap-3 rounded-lg border p-3 ${props.selectedTaskId === task.id ? "border-dls-accent bg-dls-active" : "border-dls-border"}`}>
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full border border-dls-border">{task.status === "completed" ? <Check className="size-4" /> : null}</span>
    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => props.onSelect(task.id)}><div className={`truncate font-medium text-dls-text ${task.status === "completed" ? "line-through" : ""}`}>{task.title}</div><div className="mt-1 flex gap-3 text-xs text-dls-secondary"><span>{t(`tasks.priority_${task.priority}`)}</span>{task.dueAt ? <span>{new Date(task.dueAt).toLocaleString()}</span> : null}</div></button>
  </div>)}{props.canLoadMore ? <Button variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? t("tasks.loading") : t("tasks.load_more")}</Button> : null}</div>;
}

function TaskDetail(props: { result: ReturnType<typeof useProductTask>["data"]; activity: ReturnType<typeof useProductTaskActivity>["data"]; reminders: Array<{ scheduledAt: string; state: string }>; loading: boolean; error: boolean; savePending: boolean; preservedDraft: ProductTaskEditDraft | null; onDraftChange: (draft: ProductTaskEditDraft) => void; onClose: () => void; onSave: (id: string, patch: { expectedVersion: number; idempotencyKey: string; title: string; description: string }) => Promise<void>; onComment: (taskId: string, body: string) => Promise<boolean>; onSetReminder: (scheduledAt: string) => void; onCancelReminder: () => void; onTransition: (task: DenProductTask, operation: "complete" | "cancel" | "reopen" | "restore") => void }) {
  const task = props.result?.task;
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [commentPending, setCommentPending] = React.useState(false);
  const commentAttempt = React.useRef(0);
  React.useEffect(() => {
    if (!task) return;
    const draft = reapplyProductTaskDraft(task, props.preservedDraft);
    setTitle(draft.title);
    setDescription(draft.description);
  }, [props.preservedDraft?.description, props.preservedDraft?.taskId, props.preservedDraft?.title, task?.description, task?.id, task?.title, task?.version]);
  return <aside className="absolute inset-y-0 right-0 z-10 w-[min(480px,90%)] border-l border-dls-border bg-dls-surface p-5 shadow-xl" aria-label={t("tasks.detail")}>
    <div className="mb-5 flex items-center justify-between"><h3 className="font-semibold text-dls-text">{t("tasks.detail")}</h3><Button variant="ghost" size="icon" onClick={props.onClose}><X className="size-4" /></Button></div>
    {props.loading ? <TaskShellContent state={{ kind: "loading" }} /> : props.error || !task ? <TaskShellContent state={{ kind: "error", onRetry: () => undefined }} /> : <div className="space-y-4"><Input value={title} readOnly={!props.result?.permissions.canEditContent} onChange={(event) => { const value = event.target.value; setTitle(value); if (props.preservedDraft) props.onDraftChange({ ...props.preservedDraft, title: value, description }); }} /><Textarea value={description} readOnly={!props.result?.permissions.canEditContent} onChange={(event) => { const value = event.target.value; setDescription(value); if (props.preservedDraft) props.onDraftChange({ ...props.preservedDraft, title, description: value }); }} />
      <div className="text-sm text-dls-secondary">{t("tasks.assignees")}: {props.result?.members.filter((member) => member.role === "assignee").map((member) => member.memberId).join(", ") || t("tasks.unassigned")}</div>
      <div className="space-y-1 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.activity")}</div>{props.activity?.events.length ? props.activity.events.map((event) => <div key={event.id}>{event.eventType} · {new Date(event.createdAt).toLocaleString()}</div>) : t("tasks.activity_empty")}</div>
      <div className="space-y-2 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.comments")}</div>{props.activity?.comments.length ? props.activity.comments.map((item) => <div key={item.id} className="rounded border border-dls-border p-2">{item.body}</div>) : t("tasks.comments_empty")}{props.result?.permissions.canComment ? <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); const body = comment.trim(); if (!body || commentPending) return; const attempt = ++commentAttempt.current; setCommentPending(true); void props.onComment(task.id, body).then((saved) => { if (commentAttempt.current !== attempt) return; setCommentPending(false); if (saved) setComment((current) => current.trim() === body ? "" : current); }); }}><Input value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t("tasks.add_comment")} /><Button type="submit" disabled={!comment.trim() || commentPending}>{t("tasks.add")}</Button></form> : null}</div>
      <div className="space-y-2 text-sm text-dls-secondary"><div className="font-medium text-dls-text">{t("tasks.reminder")}</div>{props.reminders.find((item) => item.state === "scheduled") ? <div className="flex items-center justify-between"><span>{new Date(props.reminders.find((item) => item.state === "scheduled")!.scheduledAt).toLocaleString()}</span><Button size="sm" variant="outline" onClick={props.onCancelReminder}>{t("tasks.remove_reminder")}</Button></div> : props.result?.permissions.canEditTime ? <input type="datetime-local" aria-label={t("tasks.reminder")} className="rounded border border-dls-border bg-dls-surface p-2" onChange={(event) => { if (event.target.value) props.onSetReminder(new Date(event.target.value).toISOString()); }} /> : t("tasks.no_reminder")}</div>
      <div className="flex flex-wrap gap-2">{props.result?.permissions.canEditContent ? <Button disabled={!title.trim() || props.savePending} onClick={() => void props.onSave(task.id, { expectedVersion: task.version, idempotencyKey: mutationKey("desktop-update-task"), title: title.trim(), description })}>{t("tasks.save")}</Button> : null}
      {task.status === "todo" && props.result?.permissions.canComplete ? <Button onClick={() => { const assignees = props.result?.members.filter((member) => member.role === "assignee").length ?? 0; if (assignees <= 1 || globalThis.confirm(t("tasks.complete_multi_confirm"))) props.onTransition(task, "complete"); }}>{t("tasks.complete")}</Button> : null}
      {task.status !== "todo" && props.result?.permissions.canReopen ? <Button variant="outline" onClick={() => props.onTransition(task, "reopen")}>{t("tasks.reopen")}</Button> : null}
      {task.status === "todo" && props.result?.permissions.canCancel ? <Button variant="outline" onClick={() => props.onTransition(task, "cancel")}>{t("tasks.cancel_task")}</Button> : null}</div>
    </div>}
  </aside>;
}

function memberLabel(member: DenOrganizationMember) {
  return member.user.name?.trim() || member.user.account?.trim() || member.user.email?.trim() || member.id;
}

function dateTimeInputToIso(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function TaskCreateDialog(props: { pending: boolean; members: DenOrganizationMember[]; memberDirectoryLoading: boolean; memberDirectoryError: string | null; onRetryMemberDirectory: () => void; lists: DenProductTaskList[]; currentMemberId: string | null; defaultAssigneeRequired: boolean; defaultAssigneeMemberId: string | null; defaultListId: string | null; onClose: () => void; onCreate: (input: Omit<DenProductTaskCreateInput, "idempotencyKey">) => Promise<void> }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [assigneeIds, setAssigneeIds] = React.useState<string[]>(() => props.defaultAssigneeMemberId ? [props.defaultAssigneeMemberId] : []);
  const [startAt, setStartAt] = React.useState("");
  const [dueAt, setDueAt] = React.useState("");
  const [priority, setPriority] = React.useState<"none" | "low" | "medium" | "high">("none");
  const [visibility, setVisibility] = React.useState<DenProductTaskVisibility>("private");
  const [listId, setListId] = React.useState(props.defaultListId ?? "");
  const assigneesTouched = React.useRef(false);
  const defaultAssigneeApplied = React.useRef(Boolean(props.defaultAssigneeMemberId));
  React.useEffect(() => {
    if (!props.defaultAssigneeMemberId || assigneesTouched.current || defaultAssigneeApplied.current) return;
    defaultAssigneeApplied.current = true;
    setAssigneeIds([props.defaultAssigneeMemberId]);
  }, [props.defaultAssigneeMemberId]);
  const privateAssignmentInvalid = visibility === "private" && assigneeIds.some((id) => id !== props.currentMemberId);
  const defaultAssigneePending = props.defaultAssigneeRequired && props.memberDirectoryLoading && !props.currentMemberId;
  const toggleAssignee = (memberId: string, checked: boolean) => {
    assigneesTouched.current = true;
    setAssigneeIds((current) => checked ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId));
    if (checked && memberId !== props.currentMemberId && visibility === "private") setVisibility("members");
  };
  const setQuickDueDate = (dayOffset: number) => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(18, 0, 0, 0);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setDueAt(local);
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !props.pending) props.onClose(); }}><DialogContent data-testid="task-create-dialog" className="h-[min(760px,calc(100vh-2rem))] w-[min(900px,calc(100%-2rem))] max-w-none gap-0 overflow-hidden rounded-2xl bg-dls-surface p-0 sm:max-w-[900px]" aria-label={t("tasks.create")} showCloseButton={!props.pending}><DialogHeader className="sr-only"><DialogTitle>{t("tasks.create")}</DialogTitle><DialogDescription>{t("tasks.create_description")}</DialogDescription></DialogHeader><form className="flex min-h-0 flex-1 flex-col px-10 pb-6 pt-16" onSubmit={(event) => { event.preventDefault(); if (!title.trim() || privateAssignmentInvalid || defaultAssigneePending) return; void props.onCreate({ title: title.trim(), description, visibility, priority, startAt: dateTimeInputToIso(startAt), dueAt: dateTimeInputToIso(dueAt), listId: listId || undefined, members: assigneeIds.map((memberId) => ({ memberId, role: "assignee" })) }); }}>
    <Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("tasks.title_placeholder")} className="h-auto border-0 bg-transparent px-0 py-2 !text-2xl font-semibold shadow-none placeholder:text-dls-secondary/65 focus-visible:ring-0" />

    <div className="mt-6 flex min-h-11 items-start gap-5"><UserRound className="mt-2 size-5 shrink-0 text-dls-secondary" /><fieldset className="min-w-0 flex-1"><legend className="sr-only">{t("tasks.assignees")}</legend>{props.memberDirectoryError ? <div className="flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 px-3 py-2 text-sm" role="alert"><span className="flex-1">{t("tasks.member_directory_error")}</span><Button type="button" variant="outline" size="sm" onClick={props.onRetryMemberDirectory}>{t("tasks.retry")}</Button></div> : props.memberDirectoryLoading ? <p className="py-2 text-sm text-dls-secondary" role="status">{t("tasks.loading")}</p> : props.members.length ? <div className="flex max-h-28 flex-wrap gap-2 overflow-y-auto">{props.members.map((member) => { const selected = assigneeIds.includes(member.id); return <label key={member.id} className={`flex cursor-pointer items-center gap-2 rounded-full px-2 py-1.5 text-sm transition-colors ${selected ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover"}`}><Checkbox className="sr-only" checked={selected} onCheckedChange={(checked) => toggleAssignee(member.id, checked === true)} /><Avatar size="sm"><AvatarImage src={member.user.avatar ?? undefined} alt="" /><AvatarFallback>{memberLabel(member).slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="max-w-36 truncate">{memberLabel(member)}</span></label>; })}</div> : <p className="py-2 text-sm text-dls-secondary">{t("tasks.no_members")}</p>}</fieldset></div>

    <div className="mt-5 flex items-start gap-5"><CalendarDays className="mt-2 size-5 shrink-0 text-dls-secondary" /><div className="min-w-0 flex-1 space-y-3"><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" size="sm" onClick={() => setQuickDueDate(0)}>{t("tasks.today")}</Button><Button type="button" variant="secondary" size="sm" onClick={() => setQuickDueDate(1)}>{t("tasks.tomorrow")}</Button></div><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs text-dls-secondary"><span>{t("tasks.field_start")}</span><Input aria-label={t("tasks.field_start")} type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="h-9" /></label><label className="grid gap-1 text-xs text-dls-secondary"><span>{t("tasks.field_due")}</span><Input aria-label={t("tasks.field_due")} type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className="h-9" /></label></div></div></div>

    <label className="mt-5 flex items-center gap-5"><ListTodo className="size-5 shrink-0 text-dls-secondary" /><select aria-label={t("tasks.field_list")} className="h-10 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-0 text-sm text-dls-secondary outline-none hover:text-dls-text" value={listId} onChange={(event) => setListId(event.target.value)}><option value="">{t("tasks.add_to_list")}</option>{props.lists.map((list) => <option key={list.id} value={list.id}>{list.marker} {list.name}</option>)}</select></label>

    <label className="mt-4 flex min-h-0 flex-1 items-start gap-5"><AlignLeft className="mt-2 size-5 shrink-0 text-dls-secondary" /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("tasks.add_description")} className="min-h-24 flex-1 resize-none border-0 bg-transparent px-0 py-2 text-base shadow-none focus-visible:ring-0" /></label>

    {privateAssignmentInvalid ? <p className="mb-3 text-sm text-red-9" role="alert">{t("tasks.private_assignee_error")}</p> : null}
    <DialogFooter className="mx-0 mb-0 mt-auto flex-row items-center justify-between rounded-none border-0 bg-transparent p-0 pt-4"><div className="flex min-w-0 flex-wrap gap-2"><select aria-label={t("tasks.priority")} className="h-9 rounded-lg border border-dls-border bg-dls-surface px-3 text-sm" value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}>{(["none", "low", "medium", "high"] as const).map((value) => <option key={value} value={value}>{t(`tasks.priority_${value}`)}</option>)}</select><select aria-label={t("tasks.visibility")} className="h-9 rounded-lg border border-dls-border bg-dls-surface px-3 text-sm" value={visibility} onChange={(event) => setVisibility(event.target.value as DenProductTaskVisibility)}><option value="private">{t("tasks.visibility_private")}</option><option value="members">{t("tasks.visibility_members")}</option><option value="organization">{t("tasks.visibility_organization")}</option></select></div><div className="flex gap-2"><Button type="button" variant="outline" disabled={props.pending} onClick={props.onClose}>{t("tasks.cancel")}</Button><Button type="submit" disabled={!title.trim() || privateAssignmentInvalid || defaultAssigneePending || props.pending}>{t("tasks.create")}</Button></div></DialogFooter>
  </form></DialogContent></Dialog>;
}

function TaskListCreateDialog(props: { pending: boolean; onClose: () => void; onCreate: (input: { name: string; description: string; marker: string }) => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [marker, setMarker] = React.useState("#");
  return <Dialog open onOpenChange={(open) => { if (!open && !props.pending) props.onClose(); }}><DialogContent aria-label={t("tasks.new_task_list")} showCloseButton={!props.pending}><DialogHeader><DialogTitle>{t("tasks.new_task_list")}</DialogTitle><DialogDescription>{t("tasks.private_visibility")}</DialogDescription></DialogHeader><form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void props.onCreate({ name: name.trim(), description, marker: marker.trim() || "#" }); }}><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t("tasks.list_name")} /><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("tasks.description_field")} /><Input value={marker} onChange={(event) => setMarker(event.target.value)} placeholder={t("tasks.marker")} maxLength={16} /><DialogFooter><Button type="button" variant="outline" disabled={props.pending} onClick={props.onClose}>{t("tasks.cancel")}</Button><Button type="submit" disabled={!name.trim() || props.pending}>{t("tasks.create_list")}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ConflictBanner(props: { conflict: ProductTaskConflict; pending: boolean; onDismiss: () => void; onReload: () => void; onRetry: () => void }) {
  return <div className="absolute left-4 right-4 top-16 z-30 flex items-center gap-3 rounded-lg border border-amber-7 bg-amber-2 p-3 text-sm" role="alert"><CircleAlert className="size-4" /><span className="flex-1">{t("tasks.conflict")}</span>{props.conflict.latestLoaded ? <Button size="sm" variant="outline" disabled={props.pending} onClick={props.onRetry}>{t("tasks.retry")}</Button> : <Button size="sm" variant="outline" onClick={props.onReload}>{t("tasks.load_latest")}</Button>}<Button size="sm" variant="ghost" onClick={props.onDismiss}>{t("tasks.dismiss")}</Button></div>;
}

export function TaskShellContent({ state }: { state: TaskShellState }) {
  if (state.kind === "loading") return <div className="flex flex-col items-center gap-3 text-center text-dls-secondary" role="status" aria-live="polite"><LoaderCircle className="size-6 animate-spin" /><p className="text-sm">{t("tasks.loading")}</p></div>;
  if (state.kind === "error") return <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert"><CircleAlert className="size-8 text-red-9" /><div><h3 className="font-medium text-dls-text">{t("tasks.error_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{state.message ?? t("tasks.error_description")}</p></div><Button variant="outline" size="sm" onClick={state.onRetry}><RefreshCw className="size-4" />{t("tasks.retry")}</Button></div>;
  return <div className="flex max-w-sm flex-col items-center gap-3 text-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-dls-active text-dls-accent"><ListChecks className="size-6" /></div><div><h3 className="font-medium text-dls-text">{t("tasks.empty_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{t("tasks.empty_description")}</p></div></div>;
}

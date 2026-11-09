/** @jsxImportSource react */
import * as React from "react";
import type { CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlignLeft, ArrowUp, AtSign, Bold, Bookmark, BookmarkCheck, BookmarkPlus, CalendarDays, Check, ChevronDown, CircleAlert, ImageIcon, Italic, Link, List as ListIcon, ListChecks, ListOrdered, ListTodo, LoaderCircle, MoreHorizontal, Plus, Quote, RefreshCw, Smile, Strikethrough, Underline, UserRound, X } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { DenApiError, isPersonalDenOrganization, type DenOrganizationMember, type DenProductTask, type DenProductTaskCompletionPolicy, type DenProductTaskCreateInput, type DenProductTaskList, type DenProductTaskUpdateInput, type DenProductTaskVisibility } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { TaskDateTimeCell, type TaskReminderDraft, type TaskTimeField } from "./task-date-time-cell";
import { TaskListCell } from "./task-list-table";
import { isTaskWorkbenchSection, readTaskWorkbenchSettings, taskSectionDefaultSettings, writeTaskWorkbenchSettings, type TaskWorkbenchSection, type TaskWorkbenchSettings } from "./task-view-state";
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
  const initialSection = React.useMemo(() => readTaskSection(scope), [scopeKey]);
  const [section, setSection] = React.useState<TaskSection>(initialSection);
  const [priority, setPriority] = React.useState<"" | "low" | "medium" | "high">("");
  const [sort, setSort] = React.useState<"updated_at" | "due_at" | "created_at" | "priority">("updated_at");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(props.routeTaskId ?? null);
  const [selectedListId, setSelectedListId] = React.useState<string | null>(null);
  const [showFullCreate, setShowFullCreate] = React.useState(false);
  const [showCreateList, setShowCreateList] = React.useState(false);
  const [workbenchSettings, setWorkbenchSettings] = React.useState<TaskWorkbenchSettings>(() => readTaskWorkbenchSettings(scope, isTaskWorkbenchSection(initialSection) ? initialSection : "assigned"));
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
  React.useEffect(() => {
    liveScopeKey.current = scopeKey;
    return () => { liveScopeKey.current = ""; };
  }, [scopeKey]);
  const fallbackMember = React.useMemo(() => {
    const memberId = cloud.activeOrganization?.orgMemberId || cloud.activeOrganization?.membershipId;
    return memberId && cloud.user ? { id: memberId, userId: cloud.user.id, role: cloud.activeOrganization?.role ?? "member", user: { id: cloud.user.id, name: cloud.user.name, account: cloud.user.account ?? null, email: cloud.user.email ?? null, avatar: cloud.user.avatar ?? null } } : null;
  }, [cloud.activeOrganization?.membershipId, cloud.activeOrganization?.orgMemberId, cloud.activeOrganization?.role, cloud.user]);
  const membersQuery = useOrganizationMembers({ client: cloud.client, scope, fallback: fallbackMember, allowUnavailableFallback: isPersonalDenOrganization(cloud.activeOrganization), active: isTaskWorkbenchSection(section) || showFullCreate || Boolean(selectedTaskId) });
  const availableMembers = membersQuery.data ?? (fallbackMember ? [fallbackMember] : []);
  const currentMemberId = fallbackMember?.id ?? availableMembers.find((member) => member.userId === cloud.user?.id)?.id ?? null;
  const workbenchSection = isTaskWorkbenchSection(section) ? section : null;
  const memberFilteredSection = workbenchSection !== null && workbenchSection !== "all" && workbenchSection !== "completed";
  const sectionSettings = (nextSection: TaskWorkbenchSection, listId?: string | null) => listId
    ? readTaskWorkbenchSettings(scope, "all", listId)
    : taskSectionDefaultSettings(nextSection, currentMemberId, readTaskWorkbenchSettings(scope, nextSection));
  const listOptions = React.useMemo(() => {
    if (section === "activity") return { view: "all" as const };
    if (workbenchSection) {
      return {
        view: "all" as const,
        status: taskWorkbenchStatuses(workbenchSettings),
        priority: workbenchSettings.priorities.length ? workbenchSettings.priorities : undefined,
        listId: selectedListId ? [selectedListId] : workbenchSettings.listIds.length ? workbenchSettings.listIds : undefined,
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
  }, [priority, section, selectedListId, sort, workbenchSection, workbenchSettings]);
  const tasksQuery = useProductTasks({ client: cloud.client, scope, options: listOptions, active: section !== "activity" && (!memberFilteredSection || Boolean(currentMemberId)) });
  const activeListsQuery = useProductTaskLists({ client: cloud.client, scope, archived: false });
  const selectedTaskList = selectedListId ? (activeListsQuery.data?.items ?? []).find((list) => list.id === selectedListId) ?? null : null;
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
    const nextSection = readTaskSection(scope);
    if (isTaskWorkbenchSection(nextSection)) setWorkbenchSettings(sectionSettings(nextSection));
  }, [scopeKey]);
  React.useEffect(() => {
    if (!workbenchSection || !currentMemberId) return;
    setWorkbenchSettings((current) => taskSectionDefaultSettings(workbenchSection, currentMemberId, current));
  }, [currentMemberId, workbenchSection]);
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
    if (isTaskWorkbenchSection(next)) setWorkbenchSettings(sectionSettings(next));
    setSection(next);
  };

  const updateWorkbenchSettings = (next: TaskWorkbenchSettings) => {
    if (!workbenchSection) return;
    writeTaskWorkbenchSettings(scope, next, workbenchSection, selectedListId);
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
    const currentAssigneeCompleted = detail.task.completionPolicy === "all_assignees" && detail.members.some((member) => member.role === "assignee" && member.memberId === currentMemberId && Boolean(member.completedAt));
    if (operation === "complete" && currentAssigneeCompleted) return;
    if (operation === "complete" && detail.task.completionPolicy === "any_assignee" && assigneeCount > 1 && !globalThis.confirm(t("tasks.complete_multi_confirm"))) return;
    await runMutation(() => transitionMutation.mutateAsync({ taskId: task.id, operation, expectedVersion: detail.task.version, idempotencyKey: mutationKey(`desktop-${operation}-task`) }));
  };

  const updateWorkbenchAssignees = async (task: DenProductTask, assigneeMemberIds: string[]) => {
    if (!scope) return false;
    const capturedScope = scope;
    const detail = await runMutation(
      () => cloud.client.getProductTask(capturedScope.organizationId, task.id),
      { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) },
    );
    if (!detail) return false;
    if (!detail.permissions.canManageMembers) {
      toast.error(t("tasks.assignee_edit_not_allowed"));
      return false;
    }
    const addsOtherMemberToPrivateTask = detail.task.visibility === "private" && assigneeMemberIds.some((memberId) => memberId !== detail.task.creatorMemberId);
    if (addsOtherMemberToPrivateTask && (!detail.permissions.canManageVisibility || detail.task.listId)) {
      toast.error(t("tasks.private_assignee_error"));
      return false;
    }
    const retainedMembers = detail.members.filter((member) => member.role !== "assignee").map((member) => ({ memberId: member.memberId, role: member.role }));
    const result = await runMutation(
      () => cloud.client.updateProductTask(capturedScope.organizationId, task.id, {
        expectedVersion: detail.task.version,
        idempotencyKey: mutationKey("desktop-update-task-assignees"),
        ...(addsOtherMemberToPrivateTask ? { visibility: "members" as const } : {}),
        members: [...retainedMembers, ...assigneeMemberIds.map((memberId) => ({ memberId, role: "assignee" as const }))],
      }),
      { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) },
    );
    if (!result) return false;
    queryClient.setQueryData(productTaskKeys.detail(capturedScope, task.id), result);
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(capturedScope) });
    return true;
  };

  const updateWorkbenchCompletionPolicy = async (task: DenProductTask, completionPolicy: DenProductTaskCompletionPolicy) => {
    if (!scope) return false;
    const capturedScope = scope;
    const detail = await runMutation(
      () => cloud.client.getProductTask(capturedScope.organizationId, task.id),
      { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) },
    );
    if (!detail) return false;
    if (!detail.permissions.canManageMembers) {
      toast.error(t("tasks.assignee_edit_not_allowed"));
      return false;
    }
    const result = await runMutation(
      () => cloud.client.updateProductTask(capturedScope.organizationId, task.id, {
        expectedVersion: detail.task.version,
        idempotencyKey: mutationKey("desktop-update-task-completion-policy"),
        completionPolicy,
      }),
      { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) },
    );
    if (!result) return false;
    queryClient.setQueryData(productTaskKeys.detail(capturedScope, task.id), result);
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(capturedScope) });
    return true;
  };

  const updateWorkbenchTime = async (task: DenProductTask, field: TaskTimeField, value: string | null) => {
    if (!scope) return false;
    const capturedScope = scope;
    const detail = await runMutation(() => cloud.client.getProductTask(capturedScope.organizationId, task.id), { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) });
    if (!detail) return false;
    if (!detail.permissions.canEditTime) { toast.error(t("tasks.time_edit_not_allowed")); return false; }
    const result = await runMutation(() => cloud.client.updateProductTask(capturedScope.organizationId, task.id, {
      expectedVersion: detail.task.version,
      idempotencyKey: mutationKey(`desktop-update-task-${field === "startAt" ? "start" : "due"}`),
      [field]: value,
    }), { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) });
    if (!result) return false;
    queryClient.setQueryData(productTaskKeys.detail(capturedScope, task.id), result);
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(capturedScope) });
    return true;
  };

  const loadWorkbenchReminders = async (task: DenProductTask) => {
    if (!scope) return [];
    return await runMutation(() => cloud.client.listProductTaskReminders(scope.organizationId, task.id)) ?? [];
  };

  const updateWorkbenchReminder = async (task: DenProductTask, reminder: TaskReminderDraft) => {
    if (!scope) return false;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = reminder
      ? await runMutation(async () => { await cloud.client.setProductTaskReminder(scope.organizationId, task.id, { idempotencyKey: mutationKey("desktop-set-workbench-reminder"), timezone, ...reminder }); return true; })
      : await runMutation(async () => { await cloud.client.cancelProductTaskReminders(scope.organizationId, task.id, mutationKey("desktop-cancel-workbench-reminder")); return true; });
    return result === true;
  };

  const moveWorkbenchTaskToList = async (task: DenProductTask, destinationListId: string) => {
    if (!scope) return false;
    const capturedScope = scope;
    const isCurrent = () => liveScopeKey.current === productTaskScopeKey(capturedScope);
    const detail = await runMutation(() => cloud.client.getProductTask(capturedScope.organizationId, task.id), { isCurrent });
    if (!detail) return false;
    if (!detail.permissions.canManageMembers) { toast.error(t("tasks.list_edit_not_allowed")); return false; }
    // The picker cache may be stale (or not yet contain an inline-created list).
    const destination = destinationListId
      ? await runMutation(() => cloud.client.getProductTaskList(capturedScope.organizationId, destinationListId), { isCurrent })
      : null;
    if (!isCurrent() || (destinationListId && !destination)) return false;
    if (destination && (!destination.permissions.canAddTasks || destination.list.archivedAt)) { toast.error(t("tasks.list_edit_not_allowed")); return false; }
    const requiresSharing = detail.task.visibility === "private" && destination && destination.list.visibility !== "private";
    if (requiresSharing) {
      if (!detail.permissions.canManageVisibility) { toast.error(t("tasks.list_edit_not_allowed")); return false; }
      if (!globalThis.confirm(t("tasks.move_private_to_shared_confirm", { name: destination.list.name }))) return false;
    }
    // Confirmation must never authorize a write from an expired page/scope.
    if (!isCurrent()) return false;
    const result = await runMutation(() => cloud.client.moveProductTask(capturedScope.organizationId, task.id, {
      expectedVersion: detail.task.version,
      idempotencyKey: mutationKey("desktop-move-task-list"),
      destinationListId,
      ...(requiresSharing ? { confirmedVisibility: "members" as const } : {}),
    }), { isCurrent });
    if (!result) return false;
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(capturedScope) });
    return true;
  };

  const createWorkbenchListAndMove = async (task: DenProductTask, name: string) => {
    if (!scope) return null;
    const visibility = task.visibility === "private" ? "private" as const : "members" as const;
    const created = await runMutation(() => listMutations.create.mutateAsync({ idempotencyKey: mutationKey("desktop-create-inline-task-list"), name, description: "", marker: name.slice(0, 1).toUpperCase() || "#", visibility }));
    if (!created) return null;
    const moved = await moveWorkbenchTaskToList(task, created.list.id);
    return moved ? created.list.id : null;
  };

  const updateTaskFollowers = async (task: DenProductTask, followerMemberIds: string[]) => {
    if (!scope) return false;
    const capturedScope = scope;
    const detail = await runMutation(() => cloud.client.getProductTask(capturedScope.organizationId, task.id), { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) });
    if (!detail) return false;
    if (!detail.permissions.canManageMembers) { toast.error(t("tasks.follower_edit_not_allowed")); return false; }
    const retainedMembers = detail.members.filter((member) => member.role !== "follower").map((member) => ({ memberId: member.memberId, role: member.role }));
    const addsOtherMemberToPrivateTask = detail.task.visibility === "private" && followerMemberIds.some((memberId) => memberId !== detail.task.creatorMemberId);
    if (addsOtherMemberToPrivateTask && !detail.permissions.canManageVisibility) { toast.error(t("tasks.follower_edit_not_allowed")); return false; }
    const result = await runMutation(() => cloud.client.updateProductTask(capturedScope.organizationId, task.id, {
      expectedVersion: detail.task.version,
      idempotencyKey: mutationKey("desktop-update-task-followers"),
      ...(addsOtherMemberToPrivateTask ? { visibility: "members" as const } : {}),
      members: [...retainedMembers, ...followerMemberIds.map((memberId) => ({ memberId, role: "follower" as const }))],
    }), { isCurrent: () => liveScopeKey.current === productTaskScopeKey(capturedScope) });
    if (!result) return false;
    queryClient.setQueryData(productTaskKeys.detail(capturedScope, task.id), result);
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(capturedScope) });
    return true;
  };

  const setTaskGroup = (taskId: string, groupId: string) => {
    const customGroupAssignments = { ...workbenchSettings.customGroupAssignments };
    if (groupId === "custom-default") delete customGroupAssignments[taskId];
    else customGroupAssignments[taskId] = groupId;
    updateWorkbenchSettings({ ...workbenchSettings, customGroupAssignments });
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
  else if (workbenchSection) content = <TaskWorkbench key={workbenchSection} tasks={tasks} membersByTaskId={membersByTaskId} members={availableMembers} lists={activeListsQuery.data?.items ?? []} listJoinError={activeListsQuery.isError ? (activeListsQuery.error instanceof Error ? activeListsQuery.error.message : t("tasks.list_join_error")) : null} memberDirectoryError={membersQuery.isError ? (membersQuery.error instanceof Error ? membersQuery.error.message : t("tasks.member_directory_error")) : null} settings={workbenchSettings} selectedTaskId={selectedTaskId} canLoadMore={Boolean(tasksQuery.hasNextPage)} loadingMore={tasksQuery.isFetchingNextPage} refreshing={tasksQuery.isFetching && !tasksQuery.isFetchingNextPage} quickCreatePending={createMutation.isPending} quickCreateMemberId={currentMemberId} onLoadMore={() => void tasksQuery.fetchNextPage()} onRetryListJoin={() => void activeListsQuery.refetch()} onRetryMemberDirectory={() => void membersQuery.refetch()} onSettingsChange={updateWorkbenchSettings} onSelect={selectTask} onTransition={(task, operation) => void transitionWorkbenchTask(task, operation)} onAssigneesChange={updateWorkbenchAssignees} onCompletionPolicyChange={updateWorkbenchCompletionPolicy} onTimeChange={updateWorkbenchTime} onLoadReminders={loadWorkbenchReminders} onReminderChange={updateWorkbenchReminder} onListChange={moveWorkbenchTaskToList} onListCreate={createWorkbenchListAndMove} onQuickCreate={async (title, defaults) => { const result = await runMutation(() => createMutation.mutateAsync({ title, ...defaults, visibility: "private", priority: "none", members: [], idempotencyKey: mutationKey("desktop-quick-create-task") })); return result?.task.id ?? false; }} />;
  else content = <TaskList tasks={tasks} selectedTaskId={selectedTaskId} onSelect={selectTask} canLoadMore={Boolean(tasksQuery.hasNextPage)} loadingMore={tasksQuery.isFetchingNextPage} onLoadMore={() => void tasksQuery.fetchNextPage()} />;

  return (
    <TaskPageFrame {...props} section={section} pageTitle={selectedTaskList?.name ?? null} onSectionChange={(next) => { selectSection(next); setSelectedListId(null); selectTask(null); }} filters={{ priority, setPriority, sort, setSort }} lists={activeListsQuery.data?.items ?? []} selectedListId={selectedListId} onSelectList={(listId) => { setSection("all"); writeTaskSection(scope, "all"); setSelectedListId(listId); setWorkbenchSettings(sectionSettings("all", listId)); selectTask(null); }} onCreateList={() => setShowCreateList(true)} onArchiveList={(listId, version) => void runMutation(() => listMutations.transition.mutateAsync({ listId, operation: "archive", expectedVersion: version, idempotencyKey: mutationKey("desktop-archive-list") }))}
      onCreateTask={() => setShowFullCreate(true)} onCreateTaskList={() => setShowCreateList(true)}>
      {conflict ? <ConflictBanner conflict={conflict} pending={updateMutation.isPending} onDismiss={dismissConflict} onReload={() => void loadLatestForConflict()} onRetry={() => void retryConflictDraft()} /> : null}
      {content}
      {selectedTaskId ? <TaskDetail key={`${scopeKey}:${selectedTaskId}`} result={detailQuery.data} activity={activityQuery.data} reminders={remindersQuery.data ?? []} members={availableMembers} lists={activeListsQuery.data?.items ?? []} groups={workbenchSettings.customGroups} defaultGroupName={workbenchSettings.customGroupName} groupId={workbenchSettings.customGroupAssignments[selectedTaskId] ?? "custom-default"} loading={detailQuery.isLoading} error={detailQuery.isError} currentMemberId={currentMemberId} preservedDraft={editDrafts[selectedTaskId] ?? null} onDraftChange={updateBufferedDraft} onClose={closeTask} onSave={saveTask} onComment={addComment} onFollowersChange={updateTaskFollowers} onListChange={moveWorkbenchTaskToList} onListCreate={createWorkbenchListAndMove} onTimeChange={updateWorkbenchTime} onGroupChange={setTaskGroup} onGroupsChange={(customGroups) => updateWorkbenchSettings({ ...workbenchSettings, customGroups })} onSetReminder={(scheduledAt) => void runMutation(() => reminderMutations.set.mutateAsync({ idempotencyKey: mutationKey("desktop-set-reminder"), mode: "absolute", scheduledAt, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }))} onCancelReminder={() => void runMutation(() => reminderMutations.cancel.mutateAsync(mutationKey("desktop-cancel-reminder")))} onTransition={(task, operation) => void runMutation(() => transitionMutation.mutateAsync({ taskId: task.id, operation, expectedVersion: task.version, idempotencyKey: mutationKey(`desktop-${operation}-task`) }))} /> : null}
      {showFullCreate ? <TaskCreateDialog pending={createMutation.isPending} members={availableMembers} memberDirectoryLoading={membersQuery.isLoading && !fallbackMember} memberDirectoryError={membersQuery.isError ? (membersQuery.error instanceof Error ? membersQuery.error.message : t("tasks.member_directory_error")) : null} onRetryMemberDirectory={() => void membersQuery.refetch()} lists={activeListsQuery.data?.items ?? []} currentMemberId={currentMemberId} defaultListId={selectedListId} groups={workbenchSettings.customGroups} defaultGroupName={workbenchSettings.customGroupName} onGroupsChange={(customGroups) => updateWorkbenchSettings({ ...workbenchSettings, customGroups })} onCreateList={async (name) => { const result = await runMutation(() => listMutations.create.mutateAsync({ idempotencyKey: mutationKey("desktop-create-dialog-list"), name, description: "", marker: name.slice(0, 1).toUpperCase() || "#", visibility: "private" })); return result?.list.id ?? null; }} onClose={() => setShowFullCreate(false)} onCreate={async (input, groupId) => { const result = await runMutation(() => createMutation.mutateAsync({ ...input, idempotencyKey: mutationKey("desktop-create-task") })); if (!result) return; if (groupId && groupId !== "custom-default") updateWorkbenchSettings({ ...workbenchSettings, customGroupAssignments: { ...workbenchSettings.customGroupAssignments, [result.task.id]: groupId } }); setShowFullCreate(false); selectTask(result.task.id); }} /> : null}
      {showCreateList ? <TaskListCreateDialog pending={listMutations.create.isPending} onClose={() => setShowCreateList(false)} onCreate={async (input) => { const result = await runMutation(() => listMutations.create.mutateAsync({ ...input, idempotencyKey: mutationKey("desktop-create-list"), visibility: "private" })); if (result) setShowCreateList(false); }} /> : null}
    </TaskPageFrame>
  );
}

function TaskPageFrame(props: TaskPageProps & { children: React.ReactNode; section?: TaskSection; pageTitle?: string | null; onSectionChange?: (section: TaskSection) => void; filters?: { priority: string; setPriority: (value: "" | "low" | "medium" | "high") => void; sort: string; setSort: (value: "updated_at" | "due_at" | "created_at" | "priority") => void }; lists?: Array<{ id: string; name: string; marker: string; version: number }>; selectedListId?: string | null; onSelectList?: (id: string) => void; onCreateList?: () => void; onArchiveList?: (id: string, version: number) => void; onCreateTask?: () => void; onCreateTaskList?: () => void }) {
  const navigate = useNavigate();
  const sidebarOpen = useUiStateStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStateStore((state) => state.toggleSidebar);
  const { leftSidebarResizing, leftSidebarWidth, startLeftSidebarResize } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  const pageStyle = { "--jugglework-left-sidebar-width": appInsetSidebarCssWidth(leftSidebarWidth), WebkitAppRegion: "drag" } as CSSProperties;
  const activeSection = props.section ?? "today";
  const heading = taskSectionHeading(activeSection);
  const showHeaderFilters = Boolean(props.filters) && activeSection !== "today" && activeSection !== "activity" && !isTaskWorkbenchSection(activeSection);
  const showHeaderCreate = activeSection !== "today" && activeSection !== "activity";
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
        <div className={`flex h-[54px] shrink-0 items-center justify-between px-7 ${isTaskWorkbenchSection(activeSection) ? "" : "border-b border-dls-border"}`}><h2 className="text-[17px] font-semibold tracking-[-0.01em] text-dls-text" data-testid="tasks-page-title">{props.pageTitle ?? t(heading)}</h2><div className="flex items-center gap-2">{showHeaderFilters ? <><select aria-label={t("tasks.priority_filter")} value={props.filters!.priority} onChange={(event) => props.filters?.setPriority(event.target.value as "" | "low" | "medium" | "high")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="">{t("tasks.all_priorities")}</option><option value="low">{t("tasks.priority_low")}</option><option value="medium">{t("tasks.priority_medium")}</option><option value="high">{t("tasks.priority_high")}</option></select><select aria-label={t("tasks.sort")} value={props.filters!.sort} onChange={(event) => props.filters?.setSort(event.target.value as "updated_at" | "due_at" | "created_at" | "priority")} className="h-8 rounded-md border border-dls-border bg-dls-surface px-2 text-sm"><option value="updated_at">{t("tasks.sort_updated")}</option><option value="due_at">{t("tasks.sort_due")}</option><option value="created_at">{t("tasks.sort_created")}</option><option value="priority">{t("tasks.sort_priority")}</option></select></> : null}{showHeaderCreate ? isTaskWorkbenchSection(activeSection) ? <TaskCreateMenu onCreateTask={props.onCreateTask} onCreateList={props.onCreateTaskList} /> : props.onCreateTask ? <Button size="sm" onClick={props.onCreateTask}><Plus className="size-4" />{t("tasks.create")}</Button> : null : null}</div></div>
        <div className={`flex min-h-0 flex-1 items-center justify-center overflow-auto ${isTaskWorkbenchSection(activeSection) ? "p-0" : "p-6"}`}>{props.children}</div>
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

function TaskDetail(props: { result: ReturnType<typeof useProductTask>["data"]; activity: ReturnType<typeof useProductTaskActivity>["data"]; reminders: Array<{ scheduledAt: string; state: string }>; members: DenOrganizationMember[]; lists: DenProductTaskList[]; groups: Array<{ id: string; name: string }>; defaultGroupName: string; groupId: string; loading: boolean; error: boolean; currentMemberId: string | null; preservedDraft: ProductTaskEditDraft | null; onDraftChange: (draft: ProductTaskEditDraft) => void; onClose: () => void; onSave: (id: string, patch: { expectedVersion: number; idempotencyKey: string; title: string; description: string }) => Promise<void>; onComment: (taskId: string, body: string) => Promise<boolean>; onFollowersChange: (task: DenProductTask, memberIds: string[]) => Promise<boolean>; onListChange: (task: DenProductTask, listId: string) => Promise<boolean>; onListCreate: (task: DenProductTask, name: string) => Promise<string | null>; onTimeChange: (task: DenProductTask, field: TaskTimeField, value: string | null) => Promise<boolean>; onGroupChange: (taskId: string, groupId: string) => void; onGroupsChange: (groups: Array<{ id: string; name: string }>) => void; onSetReminder: (scheduledAt: string) => void; onCancelReminder: () => void; onTransition: (task: DenProductTask, operation: "complete" | "cancel" | "reopen" | "restore") => void }) {
  const task = props.result?.task;
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [commentPending, setCommentPending] = React.useState(false);
  const [followerIds, setFollowerIds] = React.useState<string[]>([]);
  const [groupSearch, setGroupSearch] = React.useState("");
  const commentAttempt = React.useRef(0);
  const currentAssignee = props.result?.members.find((member) => member.role === "assignee" && member.memberId === props.currentMemberId);
  const currentAssigneeCompleted = task?.status === "todo" && task.completionPolicy === "all_assignees" && Boolean(currentAssignee?.completedAt);
  const canComplete = props.result?.permissions.canComplete && (task?.completionPolicy !== "all_assignees" || Boolean(currentAssignee));
  const currentMemberId = props.currentMemberId;
  const isFollowing = Boolean(currentMemberId && followerIds.includes(currentMemberId));
  const memberById = new Map(props.members.map((member) => [member.id, member]));
  const groupName = props.groupId === "custom-default" ? props.defaultGroupName : props.groups.find((group) => group.id === props.groupId)?.name ?? props.defaultGroupName;
  React.useEffect(() => {
    if (!task) return;
    const draft = reapplyProductTaskDraft(task, props.preservedDraft);
    setTitle(draft.title);
    setDescription(draft.description);
    setFollowerIds(props.result?.members.filter((member) => member.role === "follower").map((member) => member.memberId) ?? []);
  }, [props.preservedDraft?.description, props.preservedDraft?.taskId, props.preservedDraft?.title, props.result?.members, task?.description, task?.id, task?.title, task?.version]);
  const saveContent = () => {
    if (!task || !props.result?.permissions.canEditContent) return;
    const nextTitle = title.trim();
    if (!nextTitle || (nextTitle === task.title && description === task.description)) return;
    void props.onSave(task.id, { expectedVersion: task.version, idempotencyKey: mutationKey("desktop-auto-save-task"), title: nextTitle, description });
  };
  const changeFollowers = async (next: string[]) => { if (!task) return; const previous = followerIds; setFollowerIds(next); if (!await props.onFollowersChange(task, next)) setFollowerIds(previous); };
  const sendComment = () => { if (!task) return; const body = comment.trim(); if (!body || commentPending) return; const attempt = ++commentAttempt.current; setCommentPending(true); void props.onComment(task.id, body).then((saved) => { if (commentAttempt.current !== attempt) return; setCommentPending(false); if (saved) setComment((current) => current.trim() === body ? "" : current); }); };
  const submitComment = (event: React.FormEvent) => { event.preventDefault(); sendComment(); };
  const insertCommentMarkup = (before: string, after = "") => setComment((current) => `${current}${before}${after}`);
  return <><button type="button" data-testid="task-detail-backdrop" aria-label={t("tasks.close_detail")} className="absolute inset-0 z-40 cursor-default bg-transparent" onClick={props.onClose} /><aside data-testid="task-detail-panel" className="absolute inset-y-0 right-0 z-50 isolate flex w-[min(560px,94%)] flex-col overflow-hidden border-l border-dls-border bg-background shadow-2xl" aria-label={t("tasks.detail")}>
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-dls-border px-6"><div>{task ? task.status === "todo" && canComplete ? <Button type="button" variant="outline" size="sm" className="border-blue-9 text-blue-10" disabled={currentAssigneeCompleted} onClick={() => { const assignees = props.result?.members.filter((member) => member.role === "assignee").length ?? 0; if (task.completionPolicy === "all_assignees" || assignees <= 1 || globalThis.confirm(t("tasks.complete_multi_confirm"))) props.onTransition(task, "complete"); }}><Check className="size-4" />{t("tasks.complete")}</Button> : task.status === "completed" && props.result?.permissions.canReopen ? <Button type="button" variant="outline" size="sm" className="border-green-8 text-green-10" onClick={() => props.onTransition(task, "reopen")}><Check className="size-4" />{t("tasks.completed")}</Button> : null : null}</div><div className="flex items-center gap-1">{task && currentMemberId ? <Button type="button" data-testid="task-detail-follow" variant="ghost" size="sm" className={isFollowing ? "text-blue-10" : "text-dls-secondary"} onClick={() => void changeFollowers(isFollowing ? followerIds.filter((id) => id !== currentMemberId) : [...followerIds, currentMemberId])}>{isFollowing ? <BookmarkCheck className="size-4" /> : <Bookmark className="size-4" />}{isFollowing ? t("tasks.following_task") : t("tasks.follow_task")}</Button> : null}<Button type="button" variant="ghost" size="icon"><MoreHorizontal className="size-4" /></Button><Button type="button" variant="ghost" size="icon" onClick={props.onClose}><X className="size-4" /></Button></div></header>
    {props.loading ? <div className="flex flex-1 items-center justify-center"><TaskShellContent state={{ kind: "loading" }} /></div> : props.error || !task ? <div className="flex flex-1 items-center justify-center"><TaskShellContent state={{ kind: "error", onRetry: () => undefined }} /></div> : <>
      <div className="min-h-0 flex-1 overflow-y-auto"><section className="space-y-4 px-7 py-6"><Input value={title} readOnly={!props.result?.permissions.canEditContent} onBlur={saveContent} onChange={(event) => { const value = event.target.value; setTitle(value); if (props.preservedDraft) props.onDraftChange({ ...props.preservedDraft, title: value, description }); }} className="h-auto border-0 px-0 py-1 !text-xl font-semibold shadow-none focus-visible:ring-0" />
        <div className="flex items-center gap-3 text-sm"><TaskFieldIcon label={t("tasks.assignees")}><UserRound className="size-4 text-dls-secondary" /></TaskFieldIcon><span className="flex -space-x-1">{props.result?.members.filter((member) => member.role === "assignee").map((item) => { const member = memberById.get(item.memberId); return <Avatar key={item.memberId} size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{member ? memberLabel(member).slice(0, 1) : "?"}</AvatarFallback></Avatar>; })}</span><span className="text-dls-secondary">{props.result?.members.some((member) => member.role === "assignee") ? t("tasks.people_selected", { count: props.result.members.filter((member) => member.role === "assignee").length }) : t("tasks.unassigned")}</span><span className="h-5 w-px bg-dls-border" /><span>{groupName}</span></div>
        <div className="flex items-center gap-3"><TaskFieldIcon label={t("tasks.field_due")}><CalendarDays className="size-4 text-dls-secondary" /></TaskFieldIcon><TaskDateTimeCell task={task} field="dueAt" onChange={props.onTimeChange} /></div>
        <div className="flex items-center gap-3"><TaskFieldIcon label={t("tasks.field_list")}><ListTodo className="size-4 text-dls-secondary" /></TaskFieldIcon><TaskListCell task={task} lists={new Map(props.lists.map((list) => [list.id, list]))} onChange={props.onListChange} onCreate={props.onListCreate} /><span className="h-5 w-px bg-dls-border" /><Popover><PopoverTrigger render={<button type="button" data-testid="task-detail-group-trigger" className="flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-dls-hover" />}><span>{groupName}</span><ChevronDown className="size-3.5" /></PopoverTrigger><PopoverContent align="start" className="w-64 gap-0 rounded-xl p-2"><Input value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder={t("tasks.search_or_create_group")} className="mb-2 h-9" />{[{ id: "custom-default", name: props.defaultGroupName }, ...props.groups].filter((group) => group.name.toLocaleLowerCase().includes(groupSearch.trim().toLocaleLowerCase())).map((group) => <button type="button" key={group.id} data-testid={`task-detail-group-${group.id}`} onClick={() => props.onGroupChange(task.id, group.id)} className={`flex h-9 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-dls-hover ${props.groupId === group.id ? "text-blue-10" : ""}`}><span className="flex-1 truncate">{group.name}</span>{props.groupId === group.id ? <Check className="size-4" /> : null}</button>)}{groupSearch.trim() && ![{ id: "custom-default", name: props.defaultGroupName }, ...props.groups].some((group) => group.name.toLocaleLowerCase() === groupSearch.trim().toLocaleLowerCase()) ? <button type="button" data-testid="task-detail-group-create" onClick={() => { const name = groupSearch.trim(); const id = `custom-${crypto.randomUUID()}`; props.onGroupsChange([...props.groups, { id, name }]); props.onGroupChange(task.id, id); setGroupSearch(""); }} className="mt-1 flex h-10 w-full items-center gap-2 rounded-lg bg-dls-hover px-2 text-sm"><Plus className="size-4" />{t("tasks.create_group")} <strong>{groupSearch.trim()}</strong></button> : null}</PopoverContent></Popover></div>
        <div className="flex h-[168px] items-start gap-3"><TaskFieldIcon label={t("tasks.description_field")}><AlignLeft className="mt-2 size-4 text-dls-secondary" /></TaskFieldIcon><TaskDescriptionEditor testId="task-detail-description-editor" value={description} readOnly={!props.result?.permissions.canEditContent} onChange={(value) => { setDescription(value); if (props.preservedDraft) props.onDraftChange({ ...props.preservedDraft, title, description: value }); }} onBlur={saveContent} /></div>
      </section><section className="border-t border-dls-border px-7 py-5"><h3 className="mb-4 text-sm font-semibold text-dls-text">{t("tasks.comments")}</h3><div className="space-y-4">{props.activity?.comments.length ? props.activity.comments.map((item) => { const author = memberById.get(item.authorMemberId); return <div key={item.id} className="flex items-start gap-3"><Avatar size="sm"><AvatarImage src={author?.user.avatar ?? undefined} /><AvatarFallback>{author ? memberLabel(author).slice(0, 1) : "?"}</AvatarFallback></Avatar><div className="min-w-0 flex-1"><div className="flex items-baseline gap-2"><span className="text-sm font-medium">{author ? memberLabel(author) : item.authorMemberId}</span><span className="text-xs text-dls-secondary">{new Date(item.createdAt).toLocaleString()}</span></div><p className="mt-1 whitespace-pre-wrap text-sm text-dls-text">{item.body}</p></div></div>; }) : <p className="text-sm text-dls-secondary">{t("tasks.comments_empty")}</p>}</div></section></div>
      <div className="shrink-0 bg-background px-6 pb-4 pt-3">{props.result?.permissions.canComment ? <form data-testid="task-comment-editor" className="rounded-xl border border-dls-border bg-background focus-within:border-blue-8" onSubmit={submitComment}><Textarea value={comment} onChange={(event) => setComment(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); sendComment(); } }} placeholder={t("tasks.add_comment")} className="min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0" /><div className="flex items-center justify-between px-2 pb-2"><div className="flex items-center"><button type="button" aria-label={t("tasks.rich_text_bold")} onClick={() => insertCommentMarkup("**", "**")} className="flex size-8 items-center justify-center rounded hover:bg-dls-hover"><Bold className="size-4" /></button><button type="button" aria-label={t("tasks.rich_text_emoji")} onClick={() => insertCommentMarkup("🙂")} className="flex size-8 items-center justify-center rounded hover:bg-dls-hover"><Smile className="size-4" /></button><button type="button" aria-label={t("tasks.rich_text_mention")} onClick={() => insertCommentMarkup("@") } className="flex size-8 items-center justify-center rounded hover:bg-dls-hover"><AtSign className="size-4" /></button><button type="button" aria-label={t("tasks.rich_text_image")} onClick={() => insertCommentMarkup("![", "](https://)")} className="flex size-8 items-center justify-center rounded hover:bg-dls-hover"><ImageIcon className="size-4" /></button></div><Button type="submit" variant="ghost" size="icon" aria-label={t("tasks.add_comment")} disabled={!comment.trim() || commentPending}><ArrowUp className="size-4" /></Button></div></form> : null}<div className="mt-3 flex items-center gap-2"><span className="flex -space-x-1">{followerIds.slice(0, 4).map((id) => { const member = memberById.get(id); return <Avatar key={id} size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{member ? memberLabel(member).slice(0, 1) : "?"}</AvatarFallback></Avatar>; })}</span><span className="text-sm text-dls-text">{t("tasks.followers_count", { count: followerIds.length })}</span>{props.result?.permissions.canManageMembers ? <CreatePeoplePicker testId="task-detail-followers" label={t("tasks.add_follower")} members={props.members} selected={followerIds} onChange={(ids) => void changeFollowers(ids)} triggerContent={<Plus className="size-4" />} triggerClassName="flex size-8 items-center justify-center rounded-md text-dls-secondary hover:bg-dls-hover" /> : null}</div></div>
    </>}
  </aside></>;
}

function memberLabel(member: DenOrganizationMember) {
  return member.user.name?.trim() || member.user.account?.trim() || member.user.email?.trim() || member.id;
}

function CreatePeoplePicker(props: { testId: string; label: string; members: DenOrganizationMember[]; selected: string[]; onChange: (ids: string[]) => void; multiple?: boolean; triggerContent?: React.ReactNode; triggerClassName?: string }) {
  const [search, setSearch] = React.useState("");
  const filtered = props.members.filter((member) => memberLabel(member).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const toggle = (id: string) => props.onChange(props.multiple === false ? [id] : props.selected.includes(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id]);
  const selectedMember = props.members.find((member) => member.id === props.selected[0]);
  return <Popover onOpenChange={(open) => { if (!open) setSearch(""); }}><PopoverTrigger render={<button type="button" data-testid={`${props.testId}-trigger`} className={props.triggerClassName ?? "flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-dls-text hover:bg-dls-hover"} />}>{props.triggerContent ?? <><span className="flex -space-x-1.5">{props.selected.slice(0, 2).map((id) => { const member = props.members.find((item) => item.id === id); return <Avatar key={id} size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{member ? memberLabel(member).slice(0, 1).toUpperCase() : "?"}</AvatarFallback></Avatar>; })}</span><span>{props.selected.length ? props.multiple === false && selectedMember ? memberLabel(selectedMember) : t("tasks.people_selected", { count: props.selected.length }) : props.label}</span><ChevronDown className="size-3.5 text-dls-secondary" /></>}</PopoverTrigger><PopoverContent align="start" side="bottom" sideOffset={4} data-testid={`${props.testId}-picker`} className="w-80 gap-0 rounded-xl p-0 shadow-xl"><div className="border-b border-dls-border p-3"><Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={props.label} className="h-10" /></div><div className="max-h-72 overflow-y-auto p-2">{filtered.map((member) => { const selected = props.selected.includes(member.id); return <button type="button" key={member.id} data-testid={`${props.testId}-option-${member.id}`} onClick={() => toggle(member.id)} className={`flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-sm ${selected ? "bg-dls-hover text-blue-10" : "text-dls-text hover:bg-dls-hover"}`}><Avatar><AvatarImage src={member.user.avatar ?? undefined} /><AvatarFallback>{memberLabel(member).slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="min-w-0 flex-1 truncate">{memberLabel(member)}</span>{selected ? <Check className="size-4 text-blue-10" /> : null}</button>; })}</div></PopoverContent></Popover>;
}

function TaskFieldIcon(props: { label: string; children: React.ReactNode }) {
  return <span tabIndex={0} aria-label={props.label} className="group/task-create-icon relative inline-flex shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-8">{props.children}<span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+9px)] left-1/2 z-[70] w-max max-w-40 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-xs text-background opacity-0 shadow-lg transition-opacity after:absolute after:left-1/2 after:top-full after:size-2 after:-translate-x-1/2 after:-translate-y-1/2 after:rotate-45 after:bg-foreground after:content-[''] group-hover/task-create-icon:opacity-100 group-focus/task-create-icon:opacity-100">{props.label}</span></span>;
}

type DescriptionFormat = "bold" | "strike" | "italic" | "underline" | "ordered" | "bullet" | "quote" | "link" | "emoji" | "mention" | "image";

function TaskDescriptionEditor(props: { value: string; onChange: (value: string) => void; onBlur?: () => void; readOnly?: boolean; testId?: string }) {
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const replaceSelection = (format: DescriptionFormat) => {
    if (props.readOnly) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? props.value.length;
    const end = textarea?.selectionEnd ?? props.value.length;
    const selected = props.value.slice(start, end);
    const lineStart = props.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const prefixes: Partial<Record<DescriptionFormat, string>> = { ordered: "1. ", bullet: "- ", quote: "> " };
    let replacement = selected;
    let selectionStart = start;
    let selectionEnd = end;
    const prefix = prefixes[format];
    if (prefix) {
      const block = props.value.slice(lineStart, end).split("\n").map((line) => `${prefix}${line}`).join("\n");
      replacement = block;
      selectionStart = lineStart;
      selectionEnd = end;
    } else {
      const formats: Record<Exclude<DescriptionFormat, "ordered" | "bullet" | "quote">, [string, string, string]> = {
        bold: ["**", "**", t("tasks.rich_text_text")], strike: ["~~", "~~", t("tasks.rich_text_text")], italic: ["_", "_", t("tasks.rich_text_text")], underline: ["<u>", "</u>", t("tasks.rich_text_text")], link: ["[", "](https://)", t("tasks.rich_text_link")], emoji: ["", "", "🙂"], mention: ["@", "", t("tasks.rich_text_mention")], image: ["![", "](https://)", t("tasks.rich_text_image")],
      };
      const inlineFormat = format as Exclude<DescriptionFormat, "ordered" | "bullet" | "quote">;
      const [before, after, fallback] = formats[inlineFormat];
      replacement = `${before}${selected || fallback}${after}`;
    }
    const next = `${props.value.slice(0, selectionStart)}${replacement}${props.value.slice(selectionEnd)}`;
    props.onChange(next);
    globalThis.requestAnimationFrame?.(() => { textarea?.focus(); textarea?.setSelectionRange(selectionStart + replacement.length, selectionStart + replacement.length); });
  };
  const tools: Array<{ format: DescriptionFormat; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { format: "bold", label: t("tasks.rich_text_bold"), icon: Bold }, { format: "strike", label: t("tasks.rich_text_strike"), icon: Strikethrough }, { format: "italic", label: t("tasks.rich_text_italic"), icon: Italic }, { format: "underline", label: t("tasks.rich_text_underline"), icon: Underline }, { format: "ordered", label: t("tasks.rich_text_ordered"), icon: ListOrdered }, { format: "bullet", label: t("tasks.rich_text_bullet"), icon: ListIcon }, { format: "quote", label: t("tasks.rich_text_quote"), icon: Quote }, { format: "link", label: t("tasks.rich_text_link"), icon: Link }, { format: "emoji", label: t("tasks.rich_text_emoji"), icon: Smile }, { format: "mention", label: t("tasks.rich_text_mention"), icon: AtSign }, { format: "image", label: t("tasks.rich_text_image"), icon: ImageIcon },
  ];
  return <div data-testid={props.testId ?? "task-create-description-editor"} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onBlur?.(); }} className="flex h-[168px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-dls-border bg-dls-surface focus-within:border-blue-8 focus-within:ring-2 focus-within:ring-blue-8/15"><Textarea ref={textareaRef} value={props.value} readOnly={props.readOnly} onChange={(event) => props.onChange(event.target.value)} placeholder={t("tasks.add_description")} className="min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm shadow-none focus-visible:ring-0" /><div data-testid="task-create-description-toolbar" className="flex min-h-12 items-center justify-between border-t border-dls-border px-3"><div className="flex items-center gap-0.5">{tools.slice(0, 8).map(({ format, label, icon: Icon }) => <button key={format} type="button" disabled={props.readOnly} data-testid={`task-description-format-${format}`} aria-label={label} title={label} onClick={() => replaceSelection(format)} className="flex size-8 items-center justify-center rounded-md text-dls-secondary hover:bg-dls-hover hover:text-dls-text disabled:pointer-events-none disabled:opacity-45"><Icon className="size-[18px]" /></button>)}</div><div className="flex items-center gap-0.5">{tools.slice(8).map(({ format, label, icon: Icon }) => <button key={format} type="button" disabled={props.readOnly} data-testid={`task-description-format-${format}`} aria-label={label} title={label} onClick={() => replaceSelection(format)} className="flex size-8 items-center justify-center rounded-md text-dls-secondary hover:bg-dls-hover hover:text-dls-text disabled:pointer-events-none disabled:opacity-45"><Icon className="size-[18px]" /></button>)}</div></div></div>;
}

function TaskCreateDialog(props: { pending: boolean; members: DenOrganizationMember[]; memberDirectoryLoading: boolean; memberDirectoryError: string | null; onRetryMemberDirectory: () => void; lists: DenProductTaskList[]; currentMemberId: string | null; defaultListId: string | null; groups: Array<{ id: string; name: string }>; defaultGroupName: string; onGroupsChange: (groups: Array<{ id: string; name: string }>) => void; onCreateList: (name: string) => Promise<string | null>; onClose: () => void; onCreate: (input: Omit<DenProductTaskCreateInput, "idempotencyKey">, groupId: string) => Promise<void> }) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [assigneeIds, setAssigneeIds] = React.useState<string[]>([]);
  const [followerIds, setFollowerIds] = React.useState<string[]>([]);
  const [dueAt, setDueAt] = React.useState<string | null>(null);
  const [listId, setListId] = React.useState(props.defaultListId ?? "");
  const [groupId, setGroupId] = React.useState("custom-default");
  const [groupSearch, setGroupSearch] = React.useState("");
  const visibility: DenProductTaskVisibility = [...assigneeIds, ...followerIds].some((id) => id !== props.currentMemberId) ? "members" : "private";
  const quickDue = (offset: number) => { const now = new Date(); setDueAt(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).toISOString()); };
  const groupName = groupId === "custom-default" ? props.defaultGroupName || t("tasks.group_default") : props.groups.find((group) => group.id === groupId)?.name ?? t("tasks.group_default");
  const draftTask: DenProductTask = { id: "create-dialog-draft", displayNumber: null, creatorMemberId: props.currentMemberId ?? "", listId: listId || null, title, description, priority: "none", visibility, completionPolicy: "any_assignee", status: "todo", version: 1, startAt: null, dueAt, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return <Dialog open onOpenChange={(open) => { if (!open && !props.pending) props.onClose(); }}><DialogContent data-testid="task-create-dialog" className="h-[min(460px,calc(100vh-2rem))] w-[min(680px,calc(100%-3rem))] max-w-none gap-0 overflow-visible rounded-xl bg-dls-surface p-0 sm:max-w-[680px]" aria-label={t("tasks.create")} showCloseButton={!props.pending}><DialogHeader className="sr-only"><DialogTitle>{t("tasks.create")}</DialogTitle><DialogDescription>{t("tasks.create_description")}</DialogDescription></DialogHeader><form className="flex h-full min-h-0 flex-col px-8 pb-3 pt-7" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; void props.onCreate({ title: title.trim(), description, visibility, priority: "none", startAt: null, dueAt, listId: listId || undefined, members: [...assigneeIds.map((memberId) => ({ memberId, role: "assignee" as const })), ...followerIds.map((memberId) => ({ memberId, role: "follower" as const }))] }, groupId); }}>
    <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("tasks.title_placeholder")} className="h-12 w-full bg-transparent text-[20px] font-medium text-dls-text outline-none placeholder:text-dls-secondary/70" />
    <div className="mt-3 flex items-center gap-3"><TaskFieldIcon label={t("tasks.assignees")}><UserRound className="size-5 text-dls-secondary" /></TaskFieldIcon><CreatePeoplePicker testId="task-create-assignees" label={t("tasks.add_assignee")} members={props.members} selected={assigneeIds} onChange={setAssigneeIds} /><span className="h-6 w-px bg-dls-border" /><Popover><PopoverTrigger render={<button type="button" data-testid="task-create-group-trigger" className="flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-dls-text hover:bg-dls-hover" />}><span>{groupName}</span><ChevronDown className="size-3.5 text-dls-secondary" /></PopoverTrigger><PopoverContent align="start" className="w-72 gap-0 rounded-xl p-2"><Input autoFocus value={groupSearch} onChange={(event) => setGroupSearch(event.target.value)} placeholder={t("tasks.search_or_create_group")} className="mb-2 h-10" /><p className="px-2 py-1 text-xs font-medium text-dls-secondary">{t("tasks.assigned_to_me")}</p>{[{ id: "custom-default", name: props.defaultGroupName || t("tasks.group_default") }, ...props.groups].filter((group) => group.name.toLocaleLowerCase().includes(groupSearch.trim().toLocaleLowerCase())).map((group) => <button type="button" key={group.id} onClick={() => setGroupId(group.id)} className={`flex h-10 w-full items-center rounded-lg px-2 text-left text-sm ${groupId === group.id ? "bg-dls-hover text-blue-10" : "hover:bg-dls-hover"}`}><span className="flex-1 truncate">{group.name}</span>{groupId === group.id ? <Check className="size-4" /> : null}</button>)}{groupSearch.trim() && ![{ id: "custom-default", name: props.defaultGroupName || t("tasks.group_default") }, ...props.groups].some((group) => group.name.toLocaleLowerCase() === groupSearch.trim().toLocaleLowerCase()) ? <button type="button" data-testid="task-create-group-create" onClick={() => { const name = groupSearch.trim(); const id = `custom-${crypto.randomUUID()}`; props.onGroupsChange([...props.groups, { id, name }]); setGroupId(id); setGroupSearch(""); }} className="mt-1 flex h-11 w-full items-center gap-2 rounded-lg bg-dls-hover px-2 text-sm text-dls-secondary"><Plus className="size-4" />{t("tasks.create_group")} <strong className="text-dls-text">{groupSearch.trim()}</strong></button> : null}</PopoverContent></Popover></div>
    <div className="mt-4 flex items-center gap-3"><TaskFieldIcon label={t("tasks.field_due")}><CalendarDays className="size-5 text-dls-secondary" /></TaskFieldIcon><Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => quickDue(0)}>{t("tasks.today")}</Button><Button type="button" variant="secondary" size="sm" className="h-8" onClick={() => quickDue(1)}>{t("tasks.tomorrow")}</Button><TaskDateTimeCell task={draftTask} field="dueAt" triggerContent={<><CalendarDays className="size-4" />{t("tasks.other_time")}</>} triggerClassName="flex h-8 items-center gap-1.5 rounded-lg bg-dls-hover px-2 text-sm text-dls-text hover:bg-dls-active" onChange={async (_task, _field, value) => { setDueAt(value); return true; }} /></div>
    <div className="mt-3 flex items-center gap-3"><TaskFieldIcon label={t("tasks.field_list")}><ListTodo className="size-5 text-dls-secondary" /></TaskFieldIcon><TaskListCell task={draftTask} lists={new Map(props.lists.map((list) => [list.id, list]))} onChange={async (_task, nextListId) => { setListId(nextListId); return true; }} onCreate={async (_task, name) => { const id = await props.onCreateList(name); if (id) setListId(id); return id; }} /></div>
    <div className="mt-2 flex h-[168px] shrink-0 items-start gap-3"><TaskFieldIcon label={t("tasks.description_field")}><AlignLeft className="mt-2 size-5 text-dls-secondary" /></TaskFieldIcon><TaskDescriptionEditor value={description} onChange={setDescription} /></div>
    {props.memberDirectoryError ? <div className="mt-3 flex items-center gap-2 text-sm text-red-9" role="alert"><span>{t("tasks.member_directory_error")}</span><Button type="button" size="sm" variant="ghost" onClick={props.onRetryMemberDirectory}>{t("tasks.retry")}</Button></div> : props.memberDirectoryLoading ? <p className="mt-3 text-sm text-dls-secondary">{t("tasks.loading")}</p> : null}
    <DialogFooter data-testid="task-create-footer" className="mx-0 mb-0 mt-3 w-full flex-row items-center justify-between rounded-none border-0 bg-transparent p-0 sm:justify-between"><CreatePeoplePicker testId="task-create-followers" label={t("tasks.add_follower")} members={props.members} selected={followerIds} onChange={setFollowerIds} triggerClassName="flex h-9 min-w-0 items-center gap-2 rounded-lg px-1.5 text-sm text-dls-text hover:bg-dls-hover" triggerContent={<><BookmarkPlus className="size-5 shrink-0 text-dls-secondary" aria-hidden="true" />{followerIds.length ? <><span className="flex -space-x-1.5">{followerIds.slice(0, 2).map((id) => { const member = props.members.find((item) => item.id === id); return <Avatar key={id} size="sm"><AvatarImage src={member?.user.avatar ?? undefined} /><AvatarFallback>{member ? memberLabel(member).slice(0, 1).toUpperCase() : "?"}</AvatarFallback></Avatar>; })}</span><span>{t("tasks.people_selected", { count: followerIds.length })}</span></> : <span>{t("tasks.add_follower")}</span>}</>} /><div className="flex gap-2"><Button type="button" variant="outline" disabled={props.pending} onClick={props.onClose}>{t("tasks.cancel")}</Button><Button type="submit" disabled={!title.trim() || props.pending}>{t("tasks.create_action")}</Button></div></DialogFooter>
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

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";

import { DenApiError, type DenClient, type DenProductTaskCreateInput, type DenProductTaskResult, type DenProductTaskUpdateInput } from "@/app/lib/den";
import { productTaskKeys, productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type ProductTaskConflict = { scopeKey: string; taskId: string; attempt: number; draft: DenProductTaskUpdateInput; currentVersion?: number; latestLoaded?: boolean };
type ProductTaskUpdateMutationInput = { taskId: string; attempt: number; patch: DenProductTaskUpdateInput };
type CapturedMutationScope = { scope: ProductTaskScope; scopeKey: string; taskId?: string; attempt?: number };

function captureScope(scope: ProductTaskScope | null, taskId?: string, attempt?: number): CapturedMutationScope | null {
  return scope ? { scope, scopeKey: productTaskScopeKey(scope), taskId, attempt } : null;
}

function currentVersion(error: unknown) {
  if (!(error instanceof DenApiError) || error.status !== 409 || !error.details || typeof error.details !== "object") return undefined;
  const value = (error.details as { currentVersion?: unknown }).currentVersion;
  return typeof value === "number" ? value : undefined;
}

async function refreshTaskListsAndActivity(queryClient: ReturnType<typeof useQueryClient>, scope: ProductTaskScope) {
  void queryClient.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(scope) });
  await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) });
}

export function useCreateProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    onMutate: () => captureScope(scope),
    mutationFn: (input: DenProductTaskCreateInput) => client.createProductTask(scope!.organizationId, input),
    onSuccess: async (result, input, captured) => {
      if (!captured) return;
      queryClient.setQueryData(productTaskKeys.detail(captured.scope, result.task.id), result);
      await Promise.all([
        refreshTaskListsAndActivity(queryClient, captured.scope),
        input.parentTaskId && queryClient.invalidateQueries({ queryKey: productTaskKeys.detail(captured.scope, input.parentTaskId), exact: true }),
      ]);
    },
  });
}

export function useUpdateProductTask(client: DenClient, scope: ProductTaskScope | null, onConflict?: (conflict: ProductTaskConflict) => void) {
  const queryClient = useQueryClient();
  const latestAttempts = useRef(new Map<string, number>());
  const attemptKey = (scopeKey: string, taskId: string) => `${scopeKey}\u0000${taskId}`;
  return useMutation({
    retry: false,
    onMutate: (input: ProductTaskUpdateMutationInput) => {
      const captured = captureScope(scope, input.taskId, input.attempt);
      if (captured) latestAttempts.current.set(attemptKey(captured.scopeKey, input.taskId), input.attempt);
      return captured;
    },
    mutationFn: (input: ProductTaskUpdateMutationInput) => client.updateProductTask(scope!.organizationId, input.taskId, input.patch),
    onError: async (error, input, captured) => {
      if (!captured || latestAttempts.current.get(attemptKey(captured.scopeKey, input.taskId)) !== input.attempt || !(error instanceof DenApiError) || error.status !== 409) return;
      onConflict?.({ scopeKey: captured.scopeKey, taskId: input.taskId, attempt: input.attempt, draft: input.patch, currentVersion: currentVersion(error) });
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) });
    },
    onSuccess: async (result: DenProductTaskResult, input, captured) => {
      if (!captured || latestAttempts.current.get(attemptKey(captured.scopeKey, input.taskId)) !== input.attempt) return;
      queryClient.setQueryData(productTaskKeys.detail(captured.scope, result.task.id), result);
      await refreshTaskListsAndActivity(queryClient, captured.scope);
    },
  });
}

export function useTransitionProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    onMutate: () => captureScope(scope),
    mutationFn: (input: { taskId: string; operation: "complete" | "complete-whole" | "cancel" | "reopen" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTask(scope!.organizationId, input.taskId, input.operation, {
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey,
    }),
    onSuccess: async (result, _input, captured) => {
      if (!captured) return;
      const previous = queryClient.getQueryData<DenProductTaskResult>(productTaskKeys.detail(captured.scope, result.task.id));
      queryClient.setQueryData(productTaskKeys.detail(captured.scope, result.task.id), result);
      const parentId = result.task.parentTask?.id ?? previous?.task.parentTask?.id;
      await Promise.all([
        refreshTaskListsAndActivity(queryClient, captured.scope),
        parentId && queryClient.invalidateQueries({ queryKey: productTaskKeys.detail(captured.scope, parentId), exact: true }),
      ]);
    },
  });
}

export function useAddProductTaskComment(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({ retry: false, onMutate: (input: { taskId: string; body: string; idempotencyKey: string }) => captureScope(scope, input.taskId), mutationFn: (input) => client.addProductTaskComment(scope!.organizationId, input.taskId, { body: input.body, idempotencyKey: input.idempotencyKey }), onSuccess: async (_result, _input, captured) => {
    if (captured?.taskId) {
      void queryClient.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(captured.scope) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productTaskKeys.activity(captured.scope, captured.taskId) }),
        queryClient.invalidateQueries({ queryKey: productTaskKeys.detail(captured.scope, captured.taskId), exact: true }),
        queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) }),
      ]);
    }
  } });
}

export function useProductTaskListMutations(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  const refreshTaskAccess = (scope: ProductTaskScope) => {
    void queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) });
    void queryClient.invalidateQueries({ queryKey: productTaskKeys.details(scope) });
  };
  const refresh = async (captured?: CapturedMutationScope | null) => { if (captured) {
    void queryClient.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(captured.scope) });
    await Promise.all([false, true].map((archived) => queryClient.invalidateQueries({ queryKey: productTaskKeys.taskLists(captured.scope, archived) })));
  } };
  const create = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: Parameters<DenClient["createProductTaskList"]>[1]) => client.createProductTaskList(scope!.organizationId, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  const refreshConflict = async (error: unknown, input: { listId: string }, captured?: CapturedMutationScope | null) => { if (captured && error instanceof DenApiError && error.status === 409) await queryClient.invalidateQueries({ queryKey: productTaskKeys.taskListDetail(captured.scope, input.listId), exact: true, refetchType: "active" }); };
  const update = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; patch: Parameters<DenClient["updateProductTaskList"]>[2] }) => client.updateProductTaskList(scope!.organizationId, input.listId, input.patch), onError: refreshConflict, onSuccess: (result, { patch }, captured) => {
    if (captured) {
      queryClient.setQueriesData<{ items: Array<typeof result.list>; nextCursor: string }>({ queryKey: productTaskKeys.taskLists(captured.scope, false), exact: true }, (current) => current ? { ...current, items: current.items.map((list) => list.id === result.list.id ? result.list : list) } : current);
      queryClient.setQueryData(productTaskKeys.taskListDetail(captured.scope, result.list.id), result);
      if (patch.members !== undefined || patch.visibility !== undefined || patch.enableTaskAccess) refreshTaskAccess(captured.scope);
    }
    void refresh(captured);
  } });
  const transferOwnership = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; patch: Parameters<DenClient["transferProductTaskListOwnership"]>[2] }) => client.transferProductTaskListOwnership(scope!.organizationId, input.listId, input.patch), onError: refreshConflict, onSuccess: (result, _input, captured) => {
    if (captured) {
      queryClient.setQueriesData<{ items: Array<typeof result.list>; nextCursor: string }>({ queryKey: productTaskKeys.taskLists(captured.scope, false), exact: true }, (current) => current ? { ...current, items: current.items.map((list) => list.id === result.list.id ? result.list : list) } : current);
      queryClient.setQueryData(productTaskKeys.taskListDetail(captured.scope, result.list.id), result);
      refreshTaskAccess(captured.scope);
    }
    void refresh(captured);
  } });
  const transition = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; operation: "archive" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTaskList(scope!.organizationId, input.listId, input.operation, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  const remove = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; patch: Parameters<DenClient["deleteProductTaskList"]>[2] }) => client.deleteProductTaskList(scope!.organizationId, input.listId, input.patch), onError: refreshConflict, onSuccess: (result, _input, captured) => {
    if (captured) {
      for (const archived of [false, true]) queryClient.setQueriesData<{ items: Array<{ id: string }>; nextCursor: string }>({ queryKey: productTaskKeys.taskLists(captured.scope, archived), exact: true }, (current) => current ? { ...current, items: current.items.filter((list) => list.id !== result.listId) } : current);
      queryClient.removeQueries({ queryKey: productTaskKeys.taskListDetail(captured.scope, result.listId), exact: true });
      queryClient.removeQueries({ queryKey: productTaskKeys.details(captured.scope) });
      void queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) });
    }
    void refresh(captured);
  } });
  return { create, update, transferOwnership, transition, remove };
}

export function useProductTaskReminderMutations(client: DenClient, scope: ProductTaskScope | null, taskId: string | null) {
  const queryClient = useQueryClient();
  const refresh = async (captured?: CapturedMutationScope | null) => { if (captured?.taskId) {
    void queryClient.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(captured.scope) });
    await queryClient.invalidateQueries({ queryKey: productTaskKeys.reminders(captured.scope, captured.taskId) });
  } };
  const set = useMutation({ retry: false, onMutate: () => captureScope(scope, taskId ?? undefined), mutationFn: (input: Parameters<DenClient["setProductTaskReminder"]>[2]) => client.setProductTaskReminder(scope!.organizationId, taskId!, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  const cancel = useMutation({ retry: false, onMutate: () => captureScope(scope, taskId ?? undefined), mutationFn: (idempotencyKey: string) => client.cancelProductTaskReminders(scope!.organizationId, taskId!, idempotencyKey), onSuccess: (_result, _input, captured) => refresh(captured) });
  return { set, cancel };
}

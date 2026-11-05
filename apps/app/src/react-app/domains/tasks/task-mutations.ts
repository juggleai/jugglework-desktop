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

export function useCreateProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    onMutate: () => captureScope(scope),
    mutationFn: (input: DenProductTaskCreateInput) => client.createProductTask(scope!.organizationId, input),
    onSuccess: async (result, _input, captured) => {
      if (!captured) return;
      queryClient.setQueryData(productTaskKeys.detail(captured.scope, result.task.id), result);
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) });
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
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) });
    },
  });
}

export function useTransitionProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    onMutate: () => captureScope(scope),
    mutationFn: (input: { taskId: string; operation: "complete" | "cancel" | "reopen" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTask(scope!.organizationId, input.taskId, input.operation, input),
    onSuccess: async (result, _input, captured) => {
      if (!captured) return;
      queryClient.setQueryData(productTaskKeys.detail(captured.scope, result.task.id), result);
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(captured.scope) });
    },
  });
}

export function useAddProductTaskComment(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({ retry: false, onMutate: (input: { taskId: string; body: string; idempotencyKey: string }) => captureScope(scope, input.taskId), mutationFn: (input) => client.addProductTaskComment(scope!.organizationId, input.taskId, { body: input.body, idempotencyKey: input.idempotencyKey }), onSuccess: async (_result, _input, captured) => {
    if (captured?.taskId) await queryClient.invalidateQueries({ queryKey: productTaskKeys.activity(captured.scope, captured.taskId) });
  } });
}

export function useProductTaskListMutations(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  const refresh = async (captured?: CapturedMutationScope | null) => { if (captured) await Promise.all([false, true].map((archived) => queryClient.invalidateQueries({ queryKey: productTaskKeys.taskLists(captured.scope, archived) }))); };
  const create = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: Parameters<DenClient["createProductTaskList"]>[1]) => client.createProductTaskList(scope!.organizationId, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  const update = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; patch: Parameters<DenClient["updateProductTaskList"]>[2] }) => client.updateProductTaskList(scope!.organizationId, input.listId, input.patch), onSuccess: (_result, _input, captured) => refresh(captured) });
  const transition = useMutation({ retry: false, onMutate: () => captureScope(scope), mutationFn: (input: { listId: string; operation: "archive" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTaskList(scope!.organizationId, input.listId, input.operation, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  return { create, update, transition };
}

export function useProductTaskReminderMutations(client: DenClient, scope: ProductTaskScope | null, taskId: string | null) {
  const queryClient = useQueryClient();
  const refresh = async (captured?: CapturedMutationScope | null) => { if (captured?.taskId) await queryClient.invalidateQueries({ queryKey: productTaskKeys.reminders(captured.scope, captured.taskId) }); };
  const set = useMutation({ retry: false, onMutate: () => captureScope(scope, taskId ?? undefined), mutationFn: (input: Parameters<DenClient["setProductTaskReminder"]>[2]) => client.setProductTaskReminder(scope!.organizationId, taskId!, input), onSuccess: (_result, _input, captured) => refresh(captured) });
  const cancel = useMutation({ retry: false, onMutate: () => captureScope(scope, taskId ?? undefined), mutationFn: (idempotencyKey: string) => client.cancelProductTaskReminders(scope!.organizationId, taskId!, idempotencyKey), onSuccess: (_result, _input, captured) => refresh(captured) });
  return { set, cancel };
}

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { DenApiError, type DenClient, type DenProductTaskCreateInput, type DenProductTaskResult, type DenProductTaskUpdateInput } from "@/app/lib/den";
import { productTaskKeys, type ProductTaskScope } from "./task-queries";

export type ProductTaskConflict = { taskId: string; draft: unknown; currentVersion?: number };

function currentVersion(error: unknown) {
  if (!(error instanceof DenApiError) || error.status !== 409 || !error.details || typeof error.details !== "object") return undefined;
  const value = (error.details as { currentVersion?: unknown }).currentVersion;
  return typeof value === "number" ? value : undefined;
}

export function useCreateProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input: DenProductTaskCreateInput) => client.createProductTask(scope!.organizationId, input),
    onSuccess: async (result) => {
      if (!scope) return;
      queryClient.setQueryData(productTaskKeys.detail(scope, result.task.id), result);
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) });
    },
  });
}

export function useUpdateProductTask(client: DenClient, scope: ProductTaskScope | null, onConflict?: (conflict: ProductTaskConflict) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input: { taskId: string; patch: DenProductTaskUpdateInput }) => client.updateProductTask(scope!.organizationId, input.taskId, input.patch),
    onError: async (error, input) => {
      if (!scope || !(error instanceof DenApiError) || error.status !== 409) return;
      onConflict?.({ taskId: input.taskId, draft: input.patch, currentVersion: currentVersion(error) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: productTaskKeys.detail(scope, input.taskId) }),
        queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) }),
      ]);
    },
    onSuccess: async (result: DenProductTaskResult) => {
      if (!scope) return;
      queryClient.setQueryData(productTaskKeys.detail(scope, result.task.id), result);
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) });
    },
  });
}

export function useTransitionProductTask(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input: { taskId: string; operation: "complete" | "cancel" | "reopen" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTask(scope!.organizationId, input.taskId, input.operation, input),
    onSuccess: async (result) => {
      if (!scope) return;
      queryClient.setQueryData(productTaskKeys.detail(scope, result.task.id), result);
      await queryClient.invalidateQueries({ queryKey: productTaskKeys.lists(scope) });
    },
  });
}

export function useAddProductTaskComment(client: DenClient, scope: ProductTaskScope | null, taskId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({ retry: false, mutationFn: (input: { body: string; idempotencyKey: string }) => client.addProductTaskComment(scope!.organizationId, taskId!, input), onSuccess: async () => {
    if (scope && taskId) await queryClient.invalidateQueries({ queryKey: productTaskKeys.activity(scope, taskId) });
  } });
}

export function useProductTaskListMutations(client: DenClient, scope: ProductTaskScope | null) {
  const queryClient = useQueryClient();
  const refresh = async () => { if (scope) await Promise.all([false, true].map((archived) => queryClient.invalidateQueries({ queryKey: productTaskKeys.taskLists(scope, archived) }))); };
  const create = useMutation({ retry: false, mutationFn: (input: Parameters<DenClient["createProductTaskList"]>[1]) => client.createProductTaskList(scope!.organizationId, input), onSuccess: refresh });
  const update = useMutation({ retry: false, mutationFn: (input: { listId: string; patch: Parameters<DenClient["updateProductTaskList"]>[2] }) => client.updateProductTaskList(scope!.organizationId, input.listId, input.patch), onSuccess: refresh });
  const transition = useMutation({ retry: false, mutationFn: (input: { listId: string; operation: "archive" | "restore"; expectedVersion: number; idempotencyKey: string }) => client.transitionProductTaskList(scope!.organizationId, input.listId, input.operation, input), onSuccess: refresh });
  return { create, update, transition };
}

export function useProductTaskReminderMutations(client: DenClient, scope: ProductTaskScope | null, taskId: string | null) {
  const queryClient = useQueryClient();
  const refresh = async () => { if (scope && taskId) await queryClient.invalidateQueries({ queryKey: productTaskKeys.reminders(scope, taskId) }); };
  const set = useMutation({ retry: false, mutationFn: (input: Parameters<DenClient["setProductTaskReminder"]>[2]) => client.setProductTaskReminder(scope!.organizationId, taskId!, input), onSuccess: refresh });
  const cancel = useMutation({ retry: false, mutationFn: (idempotencyKey: string) => client.cancelProductTaskReminders(scope!.organizationId, taskId!, idempotencyKey), onSuccess: refresh });
  return { set, cancel };
}

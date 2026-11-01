import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type { DenClient, DenProductTaskListOptions, DenProductTaskPage } from "@/app/lib/den";

export type ProductTaskScope = { baseUrl: string; userId: string; organizationId: string };

export const productTaskKeys = {
  all: (scope: ProductTaskScope) => ["product-tasks", scope.baseUrl.replace(/\/+$/, ""), scope.userId, scope.organizationId] as const,
  lists: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "lists"] as const,
  list: (scope: ProductTaskScope, options: DenProductTaskListOptions) => [...productTaskKeys.lists(scope), options] as const,
  details: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "details"] as const,
  detail: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.details(scope), taskId] as const,
  activity: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "activity"] as const,
  reminders: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "reminders"] as const,
  taskLists: (scope: ProductTaskScope, archived: boolean) => [...productTaskKeys.all(scope), "task-lists", archived] as const,
};

export function flattenProductTaskPages(data: { pages: DenProductTaskPage[] } | undefined) {
  const seen = new Set<string>();
  return (data?.pages ?? []).flatMap((page) => page.items).filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

export function useProductTaskLists(input: { client: DenClient; scope: ProductTaskScope | null; archived: boolean; active?: boolean }) {
  return useQuery({
    queryKey: input.scope ? productTaskKeys.taskLists(input.scope, input.archived) : ["product-tasks", "task-lists", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    queryFn: ({ signal }) => input.client.listProductTaskLists(input.scope!.organizationId, { archived: input.archived, limit: 100 }, { signal }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useProductTasks(input: { client: DenClient; scope: ProductTaskScope | null; options: DenProductTaskListOptions; active?: boolean }) {
  return useInfiniteQuery({
    queryKey: input.scope ? productTaskKeys.list(input.scope, input.options) : ["product-tasks", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => input.client.listProductTasks(input.scope!.organizationId, { ...input.options, cursor: pageParam, limit: input.options.limit ?? 30 }, { signal }),
    getNextPageParam: (page) => page.nextCursor || undefined,
    staleTime: 30_000,
    retry: (count, error) => !(typeof error === "object" && error && "status" in error && Number((error as { status: number }).status) < 500) && count < 2,
  });
}

export function useProductTask(input: { client: DenClient; scope: ProductTaskScope | null; taskId: string | null; active?: boolean }) {
  return useQuery({
    queryKey: input.scope && input.taskId ? productTaskKeys.detail(input.scope, input.taskId) : ["product-tasks", "detail", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope && input.taskId),
    queryFn: ({ signal }) => input.client.getProductTask(input.scope!.organizationId, input.taskId!, { signal }),
    staleTime: 20_000,
    retry: false,
  });
}

export function useProductTaskActivity(input: { client: DenClient; scope: ProductTaskScope | null; taskId: string | null }) {
  return useQuery({ queryKey: input.scope && input.taskId ? productTaskKeys.activity(input.scope, input.taskId) : ["product-tasks", "activity", "unavailable"], enabled: Boolean(input.scope && input.taskId), queryFn: ({ signal }) => input.client.getProductTaskActivity(input.scope!.organizationId, input.taskId!, { signal }), staleTime: 20_000, retry: false });
}

export function useProductTaskReminders(input: { client: DenClient; scope: ProductTaskScope | null; taskId: string | null }) {
  return useQuery({ queryKey: input.scope && input.taskId ? productTaskKeys.reminders(input.scope, input.taskId) : ["product-tasks", "reminders", "unavailable"], enabled: Boolean(input.scope && input.taskId), queryFn: () => input.client.listProductTaskReminders(input.scope!.organizationId, input.taskId!), staleTime: 20_000, retry: false });
}

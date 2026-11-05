import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { DenApiError, type DenClient, type DenOrganizationMember, type DenProductTaskList, type DenProductTaskListOptions, type DenProductTaskMember, type DenProductTaskPage } from "@/app/lib/den";

export type ProductTaskScope = { baseUrl: string; userId: string; organizationId: string };

export function productTaskScopeKey(scope: ProductTaskScope | null): string {
  if (!scope) return "unavailable";
  return JSON.stringify([scope.baseUrl.replace(/\/+$/, ""), scope.userId, scope.organizationId]);
}

export const productTaskKeys = {
  all: (scope: ProductTaskScope) => ["product-tasks", scope.baseUrl.replace(/\/+$/, ""), scope.userId, scope.organizationId] as const,
  lists: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "lists"] as const,
  list: (scope: ProductTaskScope, options: DenProductTaskListOptions) => [...productTaskKeys.lists(scope), options] as const,
  details: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "details"] as const,
  detail: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.details(scope), taskId] as const,
  activity: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "activity"] as const,
  reminders: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "reminders"] as const,
  taskLists: (scope: ProductTaskScope, archived: boolean) => [...productTaskKeys.all(scope), "task-lists", archived] as const,
  organizationMembers: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "organization-members"] as const,
};

export function flattenProductTaskPages(data: { pages: DenProductTaskPage[] } | undefined) {
  const seen = new Set<string>();
  return (data?.pages ?? []).flatMap((page) => page.items).filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

export function flattenProductTaskMembers(data: { pages: DenProductTaskPage[] } | undefined): Record<string, DenProductTaskMember[]> {
  const result: Record<string, DenProductTaskMember[]> = {};
  for (const page of data?.pages ?? []) {
    for (const task of page.items) result[task.id] ??= page.membersByTaskId?.[task.id] ?? [];
  }
  return result;
}

export async function loadAllProductTaskLists(input: {
  client: Pick<DenClient, "listProductTaskLists">;
  organizationId: string;
  archived: boolean;
  signal?: AbortSignal;
}) {
  const items: DenProductTaskList[] = [];
  const itemIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await input.client.listProductTaskLists(input.organizationId, { archived: input.archived, limit: 100, cursor }, { signal: input.signal });
    for (const item of page.items) {
      if (itemIds.has(item.id)) continue;
      itemIds.add(item.id);
      items.push(item);
    }
    const nextCursor = page.nextCursor || undefined;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new DenApiError(500, "invalid_task_list_pagination", "Task list pagination repeated a cursor.");
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return { items, nextCursor: "" };
}

export function useProductTaskLists(input: { client: DenClient; scope: ProductTaskScope | null; archived: boolean; active?: boolean }) {
  return useQuery({
    queryKey: input.scope ? productTaskKeys.taskLists(input.scope, input.archived) : ["product-tasks", "task-lists", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    queryFn: ({ signal }) => loadAllProductTaskLists({ client: input.client, organizationId: input.scope!.organizationId, archived: input.archived, signal }),
    staleTime: 30_000,
    retry: false,
  });
}

export function useOrganizationMembers(input: { client: DenClient; scope: ProductTaskScope | null; fallback?: DenOrganizationMember | null; allowUnavailableFallback?: boolean; active?: boolean }) {
  return useQuery({
    queryKey: input.scope ? productTaskKeys.organizationMembers(input.scope) : ["product-tasks", "organization-members", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    queryFn: async ({ signal }) => {
      const members: DenOrganizationMember[] = [];
      let offset = 0;
      try {
        while (true) {
          const page = await input.client.listOrganizationMembers(input.scope!.organizationId, { limit: 200, offset }, { signal });
          members.push(...page.members);
          offset += page.members.length;
          if (!page.members.length || offset >= page.total) break;
        }
      } catch (error) {
        const expectedUnavailable = error instanceof DenApiError && (error.status === 403 || error.status === 404);
        if (!input.allowUnavailableFallback || !expectedUnavailable) throw error;
      }
      if (input.fallback && !members.some((member) => member.id === input.fallback!.id)) members.push(input.fallback);
      return members;
    },
    staleTime: 60_000,
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
    placeholderData: keepPreviousData,
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

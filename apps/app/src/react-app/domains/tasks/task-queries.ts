import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { productTaskListIds, type DenProductTask, type DenProductTaskResult } from "@/app/lib/den";

import { DenApiError, type DenClient, type DenOrganizationMember, type DenProductTaskActivityItem, type DenProductTaskList, type DenProductTaskListOptions, type DenProductTaskMember, type DenProductTaskPage } from "@/app/lib/den";

export type ProductTaskScope = { baseUrl: string; userId: string; organizationId: string };

export function productTaskScopeKey(scope: ProductTaskScope | null): string {
  if (!scope) return "unavailable";
  return JSON.stringify([scope.baseUrl.replace(/\/+$/, ""), scope.userId, scope.organizationId]);
}

export function directSubtaskOptions(parentTaskId: string | undefined): DenProductTaskListOptions {
  // New servers return canonical sibling order; older servers honor creation order.
  return { view: "all", parentTaskId, sort: "created_at", direction: "asc" };
}

export function isInvalidTaskCursor(error: unknown) {
  return error instanceof DenApiError && error.status === 400 && error.code === "invalid_task_cursor";
}

export const productTaskKeys = {
  all: (scope: ProductTaskScope) => ["product-tasks", scope.baseUrl.replace(/\/+$/, ""), scope.userId, scope.organizationId] as const,
  lists: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "lists"] as const,
  list: (scope: ProductTaskScope, options: DenProductTaskListOptions) => [...productTaskKeys.lists(scope), options] as const,
  details: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "details"] as const,
  detail: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.details(scope), taskId] as const,
  relations: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "relations"] as const,
  activity: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "activity"] as const,
  history: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "history"] as const,
  reminders: (scope: ProductTaskScope, taskId: string) => [...productTaskKeys.detail(scope, taskId), "reminders"] as const,
  taskLists: (scope: ProductTaskScope, archived: boolean) => [...productTaskKeys.all(scope), "task-lists", archived] as const,
  taskListDetails: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "task-list-details"] as const,
  taskListDetail: (scope: ProductTaskScope, listId: string) => [...productTaskKeys.taskListDetails(scope), listId] as const,
  organizationMembers: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "organization-members"] as const,
  collaborationGroups: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "collaboration-groups"] as const,
  activityFeeds: (scope: ProductTaskScope) => [...productTaskKeys.all(scope), "activity-feed"] as const,
  activityFeed: (scope: ProductTaskScope, unreadOnly: boolean) => [...productTaskKeys.activityFeeds(scope), { unreadOnly }] as const,
};

export function flattenProductTaskPages(data: { pages: DenProductTaskPage[] } | undefined) {
  const seen = new Set<string>();
  return (data?.pages ?? []).flatMap((page) => page.items).filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

export async function removeDeletedTaskFromCache(client: QueryClient, scope: ProductTaskScope, taskId: string) {
  const lists = { queryKey: productTaskKeys.lists(scope) };
  const detail = productTaskKeys.detail(scope, taskId);
  client.removeQueries({ queryKey: detail }); // Includes history, activity, reminders and relations.
  client.removeQueries({ ...lists, predicate: q => (q.queryKey.at(-1) as DenProductTaskListOptions).parentTaskId === taskId });
  // A pre-delete read (including an inactive search) must not repopulate a row.
  const details = { queryKey: productTaskKeys.details(scope) };
  await Promise.all([client.cancelQueries(lists), client.cancelQueries(details)]);
  client.setQueriesData<InfiniteData<DenProductTaskPage>>(lists, data => data && ({ ...data, pages: data.pages.map(page => {
    const items = page.items.filter(task => task.id !== taskId);
    if (items.length === page.items.length && !page.membersByTaskId?.[taskId] && page.memberProjectionKnownByTaskId?.[taskId] === undefined) return page;
    const { [taskId]: _members, ...membersByTaskId } = page.membersByTaskId ?? {};
    const { [taskId]: _known, ...memberProjectionKnownByTaskId } = page.memberProjectionKnownByTaskId ?? {};
    return { ...page, items, membersByTaskId, memberProjectionKnownByTaskId };
  }) }));
  // Children and incoming dependencies need not have been visible on the deleted detail.
  await Promise.all([
    client.invalidateQueries(lists),
    client.invalidateQueries({ queryKey: productTaskKeys.details(scope), predicate: q => q.queryKey[detail.length - 1] !== taskId }),
    client.invalidateQueries({ queryKey: productTaskKeys.activityFeeds(scope) }),
  ]);
}

export function applyTaskListMembership(client: QueryClient, scope: ProductTaskScope, result: { taskId: string; listId: string; added: boolean }) {
  const update = (task: DenProductTask) => {
    const ids = productTaskListIds(task);
    const listIds = result.added ? [...new Set([...ids, result.listId])] : ids.filter((id) => id !== result.listId);
    return { ...task, listIds, listId: listIds[0] ?? null };
  };
  client.setQueryData<DenProductTaskResult>(productTaskKeys.detail(scope, result.taskId), (data) => data && { ...data, task: update(data.task) });
  // Remove rows that no longer match. Only the server can place a newly matching
  // row in the right filtered page, so the caller refetches after this update.
  for (const [key] of client.getQueriesData({ queryKey: productTaskKeys.lists(scope) })) {
    const filter = (key.at(-1) as DenProductTaskListOptions).listId;
    client.setQueryData<InfiniteData<DenProductTaskPage>>(key, (data) => data && ({ ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.flatMap((task) => {
      if (task.id !== result.taskId) return [task];
      const next = update(task);
        return !filter?.length || next.listIds.some((id) => filter.includes(id)) ? [next] : [];
    }) })) }));
  }
}

export function flattenProductTaskMembers(data: { pages: DenProductTaskPage[] } | undefined): Record<string, DenProductTaskMember[]> {
  const result: Record<string, DenProductTaskMember[]> = {};
  for (const page of data?.pages ?? []) {
    for (const task of page.items) result[task.id] ??= page.membersByTaskId?.[task.id] ?? [];
  }
  return result;
}

export function flattenProductTaskActivityPages(data: { pages: Array<{ items: DenProductTaskActivityItem[] }> } | undefined): DenProductTaskActivityItem[] {
  const seen = new Set<string>();
  return (data?.pages ?? []).flatMap((page) => page.items).filter((item) => {
    if (seen.has(item.event.id)) return false;
    seen.add(item.event.id);
    return true;
  });
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

export function useProductTaskListDetail(input: { client: DenClient; scope: ProductTaskScope | null; listId: string | null }) {
  return useQuery({
    queryKey: input.scope && input.listId ? productTaskKeys.taskListDetail(input.scope, input.listId) : ["product-tasks", "task-list-detail", "unavailable"],
    enabled: Boolean(input.scope && input.listId),
    queryFn: () => input.client.getProductTaskList(input.scope!.organizationId, input.listId!),
    staleTime: 20_000,
    retry: false,
  });
}

export function useProductTaskCollaborationGroups(input: { client: DenClient; scope: ProductTaskScope | null; active?: boolean }) {
  return useQuery({
    queryKey: input.scope ? productTaskKeys.collaborationGroups(input.scope) : ["product-tasks", "collaboration-groups", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    queryFn: async ({ signal }) => {
      const groups = [];
      let offset = 0;
      while (true) {
        const page = await input.client.listCollaborationGroups(input.scope!.organizationId, { limit: 100, offset }, { signal });
        groups.push(...page.groups);
        offset += page.groups.length;
        if (!page.groups.length || offset >= page.total) break;
      }
      return groups;
    },
    staleTime: 60_000,
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

type TaskPageParam = string | { updatedOrderCursor: string } | undefined;
type TaskQueryPage = DenProductTaskPage & { localCompletedSort?: true };

export function useProductTasks(input: { client: DenClient; scope: ProductTaskScope | null; options: DenProductTaskListOptions; active?: boolean }) {
  return useInfiniteQuery({
    queryKey: input.scope ? productTaskKeys.list(input.scope, input.options) : ["product-tasks", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    initialPageParam: undefined as TaskPageParam,
    queryFn: async ({ pageParam, signal }): Promise<TaskQueryPage> => {
      const request = (options: DenProductTaskListOptions) => input.client.listProductTasks(input.scope!.organizationId, { ...options, limit: input.options.limit ?? 30 }, { signal });
      const readUpdatedOrder = async (cursor?: string): Promise<TaskQueryPage> => ({ ...await request({ ...input.options, sort: "updated_at", direction: "desc", cursor }), localCompletedSort: true });
      if (typeof pageParam === "object") return readUpdatedOrder(pageParam.updatedOrderCursor);
      try {
        return await request({ ...input.options, cursor: pageParam });
      } catch (error) {
        // Never reuse a cursor with a different sort, or mask an unrelated HTTP failure.
        if (pageParam !== undefined || input.options.parentTaskId || input.options.sort !== "completed_at" || signal.aborted || !(error instanceof DenApiError) || error.status !== 400 || error.code !== "invalid_task_request") throw error;
        return readUpdatedOrder();
      }
    },
    getNextPageParam: (page, _pages, _param, seen) => {
      if (!page.nextCursor || seen.includes(page.nextCursor)) return undefined;
      return page.localCompletedSort ? { updatedOrderCursor: page.nextCursor } : page.nextCursor;
    },
    placeholderData: (previous, query) => !input.options.parentTaskId && !(query?.queryKey.at(-1) as DenProductTaskListOptions | undefined)?.parentTaskId && input.scope && productTaskKeys.lists(input.scope).every((part, i) => query?.queryKey[i] === part) ? previous : undefined,
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

export function useProductTaskActivityFeed(input: { client: DenClient; scope: ProductTaskScope | null; unreadOnly: boolean; active?: boolean }) {
  return useInfiniteQuery({
    queryKey: input.scope ? productTaskKeys.activityFeed(input.scope, input.unreadOnly) : ["product-tasks", "activity-feed", "unavailable"],
    enabled: (input.active ?? true) && Boolean(input.scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => input.client.listProductTaskActivity(input.scope!.organizationId, { cursor: pageParam, limit: 30, unreadOnly: input.unreadOnly || undefined }, { signal }),
    getNextPageParam: (page) => page.hasMore && page.nextCursor ? page.nextCursor : undefined,
    staleTime: 15_000,
    retry: false,
  });
}

export function useProductTaskHistory({ client, scope, taskId }: { client: DenClient; scope: ProductTaskScope; taskId: string }) {
  return useInfiniteQuery({
    queryKey: productTaskKeys.history(scope, taskId), initialPageParam: "",
    queryFn: ({ pageParam, signal }) => client.listProductTaskHistory(scope.organizationId, taskId, { cursor: pageParam, signal }),
    getNextPageParam: page => page.nextCursor || undefined,
    gcTime: 0, retry: false,
  });
}

export function useProductTaskActivity(input: { client: DenClient; scope: ProductTaskScope | null; taskId: string | null }) {
  return useQuery({ queryKey: input.scope && input.taskId ? productTaskKeys.activity(input.scope, input.taskId) : ["product-tasks", "activity", "unavailable"], enabled: Boolean(input.scope && input.taskId), queryFn: ({ signal }) => input.client.getProductTaskActivity(input.scope!.organizationId, input.taskId!, { signal }), staleTime: 20_000, retry: false });
}

export function useProductTaskReminders(input: { client: DenClient; scope: ProductTaskScope | null; taskId: string | null }) {
  return useQuery({ queryKey: input.scope && input.taskId ? productTaskKeys.reminders(input.scope, input.taskId) : ["product-tasks", "reminders", "unavailable"], enabled: Boolean(input.scope && input.taskId), queryFn: () => input.client.listProductTaskReminders(input.scope!.organizationId, input.taskId!), staleTime: 20_000, retry: false });
}

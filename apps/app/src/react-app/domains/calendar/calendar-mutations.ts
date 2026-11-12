import {
  useMutation,
  useQueryClient,
  type MutateOptions,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRef } from "react";

import {
  DenApiError,
  normalizeDenCalendar,
  normalizeDenCalendarEvent,
  type DenCalendar,
  type DenCalendarCreateInput,
  type DenCalendarCollaborationList,
  type DenCalendarMembershipList,
  type DenCalendarMembershipPutResult,
  type DenCalendarMembershipRevokeResult,
  type DenCalendarCollaborationRole,
  type DenCalendarDeleteResult,
  type DenCalendarEvent,
  type DenCalendarEventCreateInput,
  type DenCalendarEventResult,
  type DenCalendarEventUpdateInput,
  type DenCalendarResult,
  type DenCalendarUpdateInput,
  type DenTeamCalendarCreateInput,
  type DenTeamCalendarCreateResult,
  type DenTeamCalendarEventCreateInput,
  type DenTeamCalendarEventUpdateInput,
  type DenClient,
} from "@/app/lib/den";
import { calendarQueryKeys } from "./calendar-query-keys";
import { setCanonicalCalendar, setCanonicalCalendarEvent } from "./calendar-queries";
import type { CalendarScope } from "./calendar-scope";
import { throwIfCalendarScopeStale, type CalendarScopeGeneration } from "./calendar-scope-lifecycle";

export type CalendarCreateVariables = Omit<DenCalendarCreateInput, "idempotencyKey">;
export type CalendarUpdateVariables = { calendarId: string; expectedVersion: number; patch: Omit<DenCalendarUpdateInput, "idempotencyKey" | "expectedVersion"> };
export type CalendarDeleteVariables = { calendarId: string; expectedVersion: number };
export type CalendarEventCreateVariables = Omit<DenCalendarEventCreateInput, "idempotencyKey">;
export type CalendarEventUpdateVariables = { eventId: string; expectedVersion: number; patch: Omit<DenCalendarEventUpdateInput, "idempotencyKey" | "expectedVersion"> };
export type CalendarEventDeleteVariables = { eventId: string; expectedVersion: number };
export type TeamCalendarCreateVariables = DenTeamCalendarCreateInput;

export type CalendarMutationOperation =
  | "calendar-create"
  | "calendar-update"
  | "calendar-delete"
  | "event-create"
  | "event-update"
  | "event-delete";

export type CalendarMutationOptions = {
  idempotencyKeyFactory?: (operation: CalendarMutationOperation) => string;
  retryDelay?: number;
  generation?: CalendarScopeGeneration | null;
};

export type CalendarMutationClient = Pick<DenClient,
  | "createCalendar"
  | "updateCalendar"
  | "deleteCalendar"
  | "createCalendarEvent"
  | "updateCalendarEvent"
  | "deleteCalendarEvent"
>;
export type CalendarCollaborationMutationClient = Pick<DenClient, "createTeamCalendar">;
export type TeamCalendarEventMutationClient = Pick<DenClient, "createTeamCalendarEvent" | "updateTeamCalendarEvent" | "deleteTeamCalendarEvent">;
export type TeamCalendarMembershipMutationClient = Pick<DenClient, "putTeamCalendarMembership" | "revokeTeamCalendarMembership">;

type PreparedBase<TVariables> = {
  scope: CalendarScope;
  publicInput: TVariables;
  idempotencyKey: string;
  operationId: number;
  generation?: CalendarScopeGeneration | null;
};

type RejectedPreparation<TVariables> = { publicInput: TVariables; operationId: number; error: Error };
type PreparedAction<TVariables, TPrepared extends PreparedBase<TVariables>> = TPrepared | RejectedPreparation<TVariables>;

type PublicMutationResult<TData, TVariables, TPrepared extends PreparedBase<TVariables>> = Omit<UseMutationResult<TData, Error, PreparedAction<TVariables, TPrepared>, unknown>, "mutate" | "mutateAsync" | "variables"> & {
  mutate: (variables: TVariables, options?: MutateOptions<TData, Error, TVariables, unknown>) => void;
  mutateAsync: (variables: TVariables, options?: MutateOptions<TData, Error, TVariables, unknown>) => Promise<TData>;
  retryLast: (options?: MutateOptions<TData, Error, TVariables, unknown>) => void;
  retryLastAsync: (options?: MutateOptions<TData, Error, TVariables, unknown>) => Promise<TData>;
  canRetryLast: boolean;
  variables: TVariables | undefined;
};

class CalendarMutationPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarMutationPreparationError";
  }
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new CalendarMutationPreparationError("Secure random idempotency keys are unavailable.");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createCalendarIdempotencyKey(operation: CalendarMutationOperation): string {
  return `calendar.${operation}.${randomUuid()}`;
}

function idempotencyKey(operation: CalendarMutationOperation, options: CalendarMutationOptions): string {
  const key = options.idempotencyKeyFactory?.(operation) ?? createCalendarIdempotencyKey(operation);
  if (!key || key.length > 128) throw new CalendarMutationPreparationError("Calendar idempotency keys must contain 1 to 128 characters.");
  return key;
}

function frozenScope(scope: CalendarScope | null): CalendarScope {
  if (!scope) throw new CalendarMutationPreparationError("A complete calendar scope is required.");
  return Object.freeze({ ...scope });
}

function validateCalendarVersion(queryClient: QueryClient, scope: CalendarScope, calendarId: string, expectedVersion: number): number {
  const version = queryClient.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scope, calendarId))?.version;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new CalendarMutationPreparationError("The latest calendar version must be loaded before this mutation.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || version !== expectedVersion) {
    throw new CalendarMutationPreparationError("The calendar changed after this input was prepared; resolve the stale edit before retrying.");
  }
  return expectedVersion;
}

function validateEventVersion(queryClient: QueryClient, scope: CalendarScope, eventId: string, expectedVersion: number): number {
  const version = queryClient.getQueryData<DenCalendarEvent>(calendarQueryKeys.event(scope, eventId))?.version;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new CalendarMutationPreparationError("The latest calendar event version must be loaded before this mutation.");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || version !== expectedVersion) {
    throw new CalendarMutationPreparationError("The calendar event changed after this input was prepared; resolve the stale edit before retrying.");
  }
  return expectedVersion;
}

function isUncertainCalendarMutationError(error: Error): boolean {
  if (error instanceof CalendarMutationPreparationError) return false;
  return !(error instanceof DenApiError) || error.status === 408 || error.status === 429 || error.status >= 500;
}

function shouldRetryCalendarMutation(failureCount: number, error: Error): boolean {
  return isUncertainCalendarMutationError(error) && failureCount < 2;
}

function isRejected<TVariables, TPrepared extends PreparedBase<TVariables>>(
  action: PreparedAction<TVariables, TPrepared>,
): action is RejectedPreparation<TVariables> {
  return "error" in action;
}

function rejected<TVariables>(publicInput: TVariables, operationId: number, error: unknown): RejectedPreparation<TVariables> {
  return { publicInput, operationId, error: error instanceof Error ? error : new CalendarMutationPreparationError("Calendar mutation preparation failed.") };
}

function usePreparedMutation<TData, TVariables, TPrepared extends PreparedBase<TVariables>>(input: {
  prepare: (variables: TVariables, operationId: number) => PreparedAction<TVariables, TPrepared>;
  mutationFn: (prepared: TPrepared) => Promise<TData>;
  onSuccess: (data: TData, prepared: TPrepared) => Promise<void> | void;
  retryDelay: number;
}): PublicMutationResult<TData, TVariables, TPrepared> {
  const nextOperationId = useRef(0);
  const latestOperationId = useRef(0);
  const lastUncertain = useRef<TPrepared | null>(null);
  const mutation = useMutation<TData, Error, PreparedAction<TVariables, TPrepared>, unknown>({
    mutationFn: (action) => isRejected(action) ? Promise.reject(action.error) : input.mutationFn(action),
    // Never pause offline and resume on reconnect: that would be an implicit offline write queue.
    // Offline failures surface immediately so the member can retry or keep a local draft explicitly.
    networkMode: "always",
    retry: shouldRetryCalendarMutation,
    retryDelay: input.retryDelay,
    onSuccess: (data, action) => {
      if (action.operationId === latestOperationId.current) lastUncertain.current = null;
      return isRejected(action) ? undefined : input.onSuccess(data, action);
    },
    onError: (error, action) => {
      if (!isRejected(action) && action.operationId === latestOperationId.current && isUncertainCalendarMutationError(error)) {
        lastUncertain.current = action;
      } else if (action.operationId === latestOperationId.current) {
        lastUncertain.current = null;
      }
    },
  });

  const adaptOptions = (options: MutateOptions<TData, Error, TVariables, unknown> | undefined): MutateOptions<TData, Error, PreparedAction<TVariables, TPrepared>, unknown> | undefined => options ? {
    onSuccess: (data, action, context, mutation) => options.onSuccess?.(data, action.publicInput, context, mutation),
    onError: (error, action, context, mutation) => options.onError?.(error, action.publicInput, context, mutation),
    onSettled: (data, error, action, context, mutation) => options.onSettled?.(data, error, action.publicInput, context, mutation),
  } : undefined;

  const prepareNew = (variables: TVariables) => {
    const operationId = ++nextOperationId.current;
    latestOperationId.current = operationId;
    lastUncertain.current = null;
    return input.prepare(variables, operationId);
  };
  const retryAction = () => {
    const action = lastUncertain.current;
    if (!action) throw new CalendarMutationPreparationError("There is no uncertain failed calendar mutation to retry.");
    return action;
  };

  return {
    ...mutation,
    variables: mutation.variables?.publicInput,
    canRetryLast: lastUncertain.current !== null,
    mutate: (variables, options) => mutation.mutate(prepareNew(variables), adaptOptions(options)),
    mutateAsync: (variables, options) => mutation.mutateAsync(prepareNew(variables), adaptOptions(options)),
    retryLast: (options) => mutation.mutate(retryAction(), adaptOptions(options)),
    retryLastAsync: async (options) => mutation.mutateAsync(retryAction(), adaptOptions(options)),
  } as PublicMutationResult<TData, TVariables, TPrepared>;
}

function updateExistingCalendarList(queryClient: QueryClient, scope: CalendarScope, incoming: DenCalendar): void {
  queryClient.setQueryData<DenCalendar[]>(calendarQueryKeys.calendars(scope), (cached) => {
    if (!cached) return cached;
    const index = cached.findIndex((calendar) => calendar.id === incoming.id);
    if (index < 0) return [...cached, incoming];
    if (cached[index]!.version >= incoming.version) return cached;
    return cached.map((calendar, itemIndex) => itemIndex === index ? incoming : calendar);
  });
}

async function invalidate(queryClient: QueryClient, keys: readonly (readonly unknown[])[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

async function cancel(queryClient: QueryClient, keys: readonly (readonly unknown[])[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
}

export function calendarMutationConflict(error: unknown): DenCalendar | DenCalendarEvent | null {
  if (!(error instanceof DenApiError) || error.code !== "calendar_version_conflict" || !error.details || typeof error.details !== "object") return null;
  const current = (error.details as { current?: unknown }).current;
  return normalizeDenCalendar(current) ?? normalizeDenCalendarEvent(current);
}

export function useCreateCalendarMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarResult, CalendarCreateVariables, PreparedBase<CalendarCreateVariables> & { input: DenCalendarCreateInput }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const publicInput = Object.freeze({ ...variables });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("calendar-create", options);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, input: Object.freeze({ ...publicInput, idempotencyKey: key }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.createCalendar(prepared.scope.organizationId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      const accepted = setCanonicalCalendar(queryClient, prepared.scope, result.calendar);
      updateExistingCalendarList(queryClient, prepared.scope, accepted);
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

export function useCreateTeamCalendarMutation(client: CalendarCollaborationMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return useMutation<DenTeamCalendarCreateResult, Error, TeamCalendarCreateVariables>({
    networkMode: "always",
    // The server intentionally has no idempotency key for this endpoint.
    retry: false,
    mutationFn: (variables) => {
      const capturedScope = frozenScope(scope);
      return client.createTeamCalendar(capturedScope.organizationId, Object.freeze({ ...variables }), { signal: options.generation?.signal });
    },
    onSuccess: async () => {
      const capturedScope = frozenScope(scope);
      throwIfCalendarScopeStale(options.generation);
      await invalidate(queryClient, [calendarQueryKeys.collaboration(capturedScope), calendarQueryKeys.teamSnapshots(capturedScope)]);
    },
  });
}

export function useTeamCalendarEventMutations(client: TeamCalendarEventMutationClient, scope: CalendarScope | null) {
  const queryClient = useQueryClient();
  const refresh = async (capturedScope: CalendarScope) => invalidate(queryClient, [calendarQueryKeys.teamSnapshots(capturedScope)]);
  const create = useMutation<DenCalendarEventResult, Error, { calendarId: string; input: DenTeamCalendarEventCreateInput }>({
    networkMode: "always",
    retry: false,
    mutationFn: ({ calendarId, input }) => client.createTeamCalendarEvent(frozenScope(scope).organizationId, calendarId, input),
    onSuccess: async (result) => {
      const capturedScope = frozenScope(scope);
      setCanonicalCalendarEvent(queryClient, capturedScope, result.event);
      await refresh(capturedScope);
    },
  });
  const update = useMutation<DenCalendarEventResult, Error, { calendarId: string; eventId: string; input: DenTeamCalendarEventUpdateInput }>({
    networkMode: "always",
    retry: false,
    mutationFn: ({ calendarId, eventId, input }) => client.updateTeamCalendarEvent(frozenScope(scope).organizationId, calendarId, eventId, input),
    onSuccess: async (result) => {
      const capturedScope = frozenScope(scope);
      setCanonicalCalendarEvent(queryClient, capturedScope, result.event);
      await refresh(capturedScope);
    },
  });
  const remove = useMutation<DenCalendarDeleteResult, Error, { calendarId: string; eventId: string; expectedVersion: number }>({
    networkMode: "always",
    retry: false,
    mutationFn: ({ calendarId, eventId, expectedVersion }) => client.deleteTeamCalendarEvent(frozenScope(scope).organizationId, calendarId, eventId, { expectedVersion }),
    onSuccess: async (_result, variables) => {
      const capturedScope = frozenScope(scope);
      queryClient.removeQueries({ queryKey: calendarQueryKeys.event(capturedScope, variables.eventId), exact: true });
      await refresh(capturedScope);
    },
  });
  return { create, update, remove };
}

function updateCalendarAuthorizationVersion(queryClient: QueryClient, scope: CalendarScope, calendarId: string, authorizationVersion: number): void {
  queryClient.setQueryData<DenCalendarCollaborationList>(calendarQueryKeys.collaboration(scope), (cached) => cached ? {
    ...cached,
    items: cached.items.map((calendar) => calendar.id === calendarId ? { ...calendar, authorizationVersion } : calendar),
  } : cached);
}

function applyActorMembershipChange(queryClient: QueryClient, scope: CalendarScope, calendarId: string, memberId: string, role: DenCalendarCollaborationRole | null): void {
  if (memberId !== scope.memberId) return;
  queryClient.setQueryData<DenCalendarCollaborationList>(calendarQueryKeys.collaboration(scope), (cached) => {
    if (!cached) return cached;
    if (role === null) return { ...cached, authorizationGeneration: cached.authorizationGeneration + 1, items: cached.items.filter((calendar) => calendar.id !== calendarId) };
    const capabilities = {
      canViewFreeBusy: true,
      canViewDetails: role !== "free-busy",
      canEditEvents: role === "editor" || role === "manager",
      canManage: role === "manager",
    };
    return { ...cached, authorizationGeneration: cached.authorizationGeneration + 1, items: cached.items.map((calendar) => calendar.id === calendarId ? { ...calendar, role, capabilities } : calendar) };
  });
  queryClient.removeQueries({ queryKey: calendarQueryKeys.memberships(scope, calendarId), exact: true });
  queryClient.removeQueries({ queryKey: [...calendarQueryKeys.teamSnapshots(scope), calendarId] });
  for (const [, event] of queryClient.getQueriesData<DenCalendarEvent>({ queryKey: calendarQueryKeys.events(scope) })) {
    if (event?.calendarId === calendarId) queryClient.removeQueries({ queryKey: calendarQueryKeys.event(scope, event.id), exact: true });
  }
}

export function useTeamCalendarMembershipMutations(client: TeamCalendarMembershipMutationClient, scope: CalendarScope | null, calendarId: string) {
  const queryClient = useQueryClient();
  const refresh = async (capturedScope: CalendarScope) => invalidate(queryClient, [calendarQueryKeys.collaboration(capturedScope), calendarQueryKeys.memberships(capturedScope, calendarId)]);
  const put = useMutation<DenCalendarMembershipPutResult, Error, { memberId: string; role: DenCalendarCollaborationRole; expectedAuthorizationVersion: number }>({
    networkMode: "always",
    retry: false,
    mutationFn: ({ memberId, role, expectedAuthorizationVersion }) => client.putTeamCalendarMembership(frozenScope(scope).organizationId, calendarId, memberId, { role, expectedAuthorizationVersion }),
    onSuccess: async (result) => {
      const capturedScope = frozenScope(scope);
      updateCalendarAuthorizationVersion(queryClient, capturedScope, calendarId, result.authorizationVersion);
      applyActorMembershipChange(queryClient, capturedScope, calendarId, result.membership.memberId, result.membership.role);
      queryClient.setQueryData<DenCalendarMembershipList>(calendarQueryKeys.memberships(capturedScope, calendarId), (cached) => cached ? {
        authorizationVersion: result.authorizationVersion,
        items: cached.items.some((item) => item.memberId === result.membership.memberId)
          ? cached.items.map((item) => item.memberId === result.membership.memberId ? result.membership : item)
          : [...cached.items, result.membership],
      } : cached);
      await refresh(capturedScope);
    },
  });
  const revoke = useMutation<DenCalendarMembershipRevokeResult, Error, { memberId: string; expectedAuthorizationVersion: number }>({
    networkMode: "always",
    retry: false,
    mutationFn: ({ memberId, expectedAuthorizationVersion }) => client.revokeTeamCalendarMembership(frozenScope(scope).organizationId, calendarId, memberId, { expectedAuthorizationVersion }),
    onSuccess: async (result, variables) => {
      const capturedScope = frozenScope(scope);
      updateCalendarAuthorizationVersion(queryClient, capturedScope, calendarId, result.authorizationVersion);
      applyActorMembershipChange(queryClient, capturedScope, calendarId, variables.memberId, null);
      queryClient.setQueryData<DenCalendarMembershipList>(calendarQueryKeys.memberships(capturedScope, calendarId), (cached) => cached ? {
        authorizationVersion: result.authorizationVersion,
        items: cached.items.filter((item) => item.memberId !== variables.memberId),
      } : cached);
      await refresh(capturedScope);
    },
  });
  return { put, revoke };
}

export function useUpdateCalendarMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarResult, CalendarUpdateVariables, PreparedBase<CalendarUpdateVariables> & { calendarId: string; input: DenCalendarUpdateInput }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const publicInput = Object.freeze({ calendarId: variables.calendarId, expectedVersion: variables.expectedVersion, patch: Object.freeze({ ...variables.patch }) });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("calendar-update", options);
        const expectedVersion = validateCalendarVersion(queryClient, capturedScope, publicInput.calendarId, publicInput.expectedVersion);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, calendarId: publicInput.calendarId, input: Object.freeze({ ...publicInput.patch, idempotencyKey: key, expectedVersion }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.updateCalendar(prepared.scope.organizationId, prepared.calendarId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      const accepted = setCanonicalCalendar(queryClient, prepared.scope, result.calendar);
      updateExistingCalendarList(queryClient, prepared.scope, accepted);
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

export function useDeleteCalendarMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarDeleteResult, CalendarDeleteVariables, PreparedBase<CalendarDeleteVariables> & { calendarId: string; input: { idempotencyKey: string; expectedVersion: number } }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const publicInput = Object.freeze({ ...variables });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("calendar-delete", options);
        const expectedVersion = validateCalendarVersion(queryClient, capturedScope, publicInput.calendarId, publicInput.expectedVersion);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, calendarId: publicInput.calendarId, input: Object.freeze({ idempotencyKey: key, expectedVersion }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.deleteCalendar(prepared.scope.organizationId, prepared.calendarId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (_result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      const staleRoots = [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.events(prepared.scope)];
      await cancel(queryClient, [calendarQueryKeys.calendars(prepared.scope), ...staleRoots]);
      for (const queryKey of staleRoots) queryClient.removeQueries({ queryKey });
      queryClient.removeQueries({ queryKey: calendarQueryKeys.calendar(prepared.scope, prepared.calendarId), exact: true });
      queryClient.setQueryData<DenCalendar[]>(calendarQueryKeys.calendars(prepared.scope), (cached) => cached?.filter((calendar) => calendar.id !== prepared.calendarId));
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.events(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

function frozenEventTime(time: DenCalendarEventCreateInput["time"]): DenCalendarEventCreateInput["time"] {
  return Object.freeze({ ...time });
}

export function useCreateCalendarEventMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarEventResult, CalendarEventCreateVariables, PreparedBase<CalendarEventCreateVariables> & { input: DenCalendarEventCreateInput }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const publicInput = Object.freeze({ ...variables, time: frozenEventTime(variables.time) });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("event-create", options);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, input: Object.freeze({ ...publicInput, idempotencyKey: key }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.createCalendarEvent(prepared.scope.organizationId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      setCanonicalCalendarEvent(queryClient, prepared.scope, result.event);
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.ranges(prepared.scope), calendarQueryKeys.searches(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

export function useUpdateCalendarEventMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarEventResult, CalendarEventUpdateVariables, PreparedBase<CalendarEventUpdateVariables> & { eventId: string; input: DenCalendarEventUpdateInput }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const patch = Object.freeze({ ...variables.patch, ...(variables.patch.time ? { time: frozenEventTime(variables.patch.time) } : {}) });
      const publicInput = Object.freeze({ eventId: variables.eventId, expectedVersion: variables.expectedVersion, patch });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("event-update", options);
        const expectedVersion = validateEventVersion(queryClient, capturedScope, publicInput.eventId, publicInput.expectedVersion);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, eventId: publicInput.eventId, input: Object.freeze({ ...publicInput.patch, idempotencyKey: key, expectedVersion }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.updateCalendarEvent(prepared.scope.organizationId, prepared.eventId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      setCanonicalCalendarEvent(queryClient, prepared.scope, result.event);
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.ranges(prepared.scope), calendarQueryKeys.searches(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

export function useDeleteCalendarEventMutation(client: CalendarMutationClient, scope: CalendarScope | null, options: CalendarMutationOptions = {}) {
  const queryClient = useQueryClient();
  return usePreparedMutation<DenCalendarDeleteResult, CalendarEventDeleteVariables, PreparedBase<CalendarEventDeleteVariables> & { eventId: string; input: { idempotencyKey: string; expectedVersion: number } }>({
    retryDelay: options.retryDelay ?? 1_000,
    prepare: (variables, operationId) => {
      const publicInput = Object.freeze({ ...variables });
      try {
        const capturedScope = frozenScope(scope);
        const key = idempotencyKey("event-delete", options);
        const expectedVersion = validateEventVersion(queryClient, capturedScope, publicInput.eventId, publicInput.expectedVersion);
        return Object.freeze({ scope: capturedScope, publicInput, idempotencyKey: key, operationId, generation: options.generation, eventId: publicInput.eventId, input: Object.freeze({ idempotencyKey: key, expectedVersion }) });
      } catch (error) { return rejected(publicInput, operationId, error); }
    },
    mutationFn: (prepared) => client.deleteCalendarEvent(prepared.scope.organizationId, prepared.eventId, prepared.input, { signal: prepared.generation?.signal }),
    onSuccess: async (_result, prepared) => {
      throwIfCalendarScopeStale(prepared.generation);
      const staleRoots = [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.ranges(prepared.scope), calendarQueryKeys.searches(prepared.scope)];
      await cancel(queryClient, [calendarQueryKeys.event(prepared.scope, prepared.eventId), ...staleRoots]);
      for (const queryKey of staleRoots) queryClient.removeQueries({ queryKey });
      queryClient.removeQueries({ queryKey: calendarQueryKeys.event(prepared.scope, prepared.eventId), exact: true });
      await invalidate(queryClient, [calendarQueryKeys.bootstraps(prepared.scope), calendarQueryKeys.ranges(prepared.scope), calendarQueryKeys.searches(prepared.scope), calendarQueryKeys.changesRoot(prepared.scope)]);
    },
  });
}

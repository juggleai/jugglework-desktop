import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";
import { RuntimeSessionStore } from "./runtime-session-store.js";

export async function reconcileRuntimeSession(input: {
  store: RuntimeSessionStore;
  orgId: string;
  workspaceId: string;
  sessionId: string;
  threadExists: (record: RuntimeSessionRecord) => Promise<boolean>;
  recreateThread: (record: RuntimeSessionRecord) => Promise<string>;
  now?: () => number;
}): Promise<{ record: RuntimeSessionRecord; recreated: boolean; failedTurns: string[] }> {
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId, sessionId: input.sessionId };
  const now = input.now ?? Date.now;
  let record = input.store.getSession(scope);
  let recreated = false;
  if (!record.backendThreadId || !(await input.threadExists(record))) {
    const backendThreadId = await input.recreateThread(record);
    record = input.store.bindBackendThread(scope, { runtimeKind: record.runtimeKind, backendThreadId, updatedAt: now() });
    recreated = true;
  }
  const failedTurns: string[] = [];
  for (const turn of input.store.listIncompleteTurns(scope)) {
    const eventId = input.store.createRecoveryEventId();
    const occurredAt = Math.max(now(), turn.lastOccurredAt + 1);
    input.store.appendEvent(scope, eventId, {
      schemaVersion: 1, eventId, occurredAt, workspaceId: scope.workspaceId, orgId: scope.orgId,
      runtimeKind: record.runtimeKind, sessionId: scope.sessionId, threadId: record.backendThreadId,
      turnId: turn.turnId, type: "turn.failed",
      error: { code: "runtime_crashed", message: "The previous run ended before completion.", retryable: true, status: null, metadata: {} },
    });
    failedTurns.push(turn.turnId);
  }
  return { record, recreated, failedTurns };
}

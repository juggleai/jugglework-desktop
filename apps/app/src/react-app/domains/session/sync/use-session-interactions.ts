import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { PendingPermission, PendingQuestion } from "@/app/types";
import { t } from "@/i18n";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { describeRouteError } from "@/react-app/shell/route-workspaces";
import {
  captureInteractionSnapshotFence,
  pendingInteractionsForRoot,
  reconcileInteractionSnapshot,
  resolveLiveInteraction,
  type WorkspaceInteractionState,
  workspaceInteractionsKey,
} from "./workspace-interactions";

const emptyWorkspaceInteractions: WorkspaceInteractionState = {
  permissions: [],
  questions: [],
  sessions: {},
  revision: 0,
  appliedSnapshotFences: {},
  invalidSnapshotBeforeRevision: 0,
  tombstones: {},
};

export type UseSessionInteractionsInput = {
  client: JuggleWorkServerClient | null;
  workspaceId: string;
  sessionId: string | null;
};

function normalizedQuestionId(question: { question: string; id?: string }): string {
  return question.id || `q_${question.question.slice(0, 32)}`;
}

export function permissionInteractionReply(
  pending: PendingPermission,
  reply: "once" | "always" | "reject",
) {
  return {
    targetSessionId: pending.targetSessionId,
    interactionId: pending.id,
    input: {
      origin: "local-renderer" as const,
      commandCorrelationId: null,
      response: reply === "once" ? "allow_once" as const : reply,
    },
  };
}

export function questionInteractionReply(pending: PendingQuestion, answers: string[][]) {
  return {
    targetSessionId: pending.targetSessionId,
    interactionId: pending.id,
    input: {
      origin: "local-renderer" as const,
      commandCorrelationId: null,
      answers: answers.map((values, index) => ({
        questionId: normalizedQuestionId(pending.questions[index]!),
        values,
      })),
    },
  };
}

export function isTerminalInteractionReplyError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["already_resolved", "interaction_expired", "interaction_not_found"]
    .includes(String(error.code));
}

export function useSessionInteractions(input: UseSessionInteractionsInput) {
  const { client, workspaceId, sessionId } = input;
  const canonical = useQueryCacheState<WorkspaceInteractionState>(
    workspaceId ? workspaceInteractionsKey(workspaceId) : null,
    emptyWorkspaceInteractions,
  );
  const selected = useMemo(
    () => sessionId ? pendingInteractionsForRoot(canonical, sessionId) : { permissions: [], questions: [] },
    [canonical, sessionId],
  );

  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  const [questionReplyBusy, setQuestionReplyBusy] = useState(false);
  const questionReplyBusyRef = useRef(false);

  useEffect(() => {
    if (!client || !workspaceId || !sessionId) return;
    let cancelled = false;
    const snapshotFence = captureInteractionSnapshotFence(workspaceId);
    void client.getInteractionSnapshot(workspaceId, sessionId).then(
      ({ item }) => {
        if (!cancelled) reconcileInteractionSnapshot(workspaceId, item, snapshotFence);
      },
      () => {
        // Live canonical state remains actionable when snapshot recovery fails.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, sessionId, workspaceId]);

  const activePermission = selected.permissions[0] ?? null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!client || !workspaceId || permissionReplyBusyRef.current) return;
      const pending = selected.permissions.find((permission) => permission.id === requestID);
      if (!pending) return;
      const request = permissionInteractionReply(pending, reply);
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        await client.replyPermissionInteraction(
          workspaceId,
          request.targetSessionId,
          request.interactionId,
          request.input,
        );
        resolveLiveInteraction(workspaceId, "permission", pending.targetSessionId, requestID);
      } catch (error) {
        if (isTerminalInteractionReplyError(error)) {
          resolveLiveInteraction(workspaceId, "permission", pending.targetSessionId, requestID);
        } else {
          toast.error(t("app.error_request_failed"), {
            description: describeRouteError(error),
          });
        }
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [client, selected.permissions, workspaceId],
  );

  const activeQuestion = selected.questions[0] ?? null;
  const respondQuestion = useCallback(
    async (requestID: string, answers: string[][]) => {
      if (!client || !workspaceId || questionReplyBusyRef.current) return;
      const pending = selected.questions.find((question) => question.id === requestID);
      if (!pending) return;
      const request = questionInteractionReply(pending, answers);
      questionReplyBusyRef.current = true;
      setQuestionReplyBusy(true);
      try {
        await client.replyQuestionInteraction(
          workspaceId,
          request.targetSessionId,
          request.interactionId,
          request.input,
        );
        resolveLiveInteraction(workspaceId, "question", pending.targetSessionId, requestID);
      } catch (error) {
        if (isTerminalInteractionReplyError(error)) {
          resolveLiveInteraction(workspaceId, "question", pending.targetSessionId, requestID);
        } else {
          toast.error(t("app.error_request_failed"), {
            description: describeRouteError(error),
          });
        }
      } finally {
        questionReplyBusyRef.current = false;
        setQuestionReplyBusy(false);
      }
    },
    [client, selected.questions, workspaceId],
  );

  return {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
  };
}

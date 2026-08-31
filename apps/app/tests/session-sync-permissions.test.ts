import { afterEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { PermissionRequest, PermissionV2Request, QuestionRequest } from "@opencode-ai/sdk/v2/client";

import type { JuggleWorkSessionSnapshot } from "../src/app/lib/jugglework-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __disposeWorkspaceSessionSyncForTest,
  __hasWorkspaceSessionSyncForTest,
  coalescePendingDeltas,
  captureLegacyInteractionSnapshotRevision,
  captureTodoSnapshotRevision,
  clearSessionTodos,
  ensureWorkspaceSessionSync,
  permissionKey,
  questionKey,
  reconcileWorkspaceInteractionRoots,
  seedPermissionState,
  seedQuestionState,
  seedSessionState,
  trackWorkspaceSessionSync,
  transcriptKey,
  todoKey,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  getWorkspaceInteractionState,
  pendingInteractionsForRoot,
  seedWorkspaceSessionAncestry,
} from "../src/react-app/domains/session/sync/workspace-interactions";

function permission(id: string, sessionID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["echo ok"],
    metadata: {},
    always: [],
  };
}

function v2Permission(id: string, sessionID: string): PermissionV2Request {
  return {
    id,
    sessionID,
    action: "file.read",
    resources: ["/outside/project/secrets.txt"],
    metadata: { path: "/outside/project/secrets.txt" },
    save: ["/outside/project/*"],
  };
}

function question(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [
      {
        header: "Choice",
        question: "Pick one",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  };
}

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

function snapshotWithMessages(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
  sessionId = "session-a",
): JuggleWorkSessionSnapshot {
  return {
    session: {
      id: sessionId,
      parentID: undefined,
      title: "Test session",
      time: { created: 1, updated: 2 },
      share: undefined,
      version: "0",
    },
    messages: messages.map((message, index) => ({
      info: {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        time: { created: index + 1 },
      },
      parts: [
        {
          id: `part_${message.id}`,
          type: "text",
          text: message.text,
          sessionID: sessionId,
          messageID: message.id,
        },
      ],
    })),
    todos: [],
    status: { type: "idle" },
  } as unknown as JuggleWorkSessionSnapshot;
}

afterEach(() => {
  getReactQueryClient().clear();
});

describe("session permission sync", () => {
  test("seeds only permissions for the selected session", () => {
    seedPermissionState("workspace-a", "session-a", [
      permission("perm-a", "session-a"),
      permission("perm-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "perm-a", sessionID: "session-a", permission: "bash" },
    ]);
  });

  test("preserves received time when refreshing an existing permission", () => {
    seedPermissionState("workspace-a", "session-a", [permission("perm-a", "session-a")]);
    const first = getReactQueryClient().getQueryData<Array<{ id: string; receivedAt: number }>>(
      permissionKey("workspace-a", "session-a"),
    )!;

    seedPermissionState("workspace-a", "session-a", [permission("perm-a", "session-a")]);
    const second = getReactQueryClient().getQueryData<Array<{ id: string; receivedAt: number }>>(
      permissionKey("workspace-a", "session-a"),
    )!;

    expect(second[0]!.receivedAt).toBe(first[0]!.receivedAt);
  });

  test("keeps live permissions that arrive after a snapshot starts", () => {
    const snapshotRevision = captureLegacyInteractionSnapshotRevision();
    getReactQueryClient().setQueryData(permissionKey("workspace-a", "session-a"), [
      {
        ...permission("perm-live", "session-a"),
        receivedAt: 200,
        interactionRevision: snapshotRevision + 1,
      },
    ]);

    seedPermissionState("workspace-a", "session-a", [], { snapshotRevision });

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "perm-live", sessionID: "session-a", permission: "bash" },
    ]);
  });

  test("drops stale permissions that predate a fresh snapshot", () => {
    const snapshotRevision = captureLegacyInteractionSnapshotRevision();
    getReactQueryClient().setQueryData(permissionKey("workspace-a", "session-a"), [
      {
        ...permission("perm-stale", "session-a"),
        receivedAt: 100,
        interactionRevision: snapshotRevision,
      },
    ]);

    seedPermissionState("workspace-a", "session-a", [], { snapshotRevision });

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toEqual([]);
  });

  test("seeds v2 permissions for the selected session", () => {
    seedPermissionState("workspace-a", "session-a", [
      v2Permission("perm-v2-a", "session-a"),
      v2Permission("perm-v2-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      {
        id: "perm-v2-a",
        sessionID: "session-a",
        permission: "read",
        patterns: ["/outside/project/secrets.txt"],
        protocol: "v2",
      },
    ]);
  });

  test("adds and removes live v2 permission events", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    seedWorkspaceSessionAncestry("workspace-a", [{ id: "session-a", parentID: undefined }]);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.asked",
        properties: v2Permission("perm-v2-live", "session-a"),
      });

      expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").permissions).toMatchObject([
        { id: "perm-v2-live", sessionID: "session-a", permission: "read", protocol: "v2" },
      ]);

      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.replied",
        properties: { sessionID: "session-a", requestID: "perm-v2-live", reply: "once" },
      });

      expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").permissions).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("session question sync", () => {
  test("seeds only questions for the selected session", () => {
    seedQuestionState("workspace-a", "session-a", [
      question("question-a", "session-a"),
      question("question-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "question-a", sessionID: "session-a" },
    ]);
  });

  test("adds and removes live question events", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    seedWorkspaceSessionAncestry("workspace-a", [{ id: "session-a", parentID: undefined }]);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "question.asked",
        properties: question("question-live", "session-a"),
      } as any);

      expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").questions).toMatchObject([
        { id: "question-live", sessionID: "session-a" },
      ]);

      __applySessionSyncEventForTest(syncInput, {
        type: "question.replied",
        properties: { sessionID: "session-a", requestID: "question-live", answers: [["Yes"]] },
      } as any);

      expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").questions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("supports question.v2 asked, replied, and rejected events", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    seedWorkspaceSessionAncestry("workspace-a", [{ id: "session-a", parentID: undefined }]);
    try {
      for (const terminalType of ["question.v2.replied", "question.v2.rejected"]) {
        __applySessionSyncEventForTest(syncInput, {
          type: "question.v2.asked",
          properties: question(`question-${terminalType}`, "session-a"),
        } as any);
        expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").questions[0])
          .toMatchObject({ protocol: "v2" });

        __applySessionSyncEventForTest(syncInput, {
          type: terminalType,
          properties: { sessionID: "session-a", requestID: `question-${terminalType}` },
        } as any);
        expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").questions).toEqual([]);
      }
    } finally {
      cleanup();
    }
  });

  test("reconciles every distinct tracked root after a successful stream connection", async () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root-a", parentID: undefined },
      { id: "child-a", parentID: "root-a" },
      { id: "root-b", parentID: undefined },
    ]);
    const requested: string[] = [];
    await reconcileWorkspaceInteractionRoots({
      getInteractionSnapshot: async (_workspaceId: string, rootSessionId: string) => {
        requested.push(rootSessionId);
        return {
          item: {
            snapshotStartedAt: Date.now(),
            rootSessionId,
            permissions: [],
            questions: [],
          },
        };
      },
    } as any, "workspace-a", ["child-a", "root-b", "child-a"]);

    expect(requested.sort()).toEqual(["root-a", "root-b"]);
  });

  test("preserves live interactions when authoritative snapshot recovery fails", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    seedWorkspaceSessionAncestry("workspace-a", [{ id: "session-a", parentID: undefined }]);
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.asked",
        properties: permission("permission-live", "session-a"),
      } as any);

      await reconcileWorkspaceInteractionRoots({
        getInteractionSnapshot: async () => {
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        },
      } as any, "workspace-a", ["session-a"]);

      expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "session-a").permissions)
        .toMatchObject([{ id: "permission-live", sessionID: "session-a" }]);
    } finally {
      cleanup();
    }
  });
});

describe("session transcript sync", () => {
  test("coalesces token-sized deltas by transcript part", () => {
    const deltas = coalescePendingDeltas([
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "hel" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "lo" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-b", reasoning: true, delta: "think" },
      { sessionId: "session-b", messageId: "msg-b", partId: "part-a", reasoning: false, delta: "other" },
    ]);

    expect(deltas).toEqual([
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "hello" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-b", reasoning: true, delta: "think" },
      { sessionId: "session-b", messageId: "msg-b", partId: "part-a", reasoning: false, delta: "other" },
    ]);
  });

  test("does not create a false user row when a consecutive assistant delta arrives first", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), [
      uiMessage("msg-user", "user", "hello"),
      uiMessage("msg-assistant-1", "assistant", "first step"),
    ]);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: {
          sessionID: "session-a",
          messageID: "msg-assistant-2",
          partID: "part-reasoning",
          delta: "thinking",
        },
      } as any);
      await Promise.resolve();

      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.map((entry) => entry.id)).toEqual(["msg-user", "msg-assistant-1"]);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-reasoning",
            type: "reasoning",
            text: "",
            sessionID: "session-a",
            messageID: "msg-assistant-2",
          },
        },
      } as any);

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[2]).toMatchObject({
        id: "msg-assistant-2",
        role: "assistant",
        parts: [{ type: "reasoning", text: "thinking" }],
      });
    } finally {
      release();
      cleanup();
    }
  });

  test("keeps live-only messages when an idle snapshot is stale", () => {
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), [
      uiMessage("msg-user", "user", "hello"),
      uiMessage("msg-assistant", "assistant", "finished answer"),
    ]);

    seedSessionState("workspace-a", snapshotWithMessages([
      { id: "msg-user", role: "user", text: "hello" },
    ]));

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
    expect(transcript?.map((message) => message.id)).toEqual(["msg-user", "msg-assistant"]);
  });

  test("keeps longer live text when an idle snapshot lags the event stream", () => {
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), [
      uiMessage("msg-user", "user", "hello"),
      uiMessage("msg-assistant", "assistant", "finished answer"),
    ]);

    seedSessionState("workspace-a", snapshotWithMessages([
      { id: "msg-user", role: "user", text: "hello" },
      { id: "msg-assistant", role: "assistant", text: "finished" },
    ]));

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
    expect(transcript?.[1]?.parts[0]).toMatchObject({ text: "finished answer" });
  });

  test("keeps live todos when an older snapshot arrives later", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      const snapshotTodoRevision = captureTodoSnapshotRevision();
      __applySessionSyncEventForTest(syncInput, {
        type: "todo.updated",
        properties: {
          sessionID: "session-a",
          todos: [{ id: "todo-live", content: "still working", status: "in_progress", priority: "high" }],
        },
      } as any);

      seedSessionState("workspace-a", snapshotWithMessages([]), { snapshotTodoRevision });

      expect(getReactQueryClient().getQueryData(todoKey("workspace-a", "session-a"))).toMatchObject([
        { id: "todo-live", status: "in_progress" },
      ]);
    } finally {
      release();
      cleanup();
    }
  });

  test("clears previous progress for a new task and rejects an older snapshot", () => {
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(todoKey("workspace-a", "session-a"), [
      { id: "todo-old", content: "old task", status: "in_progress", priority: "high" },
    ]);
    const snapshotTodoRevision = captureTodoSnapshotRevision();

    clearSessionTodos("workspace-a", "session-a");

    expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toEqual([]);

    const staleSnapshot = snapshotWithMessages([]);
    staleSnapshot.todos = [
      { id: "todo-old", content: "old task", status: "in_progress", priority: "high" },
    ];
    seedSessionState("workspace-a", staleSnapshot, { snapshotTodoRevision });

    expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toEqual([]);
  });

  test("continues accepting stream deltas for a recently unselected session", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      const releaseSessionA = trackWorkspaceSessionSync(syncInput, "session-a");
      releaseSessionA();
      const releaseSessionB = trackWorkspaceSessionSync(syncInput, "session-b");

      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-assistant", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-assistant",
            type: "text",
            text: "",
            sessionID: "session-a",
            messageID: "msg-assistant",
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: {
          sessionID: "session-a",
          messageID: "msg-assistant",
          partID: "part-assistant",
          delta: "still streaming after switch",
        },
      } as any);

      await Promise.resolve();

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({ text: "still streaming after switch" });

      releaseSessionB();
    } finally {
      cleanup();
    }
  });

  test("keeps workspace stream alive while retained sessions remain after route unmount", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const releaseWorkspace = ensureWorkspaceSessionSync(syncInput);
    const releaseSessionA = trackWorkspaceSessionSync(syncInput, "session-a");

    releaseSessionA();
    releaseWorkspace();

    try {
      expect(__hasWorkspaceSessionSyncForTest(syncInput)).toBe(true);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-route-leave", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-route-leave",
            type: "text",
            text: "",
            sessionID: "session-a",
            messageID: "msg-route-leave",
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: {
          sessionID: "session-a",
          messageID: "msg-route-leave",
          partID: "part-route-leave",
          delta: "stream survived settings route",
        },
      } as any);

      await Promise.resolve();

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({ text: "stream survived settings route" });
    } finally {
      __disposeWorkspaceSessionSyncForTest(syncInput);
    }
  });
});

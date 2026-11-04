import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  captureSessionSnapshotRevision,
  recordSessionSnapshotRevision,
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
  test("stale snapshot preserves a longer prefix-compatible pending stream", async () => {
    const input = { workspaceId: "pending-newer-than-snapshot", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    trackWorkspaceSessionSync(input, "s");
    try {
      const revision = captureSessionSnapshotRevision(input.workspaceId, "s");
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: "hello world" } } as any);
      // Exercise seed's flush as well as reconciliation: the delta has not flushed yet.
      const snapshot = snapshotWithMessages([{ id: "m", role: "user", text: "hello" }], "s");
      recordSessionSnapshotRevision(snapshot, revision);
      seedSessionState(input.workspaceId, snapshot);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello world", state: "streaming" });
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: "!" } } as any);
      await Promise.resolve();
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello world!" });
    } finally { cleanup(); }
  });

  for (const type of ["text", "reasoning"] as const) {
    test(`final ${type} declaration corrects snapshot/delta overlap and stays done`, async () => {
      const input = { workspaceId: `final-overlap-${type}`, baseUrl: "http://unused", juggleworkToken: "fixture" };
      const cleanup = __createWorkspaceSessionSyncForTest(input);
      trackWorkspaceSessionSync(input, "s");
      try {
        const snapshot = snapshotWithMessages([{ id: "m", role: "user", text: "hello world" }], "s");
        snapshot.messages[0]!.parts[0]!.type = type;
        seedSessionState(input.workspaceId, snapshot);
        __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: " world" } } as any);
        await Promise.resolve();
        // Include uncommitted bytes too: a terminal cumulative update supersedes both.
        __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: " world" } } as any);
        __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "part_m", type, text: "hello world", time: { start: 1, end: 2 } } } } as any);
        await Promise.resolve();
        expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ type, text: "hello world", state: "done" });
      } finally { cleanup(); }
    });

    test(`cumulative ${type} declaration without pending bytes replaces live text and preserves done`, async () => {
      const input = { workspaceId: `final-live-${type}`, baseUrl: "http://unused", juggleworkToken: "fixture" };
      const cleanup = __createWorkspaceSessionSyncForTest(input);
      trackWorkspaceSessionSync(input, "s");
      try {
        const updatePart = (text: string) => __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "p", type, text } } } as any);
        updatePart("");
        __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "hello hello" } } as any);
        await Promise.resolve();
        updatePart("hello");
        expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello", state: "done" });
        updatePart("hello");
        expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ state: "done" });
      } finally { cleanup(); }
    });
  }

  for (const overflow of [false, true]) for (const resolution of ["declaration", "snapshot"]) test(`unresolved ${overflow ? "overflow" : "incompatible"} pending survives flush with bounded recovery until ${resolution}`, async () => {
    const input = { workspaceId: `unresolved-pending-${overflow}-${resolution}`, baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    trackWorkspaceSessionSync(input, "s");
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    let next = 0;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      scheduled.set(++next, { callback, delay }); return next;
    }) as any);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { scheduled.delete(id); }) as any);
    const invalidate = spyOn(getReactQueryClient(), "invalidateQueries").mockResolvedValue(undefined);
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const emit = (delta: string) => __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta } } as any);
    const tick = async (delay: number) => {
      const timer = [...scheduled].find(([, value]) => value.delay === delay);
      expect(timer).toBeDefined();
      scheduled.delete(timer![0]); timer![1].callback();
      await settle();
    };
    try {
      const revision = captureSessionSnapshotRevision(input.workspaceId, "s");
      emit(overflow ? "x".repeat(64 * 1024 + 1) : " world");
      await settle();
      const snapshot = snapshotWithMessages([{ id: "m", role: "user", text: "hello" }], "s");
      recordSessionSnapshotRevision(snapshot, revision);
      seedSessionState(input.workspaceId, snapshot);
      emit("!"); await settle();
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello!" });
      // Replaying the old snapshot must not resolve against the live projection either.
      seedSessionState(input.workspaceId, snapshot);
      await tick(1_000);
      await tick(5_000);
      await tick(5_000);
      emit("?"); await settle();
      expect(invalidate).toHaveBeenCalledTimes(3);
      expect([...scheduled.values()].some((timer) => timer.delay === 1_000 || timer.delay === 5_000)).toBe(false);
      if (resolution === "declaration") {
        __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "part_m", type: "text", text: "hello world!?", time: { start: 1, end: 2 } } } } as any);
      } else {
        const fresh = snapshotWithMessages([{ id: "m", role: "user", text: "hello world!?" }], "s");
        recordSessionSnapshotRevision(fresh, captureSessionSnapshotRevision(input.workspaceId, "s"));
        seedSessionState(input.workspaceId, fresh);
      }
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello world!?", state: "done" });
      // Resolving this episode permits recovery for a genuinely new missing part.
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "new-part", delta: "new" } } as any);
      await settle();
      await tick(1_000);
      expect(invalidate).toHaveBeenCalledTimes(4);
    } finally { cleanup(); timeout.mockRestore(); clear.mockRestore(); invalidate.mockRestore(); }
  });

  test("retained-session expiry clears recovery while retracking cancels the expiry", async () => {
    const input = { workspaceId: "retained-recovery", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    let next = 0;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      scheduled.set(++next, { callback, delay }); return next;
    }) as any);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { scheduled.delete(id); }) as any);
    const invalidate = spyOn(getReactQueryClient(), "invalidateQueries").mockResolvedValue(undefined);
    try {
      const release = trackWorkspaceSessionSync(input, "s");
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "old" } } as any);
      await Promise.resolve();
      release();
      const releaseAgain = trackWorkspaceSessionSync(input, "s");
      expect([...scheduled.values()].some((timer) => timer.delay === 600_000)).toBe(false);
      releaseAgain();
      const expiry = [...scheduled].find(([, timer]) => timer.delay === 600_000)!;
      scheduled.delete(expiry[0]); expiry[1].callback();
      expect([...scheduled.values()].some((timer) => timer.delay === 1_000)).toBe(false);
      const lastRelease = trackWorkspaceSessionSync(input, "s");
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "p", type: "text", text: "new" } } } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "new" });
      expect(invalidate).not.toHaveBeenCalled();
      lastRelease();
    } finally { cleanup(); timeout.mockRestore(); clear.mockRestore(); invalidate.mockRestore(); }
  });

  test("snapshot arriving before rAF consumes undeclared bytes once and later deltas append", () => {
    const input = { workspaceId: "snapshot-before-frame", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "s");
    const previousWindow = globalThis.window;
    const frames: FrameRequestCallback[] = [];
    globalThis.window = { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } } as Window & typeof globalThis;
    try {
      const revision = captureSessionSnapshotRevision(input.workspaceId, "s");
      __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: { sessionID: "s", id: "m", role: "user" } } } as any);
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: "hello" } } as any);
      const snapshot = snapshotWithMessages([{ id: "m", role: "user", text: "hello" }], "s");
      recordSessionSnapshotRevision(snapshot, revision);
      seedSessionState(input.workspaceId, snapshot);
      frames.splice(0).forEach((frame) => frame(0));
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello" });
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: "!" } } as any);
      frames.splice(0).forEach((frame) => frame(0));
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello!" });
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else globalThis.window = previousWindow;
      release(); cleanup();
    }
  });

  test("missing-part recovery is bounded, waits for in-flight reads, and disposal cancels retry", async () => {
    const input = { workspaceId: "bounded-recovery", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    trackWorkspaceSessionSync(input, "s");
    const scheduled = new Map<number, { callback: () => void; delay: number }>();
    let next = 0;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      scheduled.set(++next, { callback, delay }); return next;
    }) as any);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { scheduled.delete(id); }) as any);
    let finish!: () => void;
    const invalidate = spyOn(getReactQueryClient(), "invalidateQueries").mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const emit = () => __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "token" } } as any);
    const tick = (delay: number) => {
      const timer = [...scheduled].find(([, timer]) => timer.delay === delay);
      expect(timer).toBeDefined();
      scheduled.delete(timer![0]); timer![1].callback();
    };
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    try {
      emit(); await settle(); tick(1_000);
      for (let i = 0; i < 20; i++) emit();
      await settle();
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect([...scheduled.values()].some((timer) => timer.delay === 5_000)).toBe(false);
      finish(); await settle(); tick(5_000); finish(); await settle(); tick(5_000); finish(); await settle();
      emit(); await settle();
      expect(invalidate).toHaveBeenCalledTimes(3);
      expect([...scheduled.values()].some((timer) => timer.delay === 1_000 || timer.delay === 5_000)).toBe(false);
      // A new episode is cancelled even if a saved callback fires after disposal.
      __applySessionSyncEventForTest(input, { type: "message.removed", properties: { sessionID: "s", messageID: "m" } } as any);
      emit(); await settle();
      const late = [...scheduled.values()].find((timer) => timer.delay === 1_000)!.callback;
      cleanup(); late(); await settle();
      expect(invalidate).toHaveBeenCalledTimes(3);
    } finally { cleanup(); timeout.mockRestore(); clear.mockRestore(); invalidate.mockRestore(); }
  });

  test("typed declaration cancels missing-part recovery and removed messages cannot be flushed back", async () => {
    const input = { workspaceId: "resolved-recovery", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "s");
    const invalidate = spyOn(getReactQueryClient(), "invalidateQueries").mockResolvedValue(undefined);
    try {
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "hello" } } as any);
      await Promise.resolve();
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "p", type: "text", text: "hello" } } } as any);
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "!" } } as any);
      __applySessionSyncEventForTest(input, { type: "message.removed", properties: { sessionID: "s", messageID: "m" } } as any);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(invalidate).not.toHaveBeenCalled();
      expect(getReactQueryClient().getQueryData(transcriptKey(input.workspaceId, "s"))).toEqual([]);
    } finally { invalidate.mockRestore(); release(); cleanup(); }
  });

  for (const cumulative of ["", "hello"]) test(`keeps same-frame deltas with ${cumulative ? "cumulative" : "empty"} typed declaration`, () => {
    const input = { workspaceId: `frame-${cumulative}`, baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "s");
    const previousWindow = globalThis.window;
    const frames: FrameRequestCallback[] = [];
    globalThis.window = { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } } as Window & typeof globalThis;
    try {
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: "hello" } } as any);
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "p", type: "reasoning", text: cumulative } } } as any);
      frames.splice(0).forEach((frame) => frame(0));
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts)
        .toMatchObject([{ type: "reasoning", text: "hello" }]);
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p", delta: " world" } } as any);
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "p", type: "reasoning", text: "hello world" } } } as any);
      frames.splice(0).forEach((frame) => frame(0));
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello world", state: "done" });
    } finally {
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else globalThis.window = previousWindow;
      release(); cleanup();
    }
  });

  test("recovers undeclared deltas once per session and resumes deltas after stale snapshot fills the part", async () => {
    const input = { workspaceId: "missing-part-recovery", baseUrl: "http://unused", juggleworkToken: "fixture" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "s");
    const invalidate = spyOn(getReactQueryClient(), "invalidateQueries").mockResolvedValue(undefined);
    try {
      __applySessionSyncEventForTest(input, { type: "message.updated", properties: { info: { sessionID: "s", id: "m", role: "user" } } } as any);
      const revision = captureSessionSnapshotRevision(input.workspaceId, "s");
      for (const delta of ["he", "ll", "o"]) __applySessionSyncEventForTest(input, {
        type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(invalidate).toHaveBeenCalledTimes(1);
      const snapshot = snapshotWithMessages([{ id: "m", role: "user", text: "hello" }], "s");
      recordSessionSnapshotRevision(snapshot, revision);
      seedSessionState(input.workspaceId, snapshot);
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "part_m", delta: "!" } } as any);
      await Promise.resolve();
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello!" });
      // A late declaration must not resurrect the old undeclared buffer.
      __applySessionSyncEventForTest(input, { type: "message.part.updated", properties: { part: { sessionID: "s", messageID: "m", id: "part_m", type: "text", text: "hello!" } } } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "s"))?.[0]?.parts[0]).toMatchObject({ text: "hello!" });
    } finally { invalidate.mockRestore(); release(); cleanup(); }
  });

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

  test("rejects previous-turn todos even from a snapshot requested after reset, then accepts the new plan", () => {
    const input = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "session-a");
    try {
      clearSessionTodos("workspace-a", "session-a");
      const snapshotTodoRevision = captureTodoSnapshotRevision();
      const stale = snapshotWithMessages([]);
      stale.todos = [{ id: "old", content: "previous task", status: "completed", priority: "high" }];
      seedSessionState("workspace-a", stale, { snapshotTodoRevision });
      expect(getReactQueryClient().getQueryData(todoKey("workspace-a", "session-a"))).toEqual([]);
      __applySessionSyncEventForTest(input, {
        type: "todo.updated",
        properties: { sessionID: "session-a", todos: [{ id: "new", content: "new task", status: "in_progress", priority: "high" }] },
      } as any);
      seedSessionState("workspace-a", stale, { snapshotTodoRevision });
      expect(getReactQueryClient().getQueryData(todoKey("workspace-a", "session-a"))).toMatchObject([{ id: "new" }]);
    } finally {
      release();
      cleanup();
    }
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

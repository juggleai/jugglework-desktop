import { afterEach, describe, expect, test } from "bun:test";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  seedSessionState,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
} from "../src/react-app/domains/session/sync/parse-tool-parts";
import { parseJuggleWorkSessionCreateResult } from "../src/components/tools/jugglework-session-create";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { getSessionCompactionFromMessage } from "../src/app/lib/session-compaction";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { groupMessages, isMessageGroup } from "../src/components/chat/utils";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

afterEach(() => {
  getReactQueryClient().clear();
});

function writeToolPart(
  status: "pending" | "running" | "completed" | "error",
  input: Record<string, unknown>,
  overrides: Partial<Extract<Part, { type: "tool" }>> = {},
): Extract<Part, { type: "tool" }> {
  const base = {
    id: "part-write",
    sessionID: "session-a",
    messageID: "msg-a",
    type: "tool" as const,
    callID: "call-write",
    tool: "write",
  };

  if (status === "completed") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "completed",
        input,
        output: "ok",
        title: "Write",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "error") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "error",
        input,
        error: "failed",
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "running") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "running",
        input,
        time: { start: 1 },
      },
    };
  }

  return {
    ...base,
    ...overrides,
    state: {
      status: "pending",
      input,
      raw: "",
    },
  };
}

describe("tool part mapper", () => {
  test("defers in-progress tools with empty input", () => {
    // shouldDeferInProgressTool left with the legacy message list (#2016);
    // the deferral behavior itself is still pinned here via the parser and
    // end-to-end below via session sync.
    expect(parseDynamicToolUIPart(writeToolPart("pending", {}))).toBeNull();
    expect(parseDynamicToolUIPart(writeToolPart("running", {}))).toBeNull();
  });

  test("maps in-progress tools with partial input as input-streaming", () => {
    const part = writeToolPart("running", { content: "hello" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "write",
      state: "input-streaming",
      input: { content: "hello" },
    });
  });

  test("maps completed tools", () => {
    const part = writeToolPart("completed", { content: "hello", filePath: "src/a.ts" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      state: "output-available",
      input: { content: "hello", filePath: "src/a.ts" },
      output: "ok",
    });
  });

  test("preserves task child-session metadata for stalled status presentation", () => {
    const part = {
      id: "part-task",
      sessionID: "session-a",
      messageID: "msg-a",
      type: "tool" as const,
      callID: "call-task",
      tool: "task",
      state: {
        status: "completed" as const,
        input: { description: "Map cloud relay" },
        output: "done",
        title: "Task",
        metadata: { sessionId: "child-session", background: true },
        time: { start: 10, end: 20 },
      },
    } satisfies Extract<Part, { type: "tool" }>;

    expect(parseDynamicToolUIPart(part)).toMatchObject({
      callProviderMetadata: {
        opencode: {
          toolMetadata: { sessionId: "child-session", background: true },
          toolStartedAt: 10,
          toolEndedAt: 20,
        },
      },
    });
  });

  test("maps env var request tools for rich chat rendering", () => {
    const part = writeToolPart("running", { key: "NOTION_TOKEN" }, { tool: "request_env_var" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "request_env_var",
      input: { key: "NOTION_TOKEN" },
    });
  });

  test("parses session creation output for rich chat rendering", () => {
    expect(parseJuggleWorkSessionCreateResult(JSON.stringify({
      ok: true,
      workspaceId: "workspace-a",
      workspace: "Research",
      created: [{
        sessionId: "session-dolphins",
        title: "Dolphin research",
        started: true,
        route: "/workspace/workspace-a/session/session-dolphins",
      }],
      failures: [],
    }))).toEqual({
      ok: true,
      workspaceId: "workspace-a",
      workspace: "Research",
      created: [{
        sessionId: "session-dolphins",
        title: "Dolphin research",
        started: true,
        route: "/workspace/workspace-a/session/session-dolphins",
      }],
      failures: [],
    });
  });

  test("skips empty structured output while streaming", () => {
    const part = writeToolPart("running", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toBeNull();
    expect(Object.keys(part.state.input).length).toBe(0);
  });

  test("keeps completed structured output even when input is {}", () => {
    const part = writeToolPart("completed", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toMatchObject({
      type: "text",
      text: "{}",
      state: "done",
    });
  });

  test("session sync defers empty in-progress write tools until input arrives", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: writeToolPart("pending", {}) },
      } as any);

      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts ?? []).toEqual([]);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: writeToolPart("running", { content: "hello", filePath: "src/main.ts" }),
        },
      } as any);

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({
        type: "dynamic-tool",
        toolName: "write",
        state: "input-streaming",
        input: { content: "hello", filePath: "src/main.ts" },
      });
    } finally {
      release();
      cleanup();
    }
  });

  test("session sync exposes one manual compaction marker and updates it in place", () => {
    const syncInput = { workspaceId: "workspace-compact", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-compact");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.compaction.started",
        properties: {
          sessionID: "session-compact",
          messageID: "message-compact",
          reason: "manual",
          timestamp: 1_700_000_000_000,
        },
      });

      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-compact", "session-compact"),
      ) ?? [];
      expect(transcript).toHaveLength(1);
      expect(getSessionCompactionFromMessage(transcript[0]!)).toEqual({
        mode: "manual",
        running: true,
        startedAt: 1_700_000_000_000,
        finishedAt: null,
      });
      expect(useSessionActivityStore.getState().getStatus("workspace-compact", "session-compact")).toBe("compacting");

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "compaction-boundary",
            sessionID: "session-compact",
            messageID: "message-before-compaction",
            type: "compaction",
            auto: false,
          },
        },
      } as any);

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-compact", "session-compact"),
      ) ?? [];
      expect(transcript).toHaveLength(1);
      expect(getSessionCompactionFromMessage(transcript[0]!)).toMatchObject({
        mode: "manual",
        running: true,
      });

      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "message-compact",
            role: "assistant",
            sessionID: "session-compact",
            summary: true,
            time: { created: 1_700_000_000_000 },
          },
        },
      });
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "summary-text",
            sessionID: "session-compact",
            messageID: "message-compact",
            type: "text",
            text: "internal summary",
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.compaction.ended",
        properties: {
          sessionID: "session-compact",
          messageID: "message-compact",
          reason: "manual",
          timestamp: 1_700_000_004_000,
        },
      });

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-compact", "session-compact"),
      ) ?? [];
      expect(transcript).toHaveLength(1);
      expect(transcript[0]?.parts.filter((part) => getSessionCompactionFromMessage({
        id: "probe",
        role: "assistant",
        parts: [part],
      })).length).toBe(1);
      expect(getSessionCompactionFromMessage(transcript[0]!)).toEqual({
        mode: "manual",
        running: false,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_004_000,
      });
      expect(useSessionActivityStore.getState().getStatus("workspace-compact", "session-compact")).not.toBe("compacting");
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession("workspace-compact", "session-compact");
    }
  });

  test("live sync removes synthetic compaction continuation messages under either event order", () => {
    const workspaceId = "workspace-live-auto-continue";
    const sessionId = "session-live-auto-continue";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);

    const continuationPart = (messageID: string, id: string) => ({
      id,
      sessionID: sessionId,
      messageID,
      type: "text" as const,
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
      synthetic: true,
      metadata: { compaction_continue: true },
      time: { start: 1_700_000_003_200, end: 1_700_000_003_200 },
    });

    try {
      // message.updated first: remove the empty shell when the marked part arrives.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "continue-message-first",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_003_200 },
          },
        },
      } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
      )?.find((message) => message.id === "continue-message-first")).toBeDefined();

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: continuationPart("continue-message-first", "continue-part-first") },
      } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
      )?.find((message) => message.id === "continue-message-first")).toBeUndefined();

      // part first: remember the implementation message so a later message
      // event cannot recreate the empty user boundary.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: continuationPart("continue-part-first", "continue-part-second") },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "continue-part-first",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_004_000 },
          },
        },
      } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
      )?.find((message) => message.id === "continue-part-first")).toBeUndefined();

      // A real user message with similar wording remains a genuine boundary.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "real-user-continue",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_005_000 },
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "real-user-continue-part",
            sessionID: sessionId,
            messageID: "real-user-continue",
            type: "text",
            text: "任务继续",
          },
        },
      } as any);
      expect(getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey(workspaceId, sessionId),
      )?.find((message) => message.id === "real-user-continue")?.parts).toMatchObject([
        { type: "text", text: "任务继续" },
      ]);
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("continuation suppression is session-scoped and survives unrelated removals", () => {
    const workspaceId = "workspace-continue-scope";
    const sessionA = "session-continue-a";
    const sessionB = "session-continue-b";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const releaseA = trackWorkspaceSessionSync(syncInput, sessionA);
    const releaseB = trackWorkspaceSessionSync(syncInput, sessionB);
    const sharedId = "shared-message-id";

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "continue-part-a",
            sessionID: sessionA,
            messageID: sharedId,
            type: "text",
            text: "Continue if you have next steps",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: 1, end: 1 },
          },
        },
      } as any);

      // The same message id in another session is a real user turn and must
      // not be swallowed by session A's tombstone.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: sharedId, role: "user", sessionID: sessionB, time: { created: 2 } } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: { id: "b-part", sessionID: sessionB, messageID: sharedId, type: "text", text: "Real prompt" },
        },
      } as any);
      const transcriptB = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionB)) ?? [];
      expect(transcriptB.find((message) => message.id === sharedId)?.parts).toMatchObject([
        { type: "text", text: "Real prompt" },
      ]);

      // Removing session B's message must not clear session A's tombstone.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.removed",
        properties: { sessionID: sessionB, messageID: sharedId },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: sharedId, role: "user", sessionID: sessionA, time: { created: 3 } } },
      } as any);
      const transcriptA = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionA)) ?? [];
      expect(transcriptA.find((message) => message.id === sharedId)).toBeUndefined();
    } finally {
      releaseA();
      releaseB();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionA);
      useSessionActivityStore.getState().removeSession(workspaceId, sessionB);
    }
  });

  test("keeps visible content that shares a message with the continuation marker", () => {
    const workspaceId = "workspace-continue-mixed";
    const sessionId = "session-continue-mixed";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "mixed-msg", role: "user", sessionID: sessionId, time: { created: 1 } } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: { id: "mixed-text", sessionID: sessionId, messageID: "mixed-msg", type: "text", text: "Keep this visible" },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "mixed-continue",
            sessionID: sessionId,
            messageID: "mixed-msg",
            type: "text",
            text: "Continue if you have next steps",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: 2, end: 2 },
          },
        },
      } as any);

      const read = () => getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
      expect(read().find((message) => message.id === "mixed-msg")?.parts).toMatchObject([
        { type: "text", text: "Keep this visible" },
      ]);

      // The real message keeps its lifecycle: a later message.updated still
      // applies and must not wipe the visible part.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "mixed-msg", role: "user", sessionID: sessionId, time: { created: 1, completed: 3 } } },
      } as any);
      expect(read().find((message) => message.id === "mixed-msg")?.parts).toMatchObject([
        { type: "text", text: "Keep this visible" },
      ]);
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("drops buffered deltas for a suppressed continuation message", async () => {
    const workspaceId = "workspace-continue-delta";
    const sessionId = "session-continue-delta";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);

    try {
      // A delta can beat the part declaration; it buffers without a shell.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: { sessionID: sessionId, messageID: "cont-delta", partID: "cont-delta-part", delta: "Continue" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 20));

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "cont-delta-part",
            sessionID: sessionId,
            messageID: "cont-delta",
            type: "text",
            text: "Continue if you have next steps",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: 1, end: 1 },
          },
        },
      } as any);

      // Deltas that arrive after suppression must neither buffer nor
      // resurrect the implementation message.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: { sessionID: sessionId, messageID: "cont-delta", partID: "cont-delta-part", delta: " more" },
      } as any);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
      expect(transcript.find((message) => message.id === "cont-delta")).toBeUndefined();
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("session.deleted clears continuation suppression for that session", () => {
    const workspaceId = "workspace-continue-deleted";
    const sessionId = "session-continue-deleted";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "continue-part",
            sessionID: sessionId,
            messageID: "recycle-id",
            type: "text",
            text: "Continue if you have next steps",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: 1, end: 1 },
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "recycle-id", role: "user", sessionID: sessionId, time: { created: 2 } } },
      } as any);
      expect((getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [])
        .find((message) => message.id === "recycle-id")).toBeUndefined();

      __applySessionSyncEventForTest(syncInput, {
        type: "session.deleted",
        properties: { sessionID: sessionId },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "recycle-id", role: "user", sessionID: sessionId, time: { created: 3 } } },
      } as any);
      expect((getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [])
        .find((message) => message.id === "recycle-id")).toBeDefined();
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("live automatic compaction with a stale snapshot stays one task end to end", () => {
    const workspaceId = "workspace-continue-e2e";
    const sessionId = "session-continue-e2e";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);
    const t0 = 1_700_000_000_000;
    const t1 = t0 + 500;
    const t1b = t0 + 1_000;
    const t2 = t0 + 1_500;
    const t3 = t0 + 2_500;
    const t5 = t0 + 3_500;
    const t5b = t0 + 4_000;

    const userEvent = (id: string, role: "user" | "assistant", created: number, extra: Record<string, unknown> = {}) =>
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id, role, sessionID: sessionId, time: { created, ...(role === "assistant" ? { completed: created + 100 } : {}) }, ...extra } },
      } as any);
    const textPartEvent = (partId: string, messageID: string, text: string) =>
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: { id: partId, sessionID: sessionId, messageID, type: "text", text } },
      } as any);

    try {
      userEvent("user-1", "user", t0);
      textPartEvent("user-1-text", "user-1", "Do it");
      userEvent("assistant-before", "assistant", t1);
      textPartEvent("assistant-before-text", "assistant-before", "Progress before compaction");

      // Automatic compaction lifecycle creates the receipt with mode auto.
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.compaction.started",
        properties: { sessionID: sessionId, messageID: "summary-live", reason: "auto", timestamp: t2 },
      } as any);
      textPartEvent("summary-live-text", "summary-live", "internal automatic summary");
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "summary-live", role: "assistant", sessionID: sessionId, summary: true, time: { created: t2, completed: t3 } } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.compaction.ended",
        properties: { sessionID: sessionId, messageID: "summary-live", reason: "auto", timestamp: t3 },
      } as any);

      // The synthetic continuation is suppressed out of the transcript.
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "cont-live",
            sessionID: sessionId,
            messageID: "cont-live",
            type: "text",
            text: "Continue if you have next steps",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: t5 - 300, end: t5 - 300 },
          },
        },
      } as any);

      userEvent("assistant-after", "assistant", t5);

      const liveTranscript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
      expect(liveTranscript.find((message) => message.id === "cont-live")).toBeUndefined();
      expect(getSessionCompactionFromMessage(liveTranscript.find((message) => message.id === "summary-live")!)).toMatchObject({
        mode: "auto",
        running: false,
      });
      const liveGrouped = groupMessages(deriveRenderedSessionMessages({ transcriptState: liveTranscript, snapshot: null }), "ready");
      expect(liveGrouped).toHaveLength(2);
      expect(isMessageGroup(liveGrouped[1]!)).toBeTrue();
      if (!isMessageGroup(liveGrouped[1]!)) throw new Error("expected one assistant task group");
      expect(liveGrouped[1].messages.map((item) => item.message.id)).toEqual([
        "assistant-before",
        "summary-live",
        "assistant-after",
      ]);

      // A stale snapshot completes late: it carries a bare continuation
      // shell (marker part not persisted yet) and the summary without its
      // boundary, which alone would map to mode unknown.
      seedSessionState(workspaceId, {
        session: { id: sessionId },
        status: { type: "idle" },
        todos: [],
        messages: [
          {
            info: { id: "user-1", role: "user", sessionID: sessionId, time: { created: t0 } },
            parts: [{ id: "user-1-text", sessionID: sessionId, messageID: "user-1", type: "text", text: "Do it" }],
          },
          {
            info: { id: "assistant-before", role: "assistant", sessionID: sessionId, time: { created: t1, completed: t1b } },
            parts: [{ id: "assistant-before-text", sessionID: sessionId, messageID: "assistant-before", type: "text", text: "Progress before compaction" }],
          },
          {
            info: { id: "cont-live", role: "user", sessionID: sessionId, time: { created: t5 - 300 } },
            parts: [],
          },
          {
            info: { id: "summary-live", role: "assistant", sessionID: sessionId, summary: true, time: { created: t2, completed: t3 } },
            parts: [{ id: "summary-live-text", sessionID: sessionId, messageID: "summary-live", type: "text", text: "internal automatic summary" }],
          },
          {
            info: { id: "assistant-after", role: "assistant", sessionID: sessionId, time: { created: t5, completed: t5b } },
            parts: [{ id: "assistant-after-text", sessionID: sessionId, messageID: "assistant-after", type: "text", text: "Final output after compaction" }],
          },
        ],
      } as any);

      const mergedTranscript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
      expect(mergedTranscript.find((message) => message.id === "cont-live")).toBeUndefined();
      expect(getSessionCompactionFromMessage(mergedTranscript.find((message) => message.id === "summary-live")!)).toMatchObject({
        mode: "auto",
        running: false,
      });
      const mergedGrouped = groupMessages(deriveRenderedSessionMessages({ transcriptState: mergedTranscript, snapshot: null }), "ready");
      expect(mergedGrouped).toHaveLength(2);
      expect(isMessageGroup(mergedGrouped[1]!)).toBeTrue();
      if (!isMessageGroup(mergedGrouped[1]!)) throw new Error("expected one assistant task group after snapshot");
      expect(mergedGrouped[1].messages.map((item) => item.message.id)).toEqual([
        "assistant-before",
        "summary-live",
        "assistant-after",
      ]);
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("completed summary metadata finishes compaction when the ended event is missed", () => {
    const syncInput = { workspaceId: "workspace-compact-summary", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-compact-summary");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.compaction.started",
        properties: {
          sessionID: "session-compact-summary",
          messageID: "message-compact-summary",
          reason: "manual",
          timestamp: 1_700_000_000_000,
        },
      });
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "message-compact-summary",
            role: "assistant",
            sessionID: "session-compact-summary",
            summary: true,
            time: { created: 1_700_000_000_000, completed: 1_700_000_004_000 },
          },
        },
      });

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-compact-summary", "session-compact-summary"),
      ) ?? [];
      expect(getSessionCompactionFromMessage(transcript[0]!)).toEqual({
        mode: "manual",
        running: false,
        startedAt: 1_700_000_000_000,
        finishedAt: 1_700_000_004_000,
      });
      expect(useSessionActivityStore.getState().getStatus(
        "workspace-compact-summary",
        "session-compact-summary",
      )).not.toBe("compacting");
    } finally {
      release();
      cleanup();
      useSessionActivityStore.getState().removeSession("workspace-compact-summary", "session-compact-summary");
    }
  });

  test("snapshot compaction boundaries stay invisible until the summary completes", () => {
    const workspaceId = "workspace-compact-snapshot";
    const sessionId = "session-compact-snapshot";
    const snapshot = {
      session: { id: sessionId },
      status: { type: "busy" },
      todos: [],
      messages: [
        {
          info: {
            id: "message-before-compaction",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_000_000 },
          },
          parts: [{
            id: "compaction-boundary",
            sessionID: sessionId,
            messageID: "message-before-compaction",
            type: "compaction",
            auto: false,
          }],
        },
        {
          info: {
            id: "message-compaction-summary",
            role: "assistant",
            sessionID: sessionId,
            summary: true,
            time: { created: 1_700_000_001_000 },
          },
          parts: [{
            id: "summary-text",
            sessionID: sessionId,
            messageID: "message-compaction-summary",
            type: "text",
            text: "internal summary in progress",
          }],
        },
      ],
    } as any;

    seedSessionState(workspaceId, snapshot);

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
    ) ?? [];
    expect(transcript.find((message) => message.id === "message-before-compaction")).toBeUndefined();

    const rendered = deriveRenderedSessionMessages({ transcriptState: transcript, snapshot: null });
    expect(rendered.some((message) => (
      getSessionCompactionFromMessage(message)?.running === false
    ))).toBeFalse();
    expect(getSessionCompactionFromMessage(
      rendered.find((message) => message.id === "message-compaction-summary")!,
    )).toMatchObject({ running: true });

    useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
  });

  test("snapshot keeps output around automatic compaction in one task group", () => {
    const workspaceId = "workspace-auto-compact-snapshot";
    const sessionId = "session-auto-compact-snapshot";
    const snapshot = {
      session: { id: sessionId },
      status: { type: "idle" },
      todos: [],
      messages: [
        {
          info: {
            id: "task-prompt",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_000_000 },
          },
          parts: [{
            id: "task-prompt-text",
            sessionID: sessionId,
            messageID: "task-prompt",
            type: "text",
            text: "Complete the task",
          }],
        },
        {
          info: {
            id: "assistant-before-auto-compaction",
            role: "assistant",
            sessionID: sessionId,
            time: { created: 1_700_000_000_500, completed: 1_700_000_001_000 },
          },
          parts: [{
            id: "assistant-before-text",
            sessionID: sessionId,
            messageID: "assistant-before-auto-compaction",
            type: "text",
            text: "Progress before compaction",
          }],
        },
        {
          info: {
            id: "message-before-auto-compaction",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_001_500 },
          },
          parts: [{
            id: "auto-compaction-boundary",
            sessionID: sessionId,
            messageID: "message-before-auto-compaction",
            type: "compaction",
            auto: true,
          }],
        },
        {
          info: {
            id: "message-auto-compaction-summary",
            role: "assistant",
            sessionID: sessionId,
            summary: true,
            time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
          },
          parts: [{
            id: "auto-summary-text",
            sessionID: sessionId,
            messageID: "message-auto-compaction-summary",
            type: "text",
            text: "internal automatic summary",
          }],
        },
        {
          info: {
            id: "assistant-after-auto-compaction",
            role: "assistant",
            sessionID: sessionId,
            time: { created: 1_700_000_003_500, completed: 1_700_000_004_000 },
          },
          parts: [{
            id: "assistant-after-text",
            sessionID: sessionId,
            messageID: "assistant-after-auto-compaction",
            type: "text",
            text: "Final output after compaction",
          }],
        },
      ],
    } as any;

    seedSessionState(workspaceId, snapshot);

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
    ) ?? [];
    expect(transcript.find((message) => message.id === "message-before-auto-compaction")).toBeUndefined();
    expect(getSessionCompactionFromMessage(
      transcript.find((message) => message.id === "message-auto-compaction-summary")!,
    )).toEqual({
      mode: "auto",
      running: false,
      startedAt: 1_700_000_002_000,
      finishedAt: 1_700_000_003_000,
    });

    const rendered = deriveRenderedSessionMessages({ transcriptState: transcript, snapshot: null });
    const grouped = groupMessages(rendered, "ready");
    expect(grouped).toHaveLength(2);
    expect(isMessageGroup(grouped[1]!)).toBeTrue();
    if (!isMessageGroup(grouped[1]!)) throw new Error("expected one assistant task group");
    expect(grouped[1].messages.map((item) => item.message.id)).toEqual([
      "assistant-before-auto-compaction",
      "message-auto-compaction-summary",
      "assistant-after-auto-compaction",
    ]);

    useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
  });

  test("snapshot drops the synthetic continue prompt after automatic compaction", () => {
    const workspaceId = "workspace-auto-compact-continue";
    const sessionId = "session-auto-compact-continue";
    const snapshot = {
      session: { id: sessionId },
      status: { type: "idle" },
      todos: [],
      messages: [
        {
          info: {
            id: "task-prompt",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_000_000 },
          },
          parts: [{
            id: "task-prompt-text",
            sessionID: sessionId,
            messageID: "task-prompt",
            type: "text",
            text: "Complete the task",
          }],
        },
        {
          info: {
            id: "assistant-before-auto-compaction",
            role: "assistant",
            sessionID: sessionId,
            time: { created: 1_700_000_000_500, completed: 1_700_000_001_000 },
          },
          parts: [{
            id: "assistant-before-text",
            sessionID: sessionId,
            messageID: "assistant-before-auto-compaction",
            type: "text",
            text: "Progress before compaction",
          }],
        },
        {
          info: {
            id: "auto-compaction-boundary-message",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_001_500 },
          },
          parts: [{
            id: "auto-compaction-boundary",
            sessionID: sessionId,
            messageID: "auto-compaction-boundary-message",
            type: "compaction",
            auto: true,
          }],
        },
        {
          info: {
            id: "message-auto-compaction-summary",
            role: "assistant",
            sessionID: sessionId,
            summary: true,
            time: { created: 1_700_000_002_000, completed: 1_700_000_003_000 },
          },
          parts: [{
            id: "auto-summary-text",
            sessionID: sessionId,
            messageID: "message-auto-compaction-summary",
            type: "text",
            text: "internal automatic summary",
          }],
        },
        {
          info: {
            id: "compaction-continue-prompt",
            role: "user",
            sessionID: sessionId,
            time: { created: 1_700_000_003_200 },
          },
          parts: [{
            id: "compaction-continue-text",
            sessionID: sessionId,
            messageID: "compaction-continue-prompt",
            type: "text",
            text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
            synthetic: true,
            metadata: { compaction_continue: true },
            time: { start: 1_700_000_003_200, end: 1_700_000_003_200 },
          }],
        },
        {
          info: {
            id: "assistant-after-continue",
            role: "assistant",
            sessionID: sessionId,
            time: { created: 1_700_000_003_500, completed: 1_700_000_004_000 },
          },
          parts: [{
            id: "assistant-after-text",
            sessionID: sessionId,
            messageID: "assistant-after-continue",
            type: "text",
            text: "Final output after compaction",
          }],
        },
      ],
    } as any;

    seedSessionState(workspaceId, snapshot);

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
      transcriptKey(workspaceId, sessionId),
    ) ?? [];
    expect(transcript.find((message) => message.id === "auto-compaction-boundary-message")).toBeUndefined();
    expect(transcript.find((message) => message.id === "compaction-continue-prompt")).toBeUndefined();

    const rendered = deriveRenderedSessionMessages({ transcriptState: transcript, snapshot: null });
    const grouped = groupMessages(rendered, "ready");
    expect(grouped).toHaveLength(2);
    expect(isMessageGroup(grouped[1]!)).toBeTrue();
    if (!isMessageGroup(grouped[1]!)) throw new Error("expected one assistant task group");
    expect(grouped[1].messages.map((item) => item.message.id)).toEqual([
      "assistant-before-auto-compaction",
      "message-auto-compaction-summary",
      "assistant-after-continue",
    ]);

    useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
  });

  test("snapshot keeps visible content attached to a compaction boundary", () => {
    const sessionId = "session-visible-boundary";
    const messages = snapshotToUIMessages({
      session: { id: sessionId },
      status: { type: "idle" },
      todos: [],
      messages: [{
        info: {
          id: "visible-boundary-message",
          role: "user",
          sessionID: sessionId,
          time: { created: 1_700_000_000_000 },
        },
        parts: [
          {
            id: "visible-boundary-text",
            sessionID: sessionId,
            messageID: "visible-boundary-message",
            type: "text",
            text: "Keep this visible text",
          },
          {
            id: "visible-boundary-part",
            sessionID: sessionId,
            messageID: "visible-boundary-message",
            type: "compaction",
            auto: true,
          },
        ],
      }],
    } as any);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts).toMatchObject([{ type: "text", text: "Keep this visible text" }]);
  });

  test("delivers untracked session lifecycle events for sidebar synchronization", () => {
    const created: Session = {
      id: "session-created",
      slug: "session-created",
      projectID: "project-a",
      directory: "/tmp/workspace-a",
      title: "Created in the background",
      version: "1",
      time: { created: 1, updated: 1 },
    };
    const createdIds: string[] = [];
    const deletedIds: string[] = [];
    const syncInput = {
      workspaceId: "workspace-a",
      baseUrl: "http://127.0.0.1:1234",
      juggleworkToken: "token",
      onSessionCreated: (session: Session) => createdIds.push(session.id),
      onSessionDeleted: (sessionId: string) => deletedIds.push(sessionId),
    };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.created",
        properties: { sessionID: created.id, info: created },
      });
      __applySessionSyncEventForTest(syncInput, {
        type: "session.deleted",
        properties: { sessionID: created.id, info: created },
      });

      expect(createdIds).toEqual([created.id]);
      expect(deletedIds).toEqual([created.id]);
    } finally {
      cleanup();
    }
  });

  test("an aborted assistant message ends the run even without session.idle", () => {
    const syncInput = { workspaceId: "workspace-abort", baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const activity = useSessionActivityStore.getState();

    try {
      activity.setRunStatus("workspace-abort", "session-abort", { type: "busy" });
      expect(useSessionActivityStore.getState().getStatus("workspace-abort", "session-abort")).toBe("thinking");

      // 中断只写在助手消息上：引擎不一定再发 session.error，session.idle 也可能随 SSE 重连丢失。
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-abort",
            role: "assistant",
            sessionID: "session-abort",
            error: { name: "MessageAbortedError", data: {} },
          },
        },
      } as any);

      expect(useSessionActivityStore.getState().getStatus("workspace-abort", "session-abort")).toBe("idle");

      // 折叠工作区后侧栏仍在重放运行期间的 busy 列表快照，loading 不能因此回来。
      activity.seedWorkspaceSessions("workspace-abort", [{ id: "session-abort", status: { type: "busy" } }]);
      expect(useSessionActivityStore.getState().getStatus("workspace-abort", "session-abort")).toBe("idle");
    } finally {
      cleanup();
      useSessionActivityStore.getState().removeSession("workspace-abort", "session-abort");
    }
  });

  test("retry parts remain presentation state and do not count as meaningful progress", () => {
    const workspaceId = "workspace-retry-part";
    const sessionId = "session-retry-part";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);
    const activity = useSessionActivityStore.getState();

    try {
      activity.setRunStatus(workspaceId, sessionId, { type: "busy" });
      const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt!;
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "retry-part-1",
            sessionID: sessionId,
            messageID: "assistant-retry",
            type: "retry",
            attempt: 2,
            error: { name: "APIError", data: { message: "Provider stream failed" } },
            time: { created: startedAt + 5_000 },
          },
        },
      } as any);

      const record = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
      expect(record.providerRetry?.attempt).toBe(2);
      expect(record.lastMeaningfulProgressAt).toBe(startedAt);
      expect(record.lastRuntimeEventAt).toBe(startedAt + 5_000);
      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
      expect(transcript.flatMap((message) => message.parts)).toEqual([]);
    } finally {
      release();
      cleanup();
      activity.removeSession(workspaceId, sessionId);
    }
  });

  test("session.next.retried records provider degradation while the session stays busy", () => {
    const workspaceId = "workspace-retry-event";
    const sessionId = "session-retry-event";
    const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", juggleworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.next.retried",
        properties: {
          timestamp: 1_700_000_005_000,
          sessionID: sessionId,
          attempt: 4,
          error: { name: "APIError", data: { message: "Upstream unavailable" } },
        },
      } as any);

      const record = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
      expect(record.runActive).toBeTrue();
      expect(record.status).toBe("retrying");
      expect(record.providerRetry?.attempt).toBe(4);
      expect(record.providerRetry?.observedAt).toBe(1_700_000_005_000);
      expect(record.lastRuntimeEventAt).toBeGreaterThanOrEqual(1_700_000_005_000);
    } finally {
      cleanup();
      useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
    }
  });

  test("active snapshots restore retry activity without creating transcript text", () => {
    const workspaceId = "workspace-retry-snapshot";
    const sessionId = "session-retry-snapshot";
    seedSessionState(workspaceId, {
      session: { id: sessionId },
      status: { type: "busy" },
      todos: [],
      messages: [
        {
          info: { id: "user-retry", role: "user", sessionID: sessionId, time: { created: 100 } },
          parts: [{ id: "user-text", sessionID: sessionId, messageID: "user-retry", type: "text", text: "Continue" }],
        },
        {
          info: { id: "assistant-retry", role: "assistant", sessionID: sessionId, time: { created: 200 } },
          parts: [{
            id: "retry-part",
            sessionID: sessionId,
            messageID: "assistant-retry",
            type: "retry",
            attempt: 3,
            error: { name: "APIError", data: { message: "Provider timeout" } },
            time: { created: 300 },
          }],
        },
      ],
    } as any);

    const record = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
    expect(record.providerRetry?.attempt).toBe(3);
    expect(record.status).toBe("retrying");
    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId)) ?? [];
    expect(transcript.flatMap((message) => message.parts).some((part) => part.type === "text" && part.text.includes("Provider"))).toBeFalse();
    useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
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
});

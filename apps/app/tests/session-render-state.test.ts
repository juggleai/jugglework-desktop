import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { JuggleWorkSessionMessage, JuggleWorkSessionMessagesResponse, JuggleWorkSessionSnapshot } from "../src/app/lib/jugglework-server";

import { captureSessionHistoryEdit, deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { createSessionCompactionUIPart, getSessionCompactionFromMessage } from "../src/app/lib/session-compaction";

const message = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

const rawMessage = (id: string, role: "user" | "assistant", text: string, created: number, extra: Record<string, unknown> = {}): JuggleWorkSessionMessage => ({
  info: { id, sessionID: "root", role, time: { created }, ...extra },
  parts: [{ id: `${id}:text`, sessionID: "root", messageID: id, type: "text", text }],
}) as JuggleWorkSessionMessage;

const snapshotWith = (messages: JuggleWorkSessionMessage[]): JuggleWorkSessionSnapshot => ({
  session: { id: "root", title: "root", version: "0", time: { created: 1, updated: 10 } },
  messages,
  status: { type: "idle" },
  todos: [],
}) as JuggleWorkSessionSnapshot;

describe("session render state", () => {
  test("history edits capture the persisted tail even when only its synthetic error card is rendered", () => {
    const user = rawMessage("user", "user", "generate an image", 1);
    const failed = rawMessage("failed", "assistant", "", 2, {
      error: { name: "APIError", data: { message: "Forbidden", statusCode: 403 } },
    });
    failed.parts = [];
    const snapshot = snapshotWith([user, failed]);
    const rendered = deriveRenderedSessionMessages({ snapshot, transcriptState: [] });
    expect(rendered.map((message) => message.id)).toEqual(["user", "session-error:failed"]);

    const edit = captureSessionHistoryEdit(snapshot, "workspace", user.info.id, "try again");
    expect(edit).toEqual({ workspaceId: "workspace", sessionId: "root", messageId: "user", lastMessageId: "failed", text: "try again" });

    snapshot.messages.push(rawMessage("later", "user", "another task", 3));
    expect(edit?.lastMessageId).toBe("failed");
    expect(captureSessionHistoryEdit(snapshot, "workspace", user.info.id, "retry")?.lastMessageId).toBe("later");
    expect(captureSessionHistoryEdit(snapshotWith([]), "workspace", user.info.id, "retry")).toBeNull();
  });

  test("an obsolete revert cursor cannot truncate the recovered live history", () => {
    const live = [message("answer", "restored answer")];
    const snapshot = { session: { id: "root", revert: { messageID: "answer" } }, messages: [], status: { type: "idle" }, todos: [] } as unknown as JuggleWorkSessionSnapshot;
    expect(deriveRenderedSessionMessages({ snapshot, transcriptState: live, snapshotCurrent: false })).toEqual(live);
  });
  test("removes legacy completion diagnostics before presentation", () => {
    const rendered = deriveRenderedSessionMessages({
      snapshot: null,
      transcriptState: [
        message("assistant-final", "Real final summary"),
        message("session-run-diagnostic:user-1", "Task incomplete.\nfinish_reason: stop"),
      ],
    });

    expect(rendered.map((entry) => entry.id)).toEqual(["assistant-final"]);
    expect(rendered[0]?.parts).toEqual([{ type: "text", text: "Real final summary" }]);
  });

  test("removes compaction summary prose from every rendered transcript consumer", () => {
    const rendered = deriveRenderedSessionMessages({
      snapshot: null,
      transcriptState: [{
        id: "compaction-message",
        role: "assistant",
        metadata: { opencode: { created: 100, completed: 200, summary: true } },
        parts: [
          { type: "text", text: "internal summary detail" },
          createSessionCompactionUIPart({
            partId: "compaction-part",
            mode: "auto",
            running: false,
            startedAt: 100,
            finishedAt: 200,
          }),
        ],
      }],
    });

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.parts).toHaveLength(1);
    expect(getSessionCompactionFromMessage(rendered[0]!)).toMatchObject({
      mode: "auto",
      running: false,
    });
    expect(rendered[0]?.parts.some((part) => part.type === "text" && part.text.includes("internal summary"))).toBe(false);
  });

  test("merges historical raw pages before presentation so compaction and synthetic boundaries can cross pages", () => {
    const boundary = rawMessage("m1", "user", "", 1);
    boundary.parts = [{ id: "compact", sessionID: "root", messageID: "m1", type: "compaction", auto: true } as never];
    const continuation = rawMessage("m2", "user", "Continue", 2);
    continuation.parts = [{ id: "continue", sessionID: "root", messageID: "m2", type: "text", text: "Continue", synthetic: true, metadata: { compaction_continue: true } } as never];
    const historyPages: JuggleWorkSessionMessagesResponse[] = [{
      items: [boundary, continuation],
      page: { olderCursor: null, hasOlder: false },
    }];
    const summary = rawMessage("m3", "assistant", "internal summary", 3, { summary: true });

    const rendered = deriveRenderedSessionMessages({
      snapshot: snapshotWith([summary, rawMessage("m4", "assistant", "visible", 4)]),
      transcriptState: [],
      historyPages,
    });

    expect(rendered.map((item) => item.id)).toEqual(["m3", "m4"]);
    expect(getSessionCompactionFromMessage(rendered[0]!)).toMatchObject({ mode: "auto" });
    expect(rendered[0]?.parts.some((part) => part.type === "text" && part.text.includes("internal summary"))).toBe(false);
  });

  test("keeps live records authoritative over overlapping historical and refreshed snapshot records", () => {
    const historyPages: JuggleWorkSessionMessagesResponse[] = [{
      items: [rawMessage("m1", "user", "old", 1), rawMessage("m2", "assistant", "historical", 2)],
      page: { olderCursor: null, hasOlder: false },
    }];
    const live = [{
      ...message("m2", "live output"),
      parts: [{ type: "text" as const, text: "live output", providerMetadata: { opencode: { partId: "m2:text" } } }],
      metadata: { opencode: { created: 2, completed: 9, stopped: true } },
    }];

    const rendered = deriveRenderedSessionMessages({
      snapshot: snapshotWith([rawMessage("m2", "assistant", "snapshot refresh", 2), rawMessage("m3", "assistant", "current", 3)]),
      transcriptState: live,
      historyPages,
    });

    expect(rendered.map((item) => item.id)).toEqual(["m1", "m2", "m3"]);
    expect(rendered[1]?.parts).toEqual(live[0]!.parts);
    expect(rendered[1]?.metadata).toMatchObject({ opencode: { stopped: true, completed: 9 } });
  });

  test("applies a snapshot revert cursor across the history-page boundary", () => {
    const snapshot = snapshotWith([rawMessage("m3", "assistant", "reverted", 3), rawMessage("m4", "assistant", "later", 4)]);
    snapshot.session.revert = { messageID: "m2" };
    const rendered = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [],
      historyPages: [{ items: [rawMessage("m1", "user", "kept", 1), rawMessage("m2", "assistant", "cursor", 2)], page: { olderCursor: null, hasOlder: false } }],
    });

    expect(rendered.map((item) => item.id)).toEqual(["m1"]);
  });

  test("uses the raw revert cursor to fence a live duplicate at the page boundary", () => {
    const snapshot = snapshotWith([rawMessage("m3", "assistant", "current", 3)]);
    snapshot.session.revert = { messageID: "m2" };
    const rendered = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [message("m2", "stale live cursor"), message("m3", "stale live tail")],
      historyPages: [{ items: [rawMessage("m1", "user", "kept", 1), rawMessage("m2", "assistant", "cursor", 2)], page: { olderCursor: null, hasOlder: false } }],
    });

    expect(rendered.map((item) => item.id)).toEqual(["m1"]);
  });

  test("does not expose a stale live tail when the revert cursor is the first loaded raw message", () => {
    const snapshot = snapshotWith([
      rawMessage("m300", "assistant", "cursor", 300),
      rawMessage("m301", "assistant", "later", 301),
    ]);
    snapshot.session.revert = { messageID: "m300" };

    const rendered = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [message("m301", "stale live tail")],
    });

    expect(rendered).toEqual([]);
  });

  test("keeps legal older history without appending a live-only tail after a snapshot revert cursor", () => {
    const snapshot = snapshotWith([
      rawMessage("m3", "assistant", "cursor", 3),
      rawMessage("m4", "assistant", "later", 4),
    ]);
    snapshot.session.revert = { messageID: "m3" };

    const rendered = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [message("m4", "stale live tail")],
      historyPages: [{
        items: [rawMessage("m1", "user", "kept", 1), rawMessage("m2", "assistant", "kept", 2)],
        page: { olderCursor: null, hasOlder: false },
      }],
    });

    expect(rendered.map((item) => item.id)).toEqual(["m1", "m2"]);
  });

  test("fails closed when the revert cursor is older than the loaded window", () => {
    const snapshot = snapshotWith([rawMessage("m300", "assistant", "must hide", 300)]);
    snapshot.session.revert = { messageID: "m100" };
    snapshot.messagePage = { olderCursor: "before-m300", hasOlder: true };

    const rendered = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [message("m301", "stale live tail")],
    });

    expect(rendered).toEqual([]);
  });

  test("fails closed for a legacy bounded snapshot that cannot prove the missing revert boundary is fully loaded", () => {
    const snapshot = snapshotWith([rawMessage("m300", "assistant", "must hide", 300)]);
    snapshot.session.revert = { messageID: "m100" };

    expect(deriveRenderedSessionMessages({ snapshot, transcriptState: [] })).toEqual([]);
  });
});

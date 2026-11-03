import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { mergeSnapshotAndLiveMessages } from "../src/react-app/domains/session/sync/message-merge";
import { applyRevertCursor } from "../src/react-app/domains/session/sync/transcript-reconcile";

type Part = UIMessage["parts"][number];
const text = (partId: string, value: string): Part => ({
  type: "text", text: value, state: "done", providerMetadata: { opencode: { partId } },
});
const message = (id: string, parts: Part[], role: UIMessage["role"] = "assistant"): UIMessage => ({ id, role, parts });
const recover = (snapshot: UIMessage[], live: UIMessage[]) => mergeSnapshotAndLiveMessages(snapshot, live, {
  appendLiveOnlyMessages: true, preserveLiveMessages: true,
});

describe("stale snapshot part recovery", () => {
  test("fills metadata-only user and assistant shells without replacing live terminal metadata", () => {
    const snapshot = [message("u", [text("u-text", "task")], "user"), message("a", [text("a-text", "reply")])];
    const metadata = { opencode: { created: 2, completed: 3, stopped: true, finish: "stop" } };
    const live = [message("u", [], "user"), { ...message("a", []), metadata }];
    const result = recover(snapshot, live);
    expect(result.map((item) => item.parts)).toEqual(snapshot.map((item) => item.parts));
    expect(result[1]!.metadata).toBe(metadata);
    expect(live.map((item) => item.parts)).toEqual([[], []]);
  });

  test("matches by part ID rather than index, retains live order and never concatenates repeated text", () => {
    const first = text("first", "same text");
    const middle = text("middle", "same text");
    const last = text("last", "snapshot last");
    const liveLast = text("last", "live last");
    const liveOnly = text("live-only", "new output");
    const live = message("a", [first, liveOnly, liveLast]);
    const snapshot = message("a", [first, middle, last, middle]);
    const result = recover([snapshot], [live])[0]!;
    expect(result.parts).toEqual([first, liveOnly, middle, liveLast]);
    expect(result.parts[3]).toBe(liveLast);
    expect(recover([snapshot], [result])[0]).toBe(result);
    expect(live.parts).toEqual([first, liveOnly, liveLast]);
    expect(snapshot.parts).toEqual([first, middle, last, middle]);
  });

  test("does not let longer stale text or stale metadata overwrite live facts", () => {
    const live = { ...message("a", [text("p", "live")]), metadata: { opencode: { stopped: true, completed: 10 } } };
    const snapshot = { ...message("a", [text("p", "much longer but obsolete")]), metadata: { opencode: { completed: 5 } } };
    expect(recover([snapshot], [live])[0]).toBe(live);
  });

  test("recovers missing reasoning, file and source parts while retaining completed tool output", () => {
    const tool: Part = { type: "dynamic-tool", toolName: "read", toolCallId: "call-1", state: "output-available", input: {}, output: "done", callProviderMetadata: { opencode: { partId: "tool-1" } } };
    const staleTool: Part = { ...tool, state: "input-available" };
    const reasoning: Part = { type: "reasoning", text: "reason", providerMetadata: { opencode: { partId: "reason" } } };
    const file: Part = { type: "file", url: "file:///mock/result.txt", mediaType: "text/plain", providerMetadata: { opencode: { partId: "file" } } };
    const source: Part = { type: "source-url", sourceId: "file:source", url: "https://example.invalid", providerMetadata: { opencode: { partId: "file:source" } } };
    const result = recover([message("a", [reasoning, staleTool, file, source])], [message("a", [tool])])[0]!;
    expect(result.parts).toEqual([reasoning, tool, file, source]);
    expect(result.parts[1]).toBe(tool);
  });

  test("does not guess identity for anonymous snapshot parts", () => {
    const anonymous: Part = { type: "text", text: "same" };
    const live = message("a", [anonymous]);
    expect(recover([message("a", [anonymous, { type: "step-start" }])], [live])[0]).toBe(live);
    expect(recover([message("a", [anonymous])], [message("a", [])])[0]!.parts).toEqual([]);
  });

  test("matches SDK tool/source aliases without duplicating projections missing part metadata", () => {
    const tool: Part = { type: "dynamic-tool", toolName: "read", toolCallId: "call", state: "output-error", input: {}, errorText: "cancelled" };
    const source: Part = { type: "source-url", sourceId: "source", url: "https://example.invalid/live" };
    const live = message("a", [tool, source]);
    const snapshot = message("a", [
      { ...tool, callProviderMetadata: { opencode: { partId: "tool" } } },
      { ...source, url: "https://example.invalid/stale", providerMetadata: { opencode: { partId: "source-part" } } },
      text("new", "recovered"),
    ]);
    const result = recover([snapshot], [live])[0]!;
    expect(result.parts).toEqual([tool, source, text("new", "recovered")]);
    expect(recover([snapshot], [result])[0]).toBe(result);
  });

  test("an existing empty live part is still authoritative, unlike a missing part", () => {
    const live = message("a", [text("p", "")]);
    expect(recover([message("a", [text("p", "obsolete")])], [live])[0]).toBe(live);
  });

  test("keeps live role and live-only messages when recovering content", () => {
    const live = message("a", [], "assistant");
    const later = message("later", [text("later-text", "later")]);
    const result = recover([message("a", [text("p", "body")], "user")], [live, later]);
    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.parts).toEqual([text("p", "body")]);
    expect(result[1]).toBe(later);
  });

  test("only recovers from history already admitted by revert and tombstone filtering", () => {
    const snapshot = [message("kept", [text("p", "kept")]), message("tombstoned", [text("t", "hidden")]), message("reverted", [text("r", "hidden")])];
    const admittedHistory = applyRevertCursor(snapshot, "reverted").filter((item) => item.id !== "tombstoned");
    const result = recover(admittedHistory, [message("kept", [])]);
    expect(result).toEqual([snapshot[0]!]);
    expect(recover([], result)).toBe(result);
  });

  test("leaves the non-preserving snapshot merge behavior unchanged", () => {
    const snapshot = message("a", [text("p", "short")]);
    const live = message("a", [text("p", "long live text")]);
    expect(mergeSnapshotAndLiveMessages([snapshot], [live])[0]!.parts).toEqual([text("p", "long live text")]);
  });
});

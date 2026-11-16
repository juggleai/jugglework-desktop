// @ts-ignore -- Colocated tests execute in Bun.
import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { promptSuggestionUserHistory } from "./prompt-suggestions-history";

type Raw = JuggleWorkSessionSnapshot["messages"][number];
const raw = (id: string, created: number, parts: unknown[], info = {}) =>
  ({ info: { id, role: "user", time: { created }, ...info }, parts }) as Raw;
const live = (id: string, created: number, parts: unknown[], metadata = {}) =>
  ({ id, role: "user", metadata: { opencode: { created, ...metadata } }, parts }) as UIMessage;

test("raw synthetic, ignored, continue and compaction-only users never advance the real frontier", () => {
  const history = promptSuggestionUserHistory([
    raw("real", 100, [{ type: "text", text: "用户请求" }, { type: "text", synthetic: true, text: "辅助说明" }]),
    raw("synthetic", 200, [{ type: "text", text: "generated", synthetic: true }]),
    raw("ignored", 300, [{ type: "text", text: "ignored", ignored: true }]),
    raw("continue", 400, [{ type: "text", text: "continue", synthetic: true, metadata: { compaction_continue: true } }]),
    raw("marker", 500, [{ type: "compaction", auto: true }]),
    raw("info", 600, [{ type: "text", text: "generated" }], { synthetic: true }),
    raw("metadata", 700, [{ type: "text", text: "continue" }], { metadata: { compaction_continue: true } }),
    raw("empty", 800, []),
  ]);
  expect(history.userCreatedAtBaseline).toBe(100);
  expect([...history.turnKeys]).toEqual(["real"]);
});

test("live control metadata, synthetic parts and raw rejected shells cannot advance the frontier", () => {
  const history = promptSuggestionUserHistory([raw("shell", 900, [{ type: "text", synthetic: true, text: "continue" }])], [
    live("real", 100, [{ type: "text", text: "用户请求" }]),
    live("shell", 900, [{ type: "text", text: "stale mapping" }]),
    live("synthetic", 200, [{ type: "text", text: "generated", synthetic: true }]),
    live("metadata", 300, [{ type: "text", text: "continue" }], { compaction_continue: true }),
    live("partmetadata", 400, [{ type: "text", text: "continue", providerMetadata: { opencode: { compaction_continue: true } } }]),
    live("compaction", 500, [{ type: "compaction" }, { type: "text", text: "marker" }]),
    live("presentation", 600, [{ type: "text", text: "marker" }], { compaction: { mode: "auto" } }),
  ]);
  expect(history.userCreatedAtBaseline).toBe(100);
  expect([...history.turnKeys]).toEqual(["real"]);
});

test("unreverted real tail, attachment-only requests and newer real users remain evidence", () => {
  const history = promptSuggestionUserHistory([
    raw("visible", 100, [{ type: "text", text: "用户请求" }]),
    raw("hidden-by-revert", 200, [{ type: "file", url: "file:///test", mime: "image/png" }]),
    raw("real-next", 300, [{ type: "text", text: "后续请求" }]),
  ]);
  expect(history.userCreatedAtBaseline).toBe(300);
  expect([...history.turnKeys]).toEqual(["visible", "hidden-by-revert", "real-next"]);
  expect(promptSuggestionUserHistory([]).userCreatedAtBaseline).toBeUndefined();
});

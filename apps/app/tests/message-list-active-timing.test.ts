import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { loadingTaskUserMessageIndex } from "../src/components/chat/utils";

function message(id: string, role: "user" | "assistant", parts: UIMessage["parts"]): UIMessage {
  return { id, role, parts, metadata: { opencode: { created: 1_700_000_000_000 } } } as UIMessage;
}

describe("active task placeholder timing", () => {
  test("uses the latest user turn before an assistant task is visible", () => {
    const messages = [message("user", "user", [{ type: "text", text: "run" }])];
    expect(loadingTaskUserMessageIndex(messages)).toBe(0);
  });

  test("keeps timing through an empty assistant shell but avoids duplicate timing after output", () => {
    const user = message("user", "user", [{ type: "text", text: "run" }]);
    const shell = message("assistant", "assistant", []);
    expect(loadingTaskUserMessageIndex([user, shell])).toBe(0);
    const output = message("assistant", "assistant", [{ type: "text", text: "working" }]);
    expect(loadingTaskUserMessageIndex([user, output])).toBe(-1);
  });
});

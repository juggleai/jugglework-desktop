import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { createSessionCompactionUIPart, getSessionCompactionFromMessage } from "../src/app/lib/session-compaction";

const message = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("session render state", () => {
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
});

import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";

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
});

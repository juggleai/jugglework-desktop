import { describe, expect, test } from "bun:test";

import { buildSessionMessages } from "./session-read-model.js";

describe("session read model output bounds", () => {
  test("bounds large read results before they cross into the renderer", () => {
    const original = `${"x".repeat(3 * 1024 * 1024)}TAIL`;
    const input = [{
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      parts: [{
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "read",
        callID: "call_1",
        state: { status: "completed", input: { filePath: "large.txt" }, output: original },
      }],
    }];

    const result = buildSessionMessages(input as never);
    const output = (result[0]!.parts[0] as any).state.output as string;
    expect(output.length).toBeLessThan(140 * 1024);
    expect(output).toContain("JuggleWork omitted");
    expect(output).toEndWith("TAIL");
    expect((input[0]!.parts[0]!.state.output)).toBe(original);
  });

  test("keeps ordinary and non-read tool output unchanged", () => {
    const input = [{
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      parts: [
        { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "tool", tool: "read", state: { status: "completed", output: "short" } },
        { id: "prt_2", messageID: "msg_1", sessionID: "ses_1", type: "tool", tool: "image", state: { status: "completed", output: "x".repeat(256 * 1024) } },
      ],
    }];
    const result = buildSessionMessages(input as never);
    expect((result[0]!.parts[0] as any).state.output).toBe("short");
    expect((result[0]!.parts[1] as any).state.output.length).toBe(256 * 1024);
  });

  test("omits oversized inline read images before the snapshot crosses into the renderer", () => {
    const largeImage = `data:image/png;base64,${"a".repeat(3 * 1024 * 1024)}`;
    const smallImage = `data:image/png;base64,${"b".repeat(1024)}`;
    const input = [{
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      parts: [{
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "figure.png" },
          output: "Read image successfully",
          attachments: [
            { type: "file", mime: "image/png", url: largeImage },
            { type: "file", mime: "image/png", url: smallImage },
          ],
        },
      }],
    }];

    const result = buildSessionMessages(input as never);
    const state = (result[0]!.parts[0] as any).state;
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0].url).toBe(smallImage);
    expect(state.metadata.juggleworkOmittedInlineImageAttachments).toBe(1);
    expect(input[0]!.parts[0]!.state.attachments[0]!.url).toBe(largeImage);
  });

  test("does not omit inline images from non-read tools", () => {
    const largeImage = `data:image/png;base64,${"a".repeat(512 * 1024)}`;
    const input = [{
      info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
      parts: [{
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool: "computer-use_cua_screenshot",
        state: {
          status: "completed",
          input: {},
          output: "done",
          attachments: [{ type: "file", mime: "image/png", url: largeImage }],
        },
      }],
    }];

    const result = buildSessionMessages(input as never);
    expect((result[0]!.parts[0] as any).state.attachments[0].url).toBe(largeImage);
  });
});

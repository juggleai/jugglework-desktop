import { describe, expect, test } from "bun:test";

import { buildSessionMessagePage, buildSessionMessages, buildSessionSnapshot } from "./session-read-model.js";
import { readOpencodeSessionMessages } from "./routes/sessions.js";

describe("session read model output bounds", () => {
  test("passes opaque cursors and cancellation through the legacy SDK wrapper", async () => {
    const controller = new AbortController();
    let capturedParameters: unknown;
    let capturedSignal: AbortSignal | undefined;
    const opencode = {
      session: {
        messages(parameters: unknown, options?: { signal?: AbortSignal }) {
          capturedParameters = parameters;
          capturedSignal = options?.signal;
          return new Promise((_, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        },
      },
    };

    const pending = readOpencodeSessionMessages(opencode as never, "ses_1", {
      limit: 100,
      before: "opaque+/cursor==",
      signal: controller.signal,
    });
    expect(capturedParameters).toEqual({ sessionID: "ses_1", limit: 100, before: "opaque+/cursor==" });
    expect(capturedSignal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("maps the opaque next cursor without interpreting it", () => {
    const cursor = "opaque+/cursor==";
    expect(buildSessionMessagePage(new Response(null, { headers: { "X-Next-Cursor": cursor } }))).toEqual({
      olderCursor: cursor,
      hasOlder: true,
    });
    expect(buildSessionMessagePage(new Response())).toEqual({ olderCursor: null, hasOlder: false });
  });

  test("includes optional message page metadata in snapshots", () => {
    const snapshot = buildSessionSnapshot({
      session: { id: "ses_1", title: "Test", directory: "/tmp", time: { created: 1, updated: 1 } },
      messages: [],
      messagePage: { olderCursor: "cursor_1", hasOlder: true },
      todos: [],
      statuses: {},
    } as never);
    expect(snapshot.messagePage).toEqual({ olderCursor: "cursor_1", hasOlder: true });
  });

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
    expect(output).toContain("北数Work omitted");
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

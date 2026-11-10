import { describe, expect, test } from "bun:test";

import { JuggleWorkScreenshotHistory } from "./jugglework-screenshot-history.js";

function screenshot(size: number, index: number) {
  return {
    id: `screenshot-${index}`,
    type: "tool",
    tool: "computer-use_cua_screenshot",
    state: {
      status: "completed",
      output: JSON.stringify({ width: 1440, height: 900 }),
      attachments: [{
        type: "file",
        mime: "image/png",
        filename: `screen-${index}.png`,
        url: `data:image/png;base64,${"a".repeat(size)}`,
      }],
      time: { start: index, end: index + 1 },
    },
  };
}

function compacted(part: ReturnType<typeof screenshot>): boolean {
  return typeof (part.state.time as { compacted?: number }).compacted === "number";
}

async function transform(messages: unknown[]) {
  const plugin = await JuggleWorkScreenshotHistory();
  const output = { messages };
  await plugin["experimental.chat.messages.transform"]({}, output);
  return output.messages;
}

describe("JuggleWorkScreenshotHistory", () => {
  test("leaves screenshot history below the byte threshold unchanged", async () => {
    const parts = [screenshot(256 * 1024, 0), screenshot(256 * 1024, 1)];
    await transform([{ role: "assistant", parts }]);
    expect(parts.some(compacted)).toBe(false);
  });

  test("compacts oldest screenshots by serialized bytes and preserves the newest two", async () => {
    const parts = Array.from({ length: 4 }, (_, index) => screenshot(4 * 1024 * 1024, index));
    await transform([{ role: "assistant", parts }]);

    expect(compacted(parts[0]!)).toBe(true);
    expect(compacted(parts[1]!)).toBe(true);
    expect(compacted(parts[2]!)).toBe(false);
    expect(compacted(parts[3]!)).toBe(false);
    // The hook only changes the request projection marker. It does not delete
    // the session's screenshot data used by the desktop transcript.
    expect(parts[0]!.state.attachments[0]!.url).toStartWith("data:image/png;base64,");
  });

  test("uses UTF-8 bytes rather than JavaScript character count", async () => {
    const parts = [screenshot(256 * 1024, 0), screenshot(256 * 1024, 1), screenshot(256 * 1024, 2)];
    const multibyteText = "界".repeat(4 * 1024 * 1024);
    expect(multibyteText.length).toBeLessThan(12 * 1024 * 1024);

    await transform([
      { role: "user", parts: [{ type: "text", text: multibyteText }] },
      { role: "assistant", parts },
    ]);

    expect(compacted(parts[0]!)).toBe(true);
    expect(compacted(parts[1]!)).toBe(false);
    expect(compacted(parts[2]!)).toBe(false);
  });

  test("does not compact non-screenshot tools or screenshots without inline image data", async () => {
    const regular = {
      type: "tool",
      tool: "shell",
      state: { status: "completed", output: "x".repeat(13 * 1024 * 1024), time: {} },
    };
    const externalScreenshot = {
      type: "tool",
      tool: "browser_screenshot",
      state: {
        status: "completed",
        output: "done",
        attachments: [{ type: "file", mime: "image/png", url: "https://example.test/screen.png" }],
        time: {},
      },
    };
    await transform([{ role: "assistant", parts: [regular, externalScreenshot] }]);
    expect((regular.state.time as { compacted?: number }).compacted).toBeUndefined();
    expect((externalScreenshot.state.time as { compacted?: number }).compacted).toBeUndefined();
  });
});

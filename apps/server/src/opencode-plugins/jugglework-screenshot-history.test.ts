import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JuggleWorkScreenshotHistory } from "./jugglework-screenshot-history.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function imagePart(size: number, index: number, options?: { tool?: string; fill?: string }) {
  return {
    id: `image-${index}`,
    type: "tool",
    tool: options?.tool ?? "computer-use_cua_screenshot",
    state: {
      status: "completed",
      output: JSON.stringify({ width: 1440, height: 900 }),
      attachments: [{
        type: "file",
        mime: "image/png",
        filename: `screen-${index}.png`,
        url: `data:image/png;base64,${(options?.fill ?? String(index % 10)).repeat(size)}`,
      }],
      time: { start: index, end: index + 1 },
    },
  };
}

function compacted(part: ReturnType<typeof imagePart>): boolean {
  return typeof (part.state.time as { compacted?: number }).compacted === "number";
}

async function transform(messages: unknown[]) {
  const plugin = await JuggleWorkScreenshotHistory();
  const output = { messages };
  await plugin["experimental.chat.messages.transform"]({}, output);
  return output.messages;
}

describe("JuggleWorkScreenshotHistory", () => {
  test("leaves unique inline image history below the byte threshold unchanged", async () => {
    const parts = [imagePart(256 * 1024, 0), imagePart(256 * 1024, 1)];
    await transform([{ role: "assistant", parts }]);
    expect(parts.some(compacted)).toBe(false);
  });

  test("compacts oldest inline images by attachment bytes and preserves the newest two", async () => {
    const parts = Array.from({ length: 4 }, (_, index) => imagePart(4 * 1024 * 1024, index));
    await transform([{ role: "assistant", parts }]);

    expect(compacted(parts[0]!)).toBe(true);
    expect(compacted(parts[1]!)).toBe(true);
    expect(compacted(parts[2]!)).toBe(false);
    expect(compacted(parts[3]!)).toBe(false);
    expect(parts[0]!.state.attachments[0]!.url).toStartWith("data:image/png;base64,");
  });

  test("deduplicates repeated read images even below the byte budget and keeps the newest copy", async () => {
    const parts = [
      imagePart(256 * 1024, 0, { tool: "read", fill: "a" }),
      imagePart(256 * 1024, 1, { tool: "read", fill: "a" }),
      imagePart(256 * 1024, 2, { tool: "read", fill: "a" }),
    ];
    await transform([{ role: "assistant", parts }]);

    expect(compacted(parts[0]!)).toBe(true);
    expect(compacted(parts[1]!)).toBe(true);
    expect(compacted(parts[2]!)).toBe(false);
  });

  test("does not compact non-inline or non-image tool attachments", async () => {
    const externalImage = imagePart(128, 0);
    externalImage.state.attachments[0]!.url = "https://example.test/screen.png";
    const inlineText = imagePart(128, 1);
    inlineText.state.attachments[0]!.mime = "text/plain";
    await transform([{ role: "assistant", parts: [externalImage, inlineText] }]);
    expect(compacted(externalImage)).toBe(false);
    expect(compacted(inlineText)).toBe(false);
  });

  test("blocks a second read of an unchanged image but allows it after the file changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jugglework-image-history-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "figure.png");
    await writeFile(path, "first");
    const plugin = await JuggleWorkScreenshotHistory({ directory });
    const beforeInput = { tool: "read", sessionID: "ses_1", callID: "call_1" };
    const beforeOutput = { args: { filePath: "figure.png" } };

    await expect(plugin["tool.execute.before"](beforeInput, beforeOutput)).resolves.toBeUndefined();
    await plugin["tool.execute.after"]({ ...beforeInput, args: beforeOutput.args });
    await expect(plugin["tool.execute.before"](beforeInput, beforeOutput))
      .rejects.toThrow("jugglework_duplicate_image_read");

    await writeFile(path, "second-version");
    await expect(plugin["tool.execute.before"](beforeInput, beforeOutput)).resolves.toBeUndefined();
  });

  test("does not block text reads or the same image in another session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jugglework-image-history-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "figure.png"), "image");
    await writeFile(join(directory, "notes.txt"), "text");
    const plugin = await JuggleWorkScreenshotHistory({ directory });

    await plugin["tool.execute.after"]({ tool: "read", sessionID: "ses_1", args: { filePath: "figure.png" } });
    await expect(plugin["tool.execute.before"](
      { tool: "read", sessionID: "ses_2" },
      { args: { filePath: "figure.png" } },
    )).resolves.toBeUndefined();
    await expect(plugin["tool.execute.before"](
      { tool: "read", sessionID: "ses_1" },
      { args: { filePath: "notes.txt" } },
    )).resolves.toBeUndefined();
  });
});

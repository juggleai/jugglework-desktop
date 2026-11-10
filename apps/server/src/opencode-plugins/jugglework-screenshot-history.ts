/**
 * Keeps historical computer-use screenshots from making a model request
 * disproportionately large.
 *
 * OpenCode's token compaction is intentionally separate: base64 screenshots
 * can exhaust an HTTP byte limit well before token usage reaches a compaction
 * threshold. This hook estimates the UTF-8 JSON size of the model-bound
 * history and marks the oldest screenshot tool results as compacted only for
 * the request projection. OpenCode then replaces those results with its
 * standard cleared-result placeholder while the original session data stays
 * available to the UI.
 */

const TARGET_REQUEST_HISTORY_BYTES = 12 * 1024 * 1024;
const PRESERVE_RECENT_SCREENSHOTS = 2;
const encoder = new TextEncoder();

type JsonRecord = Record<string, unknown>;

type ScreenshotPart = {
  state: JsonRecord;
  removableBytes: number;
  compacted: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : utf8Bytes(serialized);
  } catch {
    // OpenCode message parts are JSON values. If a third-party plugin leaves a
    // non-serializable value behind, fail open instead of breaking the turn.
    return 0;
  }
}

function screenshotPart(value: unknown): ScreenshotPart | null {
  if (!isRecord(value) || value.type !== "tool" || typeof value.tool !== "string") return null;
  if (!value.tool.toLowerCase().includes("screenshot")) return null;
  if (!isRecord(value.state) || value.state.status !== "completed") return null;

  const attachments = Array.isArray(value.state.attachments) ? value.state.attachments : [];
  const hasInlineImage = attachments.some((attachment) => (
    isRecord(attachment)
    && typeof attachment.mime === "string"
    && attachment.mime.toLowerCase().startsWith("image/")
    && typeof attachment.url === "string"
    && attachment.url.startsWith("data:")
  ));
  if (!hasInlineImage) return null;

  const time = isRecord(value.state.time) ? value.state.time : {};
  return {
    state: value.state,
    compacted: typeof time.compacted === "number",
    // These fields are removed by OpenCode's model-message projection when a
    // completed tool result is compacted. Counting their serialized UTF-8
    // bytes makes the policy independent of base64/token heuristics.
    removableBytes: jsonBytes(value.state.output) + jsonBytes(attachments),
  };
}

function screenshotParts(messages: unknown[]): ScreenshotPart[] {
  const result: ScreenshotPart[] = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const screenshot = screenshotPart(part);
      if (screenshot) result.push(screenshot);
    }
  }
  return result;
}

function markCompacted(part: ScreenshotPart): void {
  const time = isRecord(part.state.time) ? part.state.time : {};
  part.state.time = { ...time, compacted: Date.now() };
}

// Single export: the OpenCode plugin loader treats every export as a factory.
export const JuggleWorkScreenshotHistory = async () => ({
  "experimental.chat.messages.transform": async (_input: unknown, output: { messages: unknown[] }) => {
    let estimatedBytes = jsonBytes(output.messages);
    if (estimatedBytes <= TARGET_REQUEST_HISTORY_BYTES) return;

    const screenshots = screenshotParts(output.messages);
    for (const screenshot of screenshots) {
      if (screenshot.compacted) estimatedBytes = Math.max(0, estimatedBytes - screenshot.removableBytes);
    }
    if (estimatedBytes <= TARGET_REQUEST_HISTORY_BYTES) return;

    const active = screenshots.filter((screenshot) => !screenshot.compacted);
    const prunable = active.slice(0, Math.max(0, active.length - PRESERVE_RECENT_SCREENSHOTS));
    for (const screenshot of prunable) {
      markCompacted(screenshot);
      estimatedBytes = Math.max(0, estimatedBytes - screenshot.removableBytes);
      if (estimatedBytes <= TARGET_REQUEST_HISTORY_BYTES) break;
    }
  },
});

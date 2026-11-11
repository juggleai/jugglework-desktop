import type { DynamicToolUIPart, TextUIPart } from "ai";
import type { FilePart, ToolPart } from "@opencode-ai/sdk/v2/client";

import { safeStringify } from "@/app/utils";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const MAX_INLINE_READ_OUTPUT_CHARS = 128 * 1024;
const READ_OUTPUT_TAIL_CHARS = 16 * 1024;
const MAX_INLINE_READ_ATTACHMENT_CHARS = 256 * 1024;

export function visibleToolAttachments(part: ToolPart): FilePart[] {
  if (part.state.status !== "completed" || !part.state.attachments) return [];
  if (part.tool !== "read") return part.state.attachments;
  return part.state.attachments.filter((attachment) => !(
    attachment.mime.toLowerCase().startsWith("image/")
    && attachment.url.toLowerCase().startsWith("data:image/")
    && attachment.url.length > MAX_INLINE_READ_ATTACHMENT_CHARS
  ));
}

function boundedToolOutput(tool: string, output: unknown) {
  if (tool !== "read" || typeof output !== "string" || output.length <= MAX_INLINE_READ_OUTPUT_CHARS) {
    return { output, truncated: false, originalCharacters: null };
  }
  const marker = `\n\n[JuggleWork omitted ${output.length - MAX_INLINE_READ_OUTPUT_CHARS} characters from this historical read result to keep the session responsive.]\n\n`;
  const headChars = MAX_INLINE_READ_OUTPUT_CHARS - READ_OUTPUT_TAIL_CHARS;
  return {
    output: `${output.slice(0, headChars)}${marker}${output.slice(-READ_OUTPUT_TAIL_CHARS)}`,
    truncated: true,
    originalCharacters: output.length,
  };
}

// Keep only the JSON fields needed for historical file changes. Diagnostics and
// other arbitrary tool metadata should not be copied into the transcript.
function fileChangeMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Record<string, string | number> = {};
  for (const key of ["file", "filePath", "relativePath", "movePath", "patch", "type", "status"]) {
    if (typeof record[key] === "string") result[key] = record[key];
  }
  for (const key of ["additions", "deletions"]) {
    const count = record[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return result;
}

function shouldDeferInProgressTool(part: ToolPart) {
  if (part.state.status === "completed" || part.state.status === "error") {
    return false;
  }

  return Object.keys(part.state.input).length === 0;
}

export function parseStructuredOutputUIPart(part: ToolPart): TextUIPart | null {
  if (part.state.status === "error") {
    return null;
  }

  const text = safeStringify(part.state.input);

  if (text === "{}" && part.state.status !== "completed") {
    return null;
  }

  return {
    type: "text",
    text,
    state: part.state.status === "completed" ? "done" : "streaming",
    providerMetadata: { opencode: { partId: `structured-output-${part.callID}`, toolPartId: part.id } },
  };
}

export function parseDynamicToolUIPart(part: ToolPart): DynamicToolUIPart | null {
  if (part.tool === STRUCTURED_OUTPUT_TOOL) {
    return null;
  }

  const stateTime = "time" in part.state ? part.state.time : undefined;
  const rawMetadata = "metadata" in part.state ? part.state.metadata : undefined;
  const taskMetadata = rawMetadata && typeof rawMetadata === "object"
    ? {
        parentSessionId: typeof rawMetadata.parentSessionId === "string" ? rawMetadata.parentSessionId : undefined,
        sessionId: typeof rawMetadata.sessionId === "string" ? rawMetadata.sessionId : undefined,
        background: typeof rawMetadata.background === "boolean" ? rawMetadata.background : undefined,
        jobId: typeof rawMetadata.jobId === "string" ? rawMetadata.jobId : undefined,
        ...(part.state.status === "completed" && ["edit", "write", "apply_patch"].includes(part.tool) ? {
          filediff: fileChangeMetadata(rawMetadata.filediff),
          files: Array.isArray(rawMetadata.files) ? rawMetadata.files.flatMap((file) => {
            const metadata = fileChangeMetadata(file);
            return metadata ? [metadata] : [];
          }) : undefined,
          diff: typeof rawMetadata.diff === "string" ? rawMetadata.diff : undefined,
        } : {}),
      }
    : undefined;
  const boundedOutput = part.state.status === "completed"
    ? boundedToolOutput(part.tool, part.state.output)
    : { output: undefined, truncated: false, originalCharacters: null };
  const providerMetadata = {
    opencode: {
      partId: part.id,
      ...(taskMetadata ? { toolMetadata: taskMetadata } : {}),
      ...(boundedOutput.truncated ? {
        toolOutputTruncated: true,
        toolOutputOriginalCharacters: boundedOutput.originalCharacters,
      } : {}),
      ...(typeof stateTime?.start === "number" ? { toolStartedAt: stateTime.start } : {}),
      ...(stateTime && "end" in stateTime && typeof stateTime.end === "number" ? { toolEndedAt: stateTime.end } : {}),
    },
  };

  if (part.state.status === "error") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-error",
      input: part.state.input,
      errorText: part.state.error,
      callProviderMetadata: providerMetadata,
    };
  }

  if (part.state.status === "completed") {
    return {
      type: "dynamic-tool",
      toolName: part.tool,
      toolCallId: part.callID,
      state: "output-available",
      input: part.state.input,
      output: boundedOutput.output,
      callProviderMetadata: providerMetadata,
    };
  }

  // OpenCode emits pending/running tool parts with `{}` input before args
  // (e.g. filePath) are filled in. Skip UI until the next part.updated.
  if (shouldDeferInProgressTool(part)) {
    return null;
  }

  return {
    type: "dynamic-tool",
    toolName: part.tool,
    toolCallId: part.callID,
    state: part.state.status === "pending" ? "input-streaming" : "input-available",
    input: part.state.input,
    callProviderMetadata: providerMetadata,
  };
}

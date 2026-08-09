import type { DynamicToolUIPart, TextUIPart } from "ai";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";

import { safeStringify } from "@/app/utils";

export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

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
      }
    : undefined;
  const providerMetadata = {
    opencode: {
      partId: part.id,
      ...(taskMetadata ? { toolMetadata: taskMetadata } : {}),
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
      output: part.state.output,
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
    state: "input-streaming",
    input: part.state.input,
    callProviderMetadata: providerMetadata,
  };
}

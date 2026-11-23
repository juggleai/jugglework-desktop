import type { UIMessage } from "ai";
import type { ModelRef } from "@/app/types";
import { formatModelRef, modelEquals, modelFromUserMessage, resolveModelDisplayName } from "@/app/utils";

export type ModelSwitch = { from: string; to: string };

function modelName(id: string) {
  // Keep the full version and variant for models such as gpt-6.2-astra.
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i.exec(id);
  if (!gpt) return resolveModelDisplayName(id);
  const variant = gpt[2]?.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return variant ? `GPT-${gpt[1]} ${variant}` : `GPT-${gpt[1]}`;
}

// Each accepted prompt carries its selected model in both the live feed and history.
export function submittedTaskModelNotices(messages: UIMessage[]) {
  const notices = new Map<string, ModelSwitch>();
  let previous: ModelRef | null = null;
  for (const message of messages) {
    if (message.role !== "user" || !message.parts.some(part =>
      part.type === "file" || (part.type === "text" && part.text.trim().length > 0))) continue;
    const metadata = message.metadata as { opencode?: { model?: unknown } } | undefined;
    const current = modelFromUserMessage({ role: message.role, model: metadata?.opencode?.model });
    if (previous && current && !modelEquals(previous, current)) {
      const from = modelName(previous.modelID);
      const to = modelName(current.modelID);
      notices.set(message.id, from === to
        ? { from: formatModelRef(previous), to: formatModelRef(current) }
        : { from, to });
    }
    previous = current;
  }
  return notices;
}

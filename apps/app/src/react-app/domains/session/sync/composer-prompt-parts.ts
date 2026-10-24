import type {
  AgentPartInput,
  FilePartInput,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import type { ComposerDraft } from "../../../../app/types";
import { appMentionInstruction } from "../surface/composer/app-mentions";
import { composerAttachmentToFilePart } from "./attachment-file-part";
import { composerFilePartToPromptPart } from "./prompt-file-parts";

export type ComposerPromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

/**
 * Build engine prompt parts only from explicit composer state.
 *
 * Plain text that happens to resemble a local path must remain text. Files are
 * attached only when the composer has recorded an explicit file mention,
 * picker selection, paste/drop attachment, or another visible file chip.
 */
export async function composerDraftToPromptParts(
  draft: ComposerDraft,
  workspaceRoot: string,
): Promise<ComposerPromptPartInput[]> {
  const parts: ComposerPromptPartInput[] = [];
  const text = draft.resolvedText ?? draft.text;
  parts.push({ type: "text", text });

  for (const part of draft.parts) {
    if (part.type === "agent") {
      parts.push({ type: "agent", name: part.name });
      continue;
    }
    if (part.type === "app") {
      parts.push({ type: "text", text: appMentionInstruction(part.name) });
      continue;
    }
    if (part.type === "file") {
      const filePart = composerFilePartToPromptPart(part, workspaceRoot);
      if (filePart) parts.push(filePart);
    }
  }

  parts.push(...(await Promise.all(draft.attachments.map(composerAttachmentToFilePart))));
  return parts;
}

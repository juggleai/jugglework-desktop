import type { TextPartInput, FilePartInput, AgentPartInput } from "@opencode-ai/sdk/v2/client";
import type { ComposerDraft, ComposerPart } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { composerFilePartToPromptPart } from "./prompt-file-parts";
import { composerAttachmentsToWorkspaceFileParts } from "./attachment-file-part";
import { officeGroupText, officeGroupDisplay } from "../surface/composer/office-selection-draft";
import { appMentionInstruction } from "../surface/composer/app-mentions";
import { decodeComposerMentionValue } from "../surface/composer/mention-encoding";
import { COMPOSER_TOKEN_SPLIT_RE, buildCapabilityInstruction, fallbackCapabilityPrompt, parseComposerCapabilityToken } from "../surface/composer/capability-tags";

/** 将会话草稿按原有顺序转换为文件、Office选区及能力指令，始终使用显式目标项目。 */
export async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ResolvedWorkspaceEndpoint | null,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const attachmentFileById = new Map<string, FilePartInput>();
  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    const uploaded = await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
    });
    for (const part of uploaded) {
      if (part.type === "text") {
        parts.push(part);
        continue;
      }
    }
    const fileParts = uploaded.filter((part): part is FilePartInput => part.type === "file");
    for (const [index, attachment] of draft.attachments.entries()) {
      const filePart = fileParts[index];
      if (filePart) attachmentFileById.set(attachment.id, filePart);
    }
  }

  // Prefer draft.text token order so attachment chips stay inline with surrounding text
  // (same positions as the composer), instead of dumping every file part at the end.
  const hasAttachmentTokens = /\[attachment [^\]]+\]/.test(draft.text);
  if (hasAttachmentTokens || attachmentFileById.size > 0) {
    const pasteByLabel = new Map(
      draft.parts
        .filter((part): part is Extract<ComposerPart, { type: "paste" }> => part.type === "paste")
        .map((part) => [part.label, part.text] as const),
    );
    for (const segment of draft.text.split(COMPOSER_TOKEN_SPLIT_RE)) {
      if (!segment) continue;
      const officeMatch = /^\[office-instruction ([\w-]+)\]$/.exec(segment);
      const officeGroup = officeMatch ? draft.parts.find((part) => part.type === "office-selection" && part.instruction.instructionId === officeMatch[1]) : null;
      if (officeGroup?.type === "office-selection") {
        parts.push({ type: "text", text: officeGroupText(officeGroup), metadata: { officeSelectionGroup: officeGroupDisplay(officeGroup) } });
        continue;
      }
      const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
      if (attachmentMatch?.[1]) {
        const filePart = attachmentFileById.get(attachmentMatch[1]);
        if (filePart) {
          parts.push(filePart);
          attachmentFileById.delete(attachmentMatch[1]);
        }
        continue;
      }
      const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
      if (pasteMatch?.[1]) {
        const pasted = pasteByLabel.get(pasteMatch[1]);
        if (pasted) parts.push({ type: "text", text: pasted });
        continue;
      }
      const capability = parseComposerCapabilityToken(segment);
      if (capability) {
        if (capability.kind === "skill") {
          parts.push({ type: "text", text: buildCapabilityInstruction("skill", capability.name) });
        } else {
          // 云端技能/扩展/MCP：发送插入时登记的完整指令，而不是裸 token。
          const registered = draft.parts.find(
            (part): part is Extract<ComposerPart, { type: "capability" }> =>
              part.type === "capability" && part.kind === capability.kind && part.name === capability.name,
          );
          parts.push({ type: "text", text: registered?.prompt ?? fallbackCapabilityPrompt(capability.kind, capability.name) });
        }
        continue;
      }
      if (segment.startsWith("@")) {
        const value = decodeComposerMentionValue(segment.slice(1));
        const mentionPart = draft.parts.find((part) =>
          (part.type === "agent" && part.name === value)
          || (part.type === "app" && part.name === value)
          || (part.type === "file" && part.path === value),
        );
        if (mentionPart?.type === "agent") {
          parts.push({ type: "agent", name: mentionPart.name });
          continue;
        }
        if (mentionPart?.type === "app") {
          parts.push({ type: "text", text: appMentionInstruction(mentionPart.name) });
          continue;
        }
        if (mentionPart?.type === "file") {
          const filePart = composerFilePartToPromptPart(mentionPart, root);
          if (filePart) parts.push(filePart);
          continue;
        }
      }
      parts.push({ type: "text", text: segment });
    }
    for (const filePart of attachmentFileById.values()) {
      parts.push(filePart);
    }
  } else {
    for (const part of draft.parts) {
      if (part.type === "office-selection") {
        parts.push({ type: "text", text: officeGroupText(part), metadata: { officeSelectionGroup: officeGroupDisplay(part) } });
        continue;
      }
      if (part.type === "text") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "paste") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "agent") {
        parts.push({ type: "agent", name: part.name });
        continue;
      }
      if (part.type === "skill") {
        parts.push({ type: "text", text: buildCapabilityInstruction("skill", part.name) });
        continue;
      }
      if (part.type === "capability") {
        parts.push({ type: "text", text: part.prompt });
        continue;
      }
      if (part.type === "app") {
        parts.push({ type: "text", text: appMentionInstruction(part.name) });
        continue;
      }
      if (part.type === "file") {
        const filePart = composerFilePartToPromptPart(part, root);
        if (filePart) parts.push(filePart);
      }
    }
  }

  return parts;
}

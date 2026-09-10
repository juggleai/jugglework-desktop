/** @jsxImportSource react */
import { FileText, ListPlus, Pencil, X } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge";
import { t } from "@/i18n";
import type { ComposerAttachment, ComposerDraft, ComposerPart } from "@/app/types";
import type { QueuedComposerDraft } from "@/react-app/domains/session/surface/composer-state-store";

export type QueuedMessagesPanelProps = {
  drafts: QueuedComposerDraft[];
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  sending?: boolean;
};

const TOKEN_RE = /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[skill [^\]]+\])/;

function isImageAttachment(attachment: ComposerAttachment) {
  return attachment.kind === "image" || attachment.mimeType.startsWith("image/");
}

function pastedLines(parts: ComposerPart[], label: string) {
  for (const part of parts) {
    if (part.type === "paste" && part.label === label) return part.lines;
  }
  return 1;
}

function QueuedDraftContent(props: { draft: ComposerDraft }) {
  const attachmentsById = new Map(props.draft.attachments.map((attachment) => [attachment.id, attachment]));
  const text = props.draft.text;
  if (!text.trim() && props.draft.attachments.length > 0) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {props.draft.attachments.map((attachment) => (
          <QueuedAttachmentChip key={attachment.id} attachment={attachment} />
        ))}
      </span>
    );
  }

  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const segment of text.split(TOKEN_RE)) {
    if (!segment) continue;
    const key = `${offset}:${segment}`;
    offset += segment.length;

    const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
    if (attachmentMatch?.[1]) {
      const attachment = attachmentsById.get(attachmentMatch[1]);
      if (attachment) {
        nodes.push(<QueuedAttachmentChip key={key} attachment={attachment} />);
        continue;
      }
    }

    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch?.[1]) {
      const lines = pastedLines(props.draft.parts, pasteMatch[1]);
      nodes.push(
        <span
          key={key}
          className="mx-0.5 inline-flex items-center rounded-full border border-amber-6/35 bg-amber-3/15 px-2.5 py-1 text-xs font-medium text-amber-11 align-middle"
          title={`Pasted text · ${pasteMatch[1]}`}
        >
          {`Pasted · ${lines} line${lines === 1 ? "" : "s"}`}
        </span>,
      );
      continue;
    }

    const skillMatch = segment.match(/^\[skill (.+)\]$/);
    if (skillMatch?.[1]) {
      nodes.push(
        <span
          key={key}
          className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle"
          title={`Skill: ${skillMatch[1]}`}
        >
          {skillMatch[1]}
        </span>,
      );
      continue;
    }

    nodes.push(
      <Fragment key={key}>{segment}</Fragment>,
    );
  }

  if (nodes.length === 0) {
    return (
      <span className="text-gray-10">
        {t("composer.queued_attachments_only", { count: props.draft.attachments.length })}
      </span>
    );
  }

  return <span className="inline">{nodes}</span>;
}

function QueuedAttachmentChip(props: { attachment: ComposerAttachment }) {
  if (isImageAttachment(props.attachment) && props.attachment.previewUrl) {
    return (
      <ImageAttachmentBadge
        src={props.attachment.previewUrl}
        alt={props.attachment.name}
        className="mx-0.5 align-middle"
        thumbnailClassName="size-7 rounded-lg"
      />
    );
  }

  return (
    <span
      className="mx-0.5 inline-flex h-7 max-w-[140px] items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 align-middle"
      title={props.attachment.name}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-[11px] font-medium text-foreground">{props.attachment.name}</span>
    </span>
  );
}

function queuedDraftTitle(draft: ComposerDraft) {
  const text = draft.text.trim();
  if (text) return text;
  return draft.attachments.map((attachment) => attachment.name).join(", ");
}

/**
 * Shows the follow-up messages the user has queued while the agent is busy.
 * Rendered as compact single-line rows above the composer. Each entry can be
 * moved back into the composer for editing or cancelled.
 */
export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  if (props.drafts.length === 0) return null;

  return (
    <div
      className="max-h-36 space-y-1 overflow-y-auto border-b border-dls-border bg-transparent px-4 py-2"
      role="list"
      aria-label={t("composer.queued_count", { count: props.drafts.length })}
    >
      {props.drafts.map((item) => (
        <div
          key={item.id}
          role="listitem"
          className="group flex min-h-10 items-center gap-2.5 rounded-lg px-2 transition-colors hover:bg-gray-2/70"
        >
          <ListPlus className="size-4 shrink-0 text-gray-10" aria-hidden="true" />
          <div
            className="min-w-0 flex-1 truncate whitespace-nowrap text-sm font-medium leading-5 text-gray-12"
            title={queuedDraftTitle(item.draft)}
          >
            <QueuedDraftContent draft={item.draft} />
          </div>
          <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              type="button"
              onClick={() => props.onEdit(item.id)}
              disabled={props.sending}
              className="flex size-7 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
              title={t("common.edit")}
              aria-label={t("common.edit")}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={() => props.onRemove(item.id)}
              disabled={props.sending}
              className="flex size-7 items-center justify-center rounded-lg text-gray-10 transition-colors hover:bg-red-3 hover:text-red-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-8 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
              title={t("common.remove")}
              aria-label={t("common.remove")}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

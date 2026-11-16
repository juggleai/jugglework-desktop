import type { UIMessage } from "ai";
import type { JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { snapshotToUIMessages } from "../sync/usechat-adapter";

type RawMessage = JuggleWorkSessionSnapshot["messages"][number];
type Flags = { synthetic?: boolean; ignored?: boolean; compaction_continue?: boolean };
function flags(value: unknown): Flags {
  return value && typeof value === "object" ? value as Flags : {};
}
function control(value: unknown) {
  const item = flags(value);
  return item.synthetic === true || item.ignored === true || item.compaction_continue === true;
}

/** Real user evidence only; callers supply the full, unreverted raw tail. */
export function promptSuggestionUserHistory(raw: RawMessage[], live: UIMessage[] = []) {
  // Reuse the chat transform's synthetic text / compaction boundary rules.
  // Do not apply the revert cursor: its hidden real tail remains a frontier.
  const transformed = snapshotToUIMessages({ messages: raw, status: { type: "idle" } } as JuggleWorkSessionSnapshot);
  const rejected = new Set(raw.filter((message) => control(message) || control((message as { metadata?: unknown }).metadata) ||
    control(message.info) || control((message.info as { metadata?: unknown }).metadata) ||
    message.parts.some((part) => part.type === "compaction" || flags((part as { metadata?: unknown }).metadata).compaction_continue === true) ||
    !message.parts.some((part) => !control(part) && (part.type === "file" || part.type === "agent" || (part.type === "text" && Boolean(part.text.trim())))))
    .map((message) => message.info.id));
  const users = [...transformed, ...live].filter((message) => {
    const metadata = message.metadata as { opencode?: unknown } | undefined;
    const opencode = metadata?.opencode as { compaction?: unknown } | undefined;
    return message.role === "user" && !rejected.has(message.id) && !control(message) && !control(metadata) && !control(metadata?.opencode) &&
      !opencode?.compaction && !message.parts.some((part) => {
        const detail = part as { type: string; metadata?: unknown; providerMetadata?: { opencode?: unknown } };
        return detail.type === "compaction" || flags(detail.metadata).compaction_continue === true ||
          flags(detail.providerMetadata?.opencode).compaction_continue === true;
      }) &&
      message.parts.some((part) => {
        const detail = part as typeof part & { synthetic?: boolean; ignored?: boolean; metadata?: unknown; providerMetadata?: { opencode?: unknown } };
        return !control(detail) && !control(detail.metadata) && !control(detail.providerMetadata?.opencode) &&
          ((part.type === "text" && Boolean(part.text.trim())) || part.type === "file");
      });
  });
  const timestamps = users.flatMap((message) => {
    const created = (message.metadata as { opencode?: { created?: number } } | undefined)?.opencode?.created;
    return typeof created === "number" && Number.isFinite(created) ? [created] : [];
  });
  return { userCreatedAtBaseline: timestamps.length ? Math.max(...timestamps) : undefined, turnKeys: new Set(users.map((message) => message.id)) };
}

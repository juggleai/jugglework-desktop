import { useCloudDocChanges } from "./cloud-doc-changes-provider";
import { Cloud } from "lucide-react";
import { Card } from "@/components/ui/card";
import * as React from "react";
import { openCloudDocTab } from "@/app/lib/cloud-doc-tabs";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";

type Changes = Awaited<ReturnType<JuggleWorkServerClient["cloudDocsChanges"]>>;

/** 按用户 messageId 展示该轮 AI 回复后的云文档变更；撤销只针对所属轮次。 */
export function CloudDocsTurnCard({ client, workspaceId, sessionId, messageId, busy }: {
  client: JuggleWorkServerClient | null; workspaceId: string; sessionId: string; messageId: string; busy: boolean;
}) {
  const [undoing, setUndoing] = React.useState(false);
  const [changes, setChanges] = React.useState<Changes | null>(null);
  const { data, refresh } = useCloudDocChanges();
  const summary = data.turns.find(turn => turn.messageId === messageId);
  const undone = summary?.undone;
  const [expanded, setExpanded] = React.useState(false);
  const view = async (doc: Changes["documents"][number]) => {
    if (!client) return;
    const detail = await client.cloudDocsChanges(workspaceId, sessionId, messageId);
    setChanges(detail);
    const ids = detail.changes.filter(c => c.workspaceId === doc.workspaceId && c.docId === doc.docId).flatMap(c => c.blocks.map(b => b.blockId)) ?? [];
    openCloudDocTab(sessionId, { tenantId: doc.tenantId, workspaceId: doc.workspaceId, docId: doc.docId, title: doc.title }, ids);
    setExpanded(true);
  };
  const undo = async () => {
    if (!client || busy || undoing) return;
    setUndoing(true);
    try {
      const result = await client.cloudDocsUndo(workspaceId, sessionId, messageId);
      if (result.conflicts) toast.warning(t("cloud_docs.undo_partial", { count: String(result.conflicts) }));
      else toast.success(t("cloud_docs.undo_done"));
      setChanges(null);
      await refresh();
    } catch (error) { toast.error(String(error)); }
    finally { setUndoing(false); }
  };
  if (!summary?.documents.length) return null;
  return (
    <div className="flex flex-col gap-1.5 py-2 text-xs" data-cloud-doc-turn={messageId}>
      {summary.documents.map(doc => (
        <Card key={`${doc.workspaceId}/${doc.docId}`} variant="outline" size="sm" className="gap-2 rounded-xl px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5"><Cloud className="size-4 shrink-0" /><span className="truncate">{doc.title} · {t("cloud_docs.change_counts", { replaced: String(doc.replaced), inserted: String(doc.inserted), deleted: String(doc.deleted) })}{undone ? ` · ${t("cloud_docs.undone")}` : ""}</span></span>
          <span className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" className="h-6" onClick={() => void view(doc).catch(error => toast.error(String(error)))}>{t("cloud_docs.view_changes")}</Button>
            {!undone && <Button size="sm" variant="ghost" className="h-6" disabled={busy || undoing} onClick={() => void undo()}>{t(undoing ? "cloud_docs.undoing" : "cloud_docs.undo_turn")}</Button>}
          </span>
        </div>
        {expanded && changes?.changes.filter(change => change.workspaceId === doc.workspaceId && change.docId === doc.docId).map((change, index) => <div key={index} className="mt-2 grid grid-cols-2 gap-2 border-t border-dls-border pt-2">
          <div><span className="text-dls-secondary">{t("cloud_docs.change_before")}</span><pre className="whitespace-pre-wrap break-words font-sans">{change.before ?? "—"}</pre></div>
          <div><span className="text-dls-secondary">{t("cloud_docs.change_after")}</span><pre className="whitespace-pre-wrap break-words font-sans">{change.after ?? "—"}</pre></div>
        </div>)}
        </Card>
      ))}
    </div>
  );
}

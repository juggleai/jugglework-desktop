/** @jsxImportSource react */
import * as React from "react";
import { ArtifactCard, ChangeCounts } from "@/components/chat/artifact";
import { Button } from "@/components/ui/button";
import type { ArtifactItem } from "@/lib/artifacts";
import { t } from "@/i18n";
import { parseUnifiedDiff, type DiffLine } from "./parse-unified-diff";

/** Pair adjacent deletion/addition blocks without moving context across hunks. */
export function splitDiffLines(lines: DiffLine[]) {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let removed: DiffLine[] = [], added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push({ left: removed[i], right: added[i] });
    removed = []; added = [];
  };
  for (const line of lines) {
    if (line.kind === "del") removed.push(line);
    else if (line.kind === "add") added.push(line);
    else { flush(); rows.push({ left: line, right: line }); }
  }
  flush();
  return rows;
}

function SplitDiff({ patch }: { patch: string }) {
  const hunks = React.useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [showLarge, setShowLarge] = React.useState(false);
  if (!hunks.length) return null;
  const count = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (count > 2000 && !showLarge) return <button className="p-4 text-sm" onClick={() => setShowLarge(true)}>{t("session_files.diff_show_anyway")}</button>;
  return <div className="overflow-x-auto" data-testid="turn-split-diff">
    <table className="w-full table-fixed border-collapse font-mono text-xs leading-5"><tbody>
      {hunks.map((hunk, index) => <React.Fragment key={index}>
        <tr className="bg-muted/50 text-muted-foreground"><td colSpan={2} className="px-3 py-1">{hunk.header}</td></tr>
        {splitDiffLines(hunk.lines).map((row, i) => <tr key={i}>
          {(["left", "right"] as const).map((side) => {
            const line = row[side];
            return <td key={side} className={`w-1/2 border-r border-border/40 align-top ${line?.kind === "del" ? "bg-red-3/60" : line?.kind === "add" ? "bg-green-3/60" : !line ? "bg-muted/40" : ""}`}>
              <div className="flex"><span className="w-12 shrink-0 select-none px-2 text-right text-muted-foreground">{side === "left" ? line?.oldLine : line?.newLine}</span><span className="whitespace-pre-wrap break-all px-2">{line?.content ?? " "}</span></div>
            </td>;
          })}
        </tr>)}
      </React.Fragment>)}
    </tbody></table>
  </div>;
}

/** Immutable turn records, separate from the current working-tree changes. */
export function TurnChangesView({ artifacts, selectedPath, onSelect, onOpenFile, onWorkspaceChanges }: {
  artifacts: ArtifactItem[]; selectedPath: string | null; onSelect: (path: string | null) => void;
  onOpenFile?: (artifact: ArtifactItem) => void;
  onWorkspaceChanges?: () => void;
}) {
  const selectedRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: "nearest" }); }, [selectedPath]);
  const changes = artifacts.flatMap((artifact) => artifact.change ? [artifact.change] : []);
  return <div className="flex min-h-0 flex-1 flex-col" data-testid="turn-changes-view">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <span>{t("artifact.turn_files")}</span>
      {changes.length ? <ChangeCounts change={{ additions: changes.reduce((sum, diff) => sum + diff.additions, 0), deletions: changes.reduce((sum, diff) => sum + diff.deletions, 0), source: changes.some((diff) => diff.source === "edits") ? "edits" : "snapshot" }} /> : null}
      {onWorkspaceChanges ? <Button variant="ghost" size="sm" className="ml-auto" onClick={onWorkspaceChanges}>{t("artifact.workspace_changes")}</Button> : null}
    </div>
    <div className="subtle-scrollbar min-h-0 flex-1 overflow-y-auto">
      {artifacts.map((artifact) => {
        const hasTextDiff = parseUnifiedDiff(artifact.change?.patch ?? "").length > 0;
        return <div key={artifact.id} ref={selectedPath === artifact.path ? selectedRef : undefined} className="border-b border-border">
          <ArtifactCard
            artifact={artifact}
            compact
            onOpenInTab={onOpenFile ? () => onOpenFile(artifact) : undefined}
            onViewChange={hasTextDiff
              ? () => onSelect(selectedPath === artifact.path ? null : artifact.path)
              : onOpenFile ? () => onOpenFile(artifact) : undefined}
          />
          {hasTextDiff && selectedPath === artifact.path ? <SplitDiff key={artifact.id} patch={artifact.change!.patch} /> : null}
        </div>;
      })}
    </div>
  </div>;
}

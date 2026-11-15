/** @jsxImportSource react */
import * as React from "react";
import { ChangeCounts } from "@/components/chat/artifact";
import { Button } from "@/components/ui/button";
import type { ArtifactItem } from "@/lib/artifacts";
import { t } from "@/i18n";
import { DiffCode, useDiffHighlight } from "./diff-code";
import { FileChangeSection, useExpandedChanges } from "./file-change-section";
import { parseUnifiedDiff, type DiffLine } from "./parse-unified-diff";

/** 配对相邻删除与新增内容，不跨越上下文和差异块。 */
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

function SplitDiff({ path, patch }: { path: string; patch: string }) {
  const hunks = React.useMemo(() => parseUnifiedDiff(patch), [patch]);
  const tokens = useDiffHighlight(path, hunks);
  const [showLarge, setShowLarge] = React.useState(false);
  if (!hunks.length) return null;
  const count = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  if (count > 2000 && !showLarge) return <button className="p-4 text-sm" onClick={() => setShowLarge(true)}>{t("session_files.diff_show_anyway")}</button>;
  return <div className="overflow-x-auto" data-testid="turn-split-diff">
    <table className="w-full table-fixed border-collapse font-mono text-xs leading-5"><tbody>
      {hunks.map((hunk, index) => <React.Fragment key={index}>
        {splitDiffLines(hunk.lines).map((row, i) => <tr key={i}>
          {(["left", "right"] as const).map((side) => {
            const line = row[side];
            return <td key={side} className="workspace-diff-row w-1/2 border-r border-border/40 align-top" data-kind={line?.kind}>
              <div className="flex"><span className="diff-line-number w-12 shrink-0 select-none px-2 text-right">{side === "left" ? line?.oldLine : line?.newLine}</span><span className="whitespace-pre-wrap break-all px-2">{line ? <DiffCode line={line} tokens={tokens} /> : " "}</span></div>
            </td>;
          })}
        </tr>)}
      </React.Fragment>)}
    </tbody></table>
  </div>;
}

/** 本轮产物快照；文件独立展开，原文保持回合记录不变。 */
export function TurnChangesView({ artifacts, selectedPath, onSelect, onOpenFile, onWorkspaceChanges }: {
  artifacts: ArtifactItem[]; selectedPath: string | null; onSelect: (path: string | null) => void;
  onOpenFile?: (artifact: ArtifactItem) => void;
  onWorkspaceChanges?: () => void;
}) {
  const { expanded, toggle } = useExpandedChanges(selectedPath, onSelect);
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
        return <div key={artifact.id} ref={selectedPath === artifact.path ? selectedRef : undefined}>
          <FileChangeSection
            change={{ path: artifact.path, status: artifact.legacy_target.exists === false ? "deleted" : "modified", additions: artifact.change?.additions ?? 0, deletions: artifact.change?.deletions ?? 0, patch: artifact.change?.patch ?? "" }}
            expanded={hasTextDiff && expanded.has(artifact.path)}
            onToggle={hasTextDiff ? () => toggle(artifact.path) : undefined}
            onOpenFile={onOpenFile ? () => onOpenFile(artifact) : undefined}
          >
            <SplitDiff path={artifact.path} patch={artifact.change?.patch ?? ""} />
          </FileChangeSection>
        </div>;
      })}
    </div>
  </div>;
}

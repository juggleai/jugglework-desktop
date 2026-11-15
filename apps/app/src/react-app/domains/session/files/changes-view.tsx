/** @jsxImportSource react */
import * as React from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import {
  countDiffLines,
  countFoldedContextLines,
  parseUnifiedDiff,
} from "./parse-unified-diff";
import { DiffCode, useDiffHighlight } from "./diff-code";
import { FileChangeSection, useExpandedChanges } from "./file-change-section";
import type { WorkspaceChange } from "./use-workspace-changes";

type ChangesViewProps = {
  changes: WorkspaceChange[];
  loading: boolean;
  refreshing: boolean;
  vcsAvailable: boolean;
  error: string | null;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpenFile: (change: WorkspaceChange) => void;
  onRefresh: () => void;
};

/**
 * 工作区变更列表：每份文件独立展开，正文在文件行下显示。
 * @param props Git 差异、当前定位、文件打开及刷新回调
 */
export function ChangesView({
  changes,
  loading,
  refreshing,
  vcsAvailable,
  error,
  selectedPath,
  onSelect,
  onOpenFile,
  onRefresh,
}: ChangesViewProps) {
  const { expanded, toggle } = useExpandedChanges(selectedPath, onSelect);
  if (loading)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  if (error)
    return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  if (!vcsAvailable)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("session_files.no_vcs")}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {t("session_files.changed_files", { count: changes.length })}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("session_files.refresh_changes")}
          title={t("session_files.refresh_changes")}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-3", refreshing && "animate-spin")} />
        </Button>
      </div>
      <div className="subtle-scrollbar min-h-0 flex-1 overflow-auto">
        {changes.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            {t("session_files.no_changes")}
          </div>
        ) : (
          changes.map((change) => (
            <FileChangeSection
              key={change.path}
              change={change}
              expanded={expanded.has(change.path)}
              onToggle={() => toggle(change.path)}
              onOpenFile={() => onOpenFile(change)}
            >
              <DiffBody change={change} />
            </FileChangeSection>
          ))
        )}
      </div>
    </div>
  );
}

function DiffBody({ change }: { change: WorkspaceChange }) {
  const hunks = React.useMemo(
    () => parseUnifiedDiff(change.patch),
    [change.patch],
  );
  const total = React.useMemo(() => countDiffLines(hunks), [hunks]);
  const [showLarge, setShowLarge] = React.useState(false);
  const tokens = useDiffHighlight(change.path, hunks);
  if (!hunks.length)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {t("session_files.no_text_diff")}
      </div>
    );
  if (total > 2000 && !showLarge)
    return (
      <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
        <span>{t("session_files.diff_collapsed", { lines: total })}</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setShowLarge(true)}
        >
          {t("session_files.diff_show_anyway")}
        </Button>
      </div>
    );
  return (
    <div className="subtle-scrollbar overflow-x-auto">
      <table
        className="w-full border-collapse font-mono text-xs leading-5"
        data-testid="workspace-unified-diff"
      >
        <tbody>
          {hunks.map((hunk, index) => (
            <React.Fragment key={`${hunk.header}-${index}`}>
              {index > 0 &&
              countFoldedContextLines(hunks[index - 1]!, hunk) > 0 ? (
                <tr
                  className="border-y border-border/50 bg-muted/35 text-muted-foreground"
                  data-diff-folded-context
                >
                  <td />
                  <td className="px-3 py-1 italic">
                    {t("session_files.unchanged_lines_folded", {
                      count: countFoldedContextLines(hunks[index - 1]!, hunk),
                    })}
                  </td>
                </tr>
              ) : null}
              {hunk.lines.map((line, i) => (
                <tr
                  key={i}
                  className="workspace-diff-row"
                  data-kind={line.kind}
                >
                  <td className="diff-line-number w-10 min-w-10 select-none px-2 text-right align-top">
                    {line.kind === "del" ? line.oldLine : line.newLine}
                  </td>
                  <td className="whitespace-pre-wrap break-all px-3 align-top">
                    <DiffCode line={line} tokens={tokens} />
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

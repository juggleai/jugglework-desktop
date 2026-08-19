/** @jsxImportSource react */
import * as React from "react";
import { FilePlus2, FileMinus2, FilePen, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "../../../../i18n";
import { countDiffLines, parseUnifiedDiff } from "./parse-unified-diff";
import type { SessionChange } from "./use-session-changes";

/** 单文件 diff 超过该行数时先折叠，避免一次渲染上万个节点 */
const COLLAPSE_DIFF_LINES = 2000;

type ChangesViewProps = {
  changes: SessionChange[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onOpenFile: (change: SessionChange) => void;
};

/**
 * 会话变更视图：左侧变更文件列表，下方展示选中文件的逐行 diff
 *
 * @param changes 会话累计改动
 * @param loading 是否加载中
 * @param error 加载失败信息
 * @param selectedPath 当前选中的变更文件
 * @param onSelect 选中变更文件
 * @param onOpenFile 在文件标签中打开该文件
 */
export function ChangesView({ changes, loading, error, selectedPath, onSelect, onOpenFile }: ChangesViewProps) {
  const selected = changes.find((change) => change.path === selectedPath) ?? changes[0] ?? null;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-sm text-muted-foreground">{error}</div>;
  }

  if (changes.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">{t("session_files.no_changes")}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="max-h-48 shrink-0 overflow-auto border-b border-border/60 py-1">
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            onClick={() => onSelect(change.path)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-muted",
              change.path === selected?.path && "bg-muted/80",
            )}
          >
            <ChangeStatusIcon status={change.status} />
            <span className="min-w-0 flex-1 truncate" title={change.path}>{change.path}</span>
            <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">+{change.additions}</span>
            <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400">-{change.deletions}</span>
          </button>
        ))}
      </div>
      {selected ? <DiffBody change={selected} onOpenFile={onOpenFile} /> : null}
    </div>
  );
}

function ChangeStatusIcon({ status }: { status: SessionChange["status"] }) {
  if (status === "added") return <FilePlus2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (status === "deleted") return <FileMinus2 className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />;

  return <FilePen className="size-3.5 shrink-0 text-muted-foreground" />;
}

function DiffBody({ change, onOpenFile }: { change: SessionChange; onOpenFile: (change: SessionChange) => void }) {
  const hunks = React.useMemo(() => parseUnifiedDiff(change.patch), [change.patch]);
  const total = React.useMemo(() => countDiffLines(hunks), [hunks]);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    setExpanded(false);
  }, [change.path]);

  const collapsed = total > COLLAPSE_DIFF_LINES && !expanded;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={change.path}>{change.path}</span>
        {change.status !== "deleted" ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenFile(change)}>
            {t("session_files.open_file")}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {hunks.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t("session_files.no_text_diff")}</div>
        ) : collapsed ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <span className="text-sm text-muted-foreground">{t("session_files.diff_collapsed", { lines: total })}</span>
            <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
              {t("session_files.diff_show_anyway")}
            </Button>
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[11px] leading-5">
            <tbody>
              {hunks.map((hunk, hunkIndex) => (
                <React.Fragment key={`${hunk.header}-${hunkIndex}`}>
                  <tr className="bg-muted/60 text-muted-foreground">
                    <td className="w-10 select-none px-2 text-right" />
                    <td className="w-10 select-none px-2 text-right" />
                    <td className="px-2 whitespace-pre-wrap">{hunk.header}</td>
                  </tr>
                  {hunk.lines.map((line, lineIndex) => (
                    <tr
                      key={`${hunkIndex}-${lineIndex}`}
                      className={cn(
                        // 新增/删除行的底色按设计稿固定取值，浅色深色一致
                        line.kind === "add" && "bg-[#e6f4e7]",
                        line.kind === "del" && "bg-[#fce6e2]",
                        line.kind === "meta" && "text-muted-foreground",
                      )}
                    >
                      <td className="w-10 select-none px-2 text-right align-top text-muted-foreground">{line.oldLine ?? ""}</td>
                      <td className="w-10 select-none px-2 text-right align-top text-muted-foreground">{line.newLine ?? ""}</td>
                      <td className="px-2 align-top whitespace-pre-wrap break-all">
                        <span className="select-none text-muted-foreground">
                          {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                        </span>
                        {line.content}
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

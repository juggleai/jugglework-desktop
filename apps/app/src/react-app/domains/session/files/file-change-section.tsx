/** @jsxImportSource react */
import * as React from "react";
import {
  ChevronDown,
  FileMinus2,
  FilePen,
  FilePlus2,
  SquareArrowOutUpRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ArtifactFileMenu } from "../artifacts/artifact-file-menu";
import {
  useArtifactActions,
  type ArtifactAction,
} from "../artifacts/artifact-actions-provider";
import type { WorkspaceChange } from "./use-workspace-changes";

/** 文件变更行：完整路径提示、尾部优先省略、独立展开和已有文件操作。 */
export function FileChangeSection({
  change,
  expanded,
  onToggle,
  onOpenFile,
  children,
}: {
  change: WorkspaceChange;
  expanded: boolean;
  onToggle?: () => void;
  onOpenFile?: () => void;
  children?: React.ReactNode;
}) {
  const actions = useArtifactActions();
  const contentId = React.useId();
  const path = change.path.replace(/\\/g, "/");
  const separator = path.lastIndexOf("/");
  const openFile = change.status !== "deleted" ? onOpenFile : undefined;
  const [busy, setBusy] = React.useState(false);
  const run = async (action: ArtifactAction) => {
    if (!actions || busy || change.status === "deleted") return;
    setBusy(true);
    try {
      // TIPS: 复用已有保存、文件校验和工作区操作管线，不绕过草稿与执行中限制。
      await actions.runPath(action, change.path);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="min-w-0 border-b border-border/60"
      data-testid="file-change-section"
      data-path={change.path}
    >
      <div className="group/change flex min-w-0 items-center gap-1 px-2 py-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left text-[13px] enabled:hover:bg-muted/40"
          title={change.path}
          aria-expanded={onToggle ? expanded : undefined}
          aria-controls={onToggle ? contentId : undefined}
          disabled={!onToggle && !openFile}
          onClick={onToggle ?? openFile}
        >
          {change.status === "added" ? (
            <FilePlus2
              aria-hidden="true"
              className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
          ) : change.status === "deleted" ? (
            <FileMinus2
              aria-hidden="true"
              className="size-3.5 shrink-0 text-red-600 dark:text-red-400"
            />
          ) : (
            <FilePen
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          )}
          {/* TIPS: RTL 只负责把省略号放到左边，路径文字仍按 LTR 排列，保留文件名和扩展名。 */}
          <span
            className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl]"
            data-testid="change-file-path"
          >
            <bdi dir="ltr">
              <span className="text-muted-foreground">
                {separator >= 0 ? path.slice(0, separator + 1) : ""}
              </span>
              <span>{path.slice(separator + 1)}</span>
            </bdi>
          </span>
          {onToggle ? (
            <ChevronDown
              className={`size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] group-hover/change:opacity-100 group-has-[:focus-visible]/change:opacity-100 ${expanded ? "" : "-rotate-90"}`}
            />
          ) : null}
        </button>
        <span
          className="ml-auto flex shrink-0 items-center gap-1 px-1 text-xs tabular-nums"
          data-testid="change-file-counts"
        >
          {change.additions > 0 ? (
            <span className="text-[#009b35] dark:text-[#3fb950]">
              +{change.additions}
            </span>
          ) : null}
          {change.deletions > 0 ? (
            <span className="text-[#d1242f] dark:text-[#f85149]">
              -{change.deletions}
            </span>
          ) : null}
        </span>
        {openFile ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("artifact.open_tab")}
            title={t("artifact.open_tab")}
            onClick={openFile}
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </Button>
        ) : null}
        <ArtifactFileMenu
          path={change.path}
          available={change.status !== "deleted"}
          busy={busy}
          onAction={run}
          size="icon-xs"
        />
      </div>
      {expanded && <div id={contentId}>{children}</div>}
    </section>
  );
}

/** 每个文件独立展开；外部定位的新文件只增加展开项，不收起其他文件。 */
export function useExpandedChanges(
  selectedPath: string | null,
  onSelect: (path: string | null) => void,
) {
  const [expanded, setExpanded] = React.useState(
    () => new Set(selectedPath ? [selectedPath] : []),
  );
  React.useEffect(() => {
    if (selectedPath)
      setExpanded((previous) =>
        previous.has(selectedPath)
          ? previous
          : new Set([...previous, selectedPath]),
      );
  }, [selectedPath]);
  const toggle = (path: string) => {
    const closing = expanded.has(path);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (closing) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!closing) onSelect(path);
    else if (path === selectedPath) onSelect(null);
  };
  return { expanded, toggle };
}

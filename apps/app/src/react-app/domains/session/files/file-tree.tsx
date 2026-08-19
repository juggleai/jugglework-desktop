/** @jsxImportSource react */
import * as React from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, Loader2, RotateCw } from "lucide-react";

import type { createClient } from "@/app/lib/opencode";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "../../../../i18n";
import { useFilesPanelStore } from "./files-panel-store";
import { useWorkspaceDir, WORKSPACE_TREE_ROOT, type WorkspaceTreeEntry } from "./use-workspace-tree";

type OpencodeClient = ReturnType<typeof createClient>;

type FileTreeProps = {
  client: OpencodeClient | null;
  sessionId: string;
  workspaceRoot: string;
  activePath: string | null;
  expandedDirs: Set<string>;
  onOpenFile: (entry: { path: string; name: string }) => void;
};

/**
 * 工作区目录树
 *
 * @param client 引擎客户端
 * @param sessionId 会话 id
 * @param workspaceRoot 工作区根目录绝对路径
 * @param activePath 当前激活的文件路径
 * @param expandedDirs 已展开的目录集合
 * @param onOpenFile 点击文件的回调
 */
export function FileTree({ client, sessionId, workspaceRoot, activePath, expandedDirs, onOpenFile }: FileTreeProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1">
      <DirChildren
        client={client}
        sessionId={sessionId}
        workspaceRoot={workspaceRoot}
        path={WORKSPACE_TREE_ROOT}
        depth={0}
        expanded
        activePath={activePath}
        expandedDirs={expandedDirs}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

type DirChildrenProps = FileTreeProps & {
  path: string;
  depth: number;
  expanded: boolean;
};

function DirChildren({
  client,
  sessionId,
  workspaceRoot,
  path,
  depth,
  expanded,
  activePath,
  expandedDirs,
  onOpenFile,
}: DirChildrenProps) {
  const { data, isLoading, isError, error, refetch } = useWorkspaceDir(client, workspaceRoot, path, expanded);

  if (!expanded) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" style={indentStyle(depth)}>
        <Loader2 className="size-3 animate-spin" />
        {t("session_files.loading")}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" style={indentStyle(depth)}>
        <span className="truncate">{error instanceof Error ? error.message : t("session_files.load_failed")}</span>
        <Button variant="ghost" size="icon-xs" onClick={() => void refetch()} aria-label={t("session_files.retry")}>
          <RotateCw className="size-3" />
        </Button>
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <div className="py-1 text-xs text-muted-foreground" style={indentStyle(depth)}>
        {t("session_files.empty_dir")}
      </div>
    );
  }

  return (
    <>
      {data.entries.map((entry) => (
        <TreeNode
          key={entry.path}
          client={client}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          entry={entry}
          depth={depth}
          activePath={activePath}
          expandedDirs={expandedDirs}
          onOpenFile={onOpenFile}
        />
      ))}
      {data.truncated ? (
        <div className="py-1 text-xs text-muted-foreground" style={indentStyle(depth)}>
          {t("session_files.truncated", { shown: data.entries.length, total: data.total })}
        </div>
      ) : null}
    </>
  );
}

type TreeNodeProps = Omit<FileTreeProps, "onOpenFile"> & {
  entry: WorkspaceTreeEntry;
  depth: number;
  onOpenFile: (entry: { path: string; name: string }) => void;
};

function TreeNode({
  client,
  sessionId,
  workspaceRoot,
  entry,
  depth,
  activePath,
  expandedDirs,
  onOpenFile,
}: TreeNodeProps) {
  const toggleDir = useFilesPanelStore((state) => state.toggleDir);
  const expanded = expandedDirs.has(entry.path);
  const active = entry.type === "file" && entry.path === activePath;

  return (
    <>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pe-2 text-left text-[13px] text-foreground/90 hover:bg-muted",
          active && "bg-muted/80 text-foreground",
          entry.ignored && "text-muted-foreground/70",
        )}
        style={indentStyle(depth)}
        onClick={() => {
          if (entry.type === "directory") {
            toggleDir(sessionId, entry.path);

            return;
          }

          onOpenFile({ path: entry.path, name: entry.name });
        }}
      >
        {entry.type === "directory" ? (
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {entry.type === "directory" ? (
          expanded ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" /> : <Folder className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>
      {entry.type === "directory" ? (
        <DirChildren
          client={client}
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          path={entry.path}
          depth={depth + 1}
          expanded={expanded}
          activePath={activePath}
          expandedDirs={expandedDirs}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </>
  );
}

function indentStyle(depth: number): React.CSSProperties {
  return { paddingInlineStart: `${8 + depth * 14}px` };
}

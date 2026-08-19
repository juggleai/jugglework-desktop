/** @jsxImportSource react */
import * as React from "react";
import { Folders, Maximize2, Menu, Minimize2, Plus } from "lucide-react";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { createClient } from "@/app/lib/opencode";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { t } from "../../../../i18n";
import { ChangesView } from "./changes-view";
import { FileTabs } from "./file-tabs";
import { FileTree } from "./file-tree";
import { FileViewer } from "./file-viewer";
import { useFilesPanelSession, useFilesPanelStore } from "./files-panel-store";
import { useSessionChanges, type SessionChange } from "./use-session-changes";

type FilesPanelProps = {
  sessionId: string;
  client: JuggleWorkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  opencodeBaseUrl: string;
  opencodeToken: string;
  /** 会话是否正在执行，用于在回合结束后刷新变更列表 */
  busy: boolean;
};

/**
 * 会话右侧【文件】面板：工作区目录树 + 已打开文件 + 会话变更 diff
 *
 * 标签栏、目录树开关与全屏开关共用顶部一行；会话产生改动时，「变更」会作为
 * 标签栏里的第一个标签出现，和打开的文件标签并列。
 *
 * @param sessionId 会话 id
 * @param client JuggleWork 服务端客户端，用于文件读写
 * @param workspaceId 运行时工作区 id
 * @param workspaceRoot 工作区根目录绝对路径
 * @param opencodeBaseUrl 引擎地址，用于目录树与会话变更
 * @param opencodeToken 引擎访问令牌
 * @param busy 会话是否正在执行
 */
export function FilesPanel({
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  opencodeBaseUrl,
  opencodeToken,
  busy,
}: FilesPanelProps) {
  const session = useFilesPanelSession(sessionId);
  // TIPS: 逐个取 action 而不是整包订阅 store —— 整包订阅会让任意会话的状态变化都触发本面板重渲染
  const setActiveKey = useFilesPanelStore((state) => state.setActiveKey);
  const openFile = useFilesPanelStore((state) => state.openFile);
  const closeFileTab = useFilesPanelStore((state) => state.closeFile);
  const selectFile = useFilesPanelStore((state) => state.selectFile);
  const toggleFullscreen = useFilesPanelStore((state) => state.toggleFullscreen);
  const toggleTreeCollapsed = useFilesPanelStore((state) => state.toggleTreeCollapsed);
  const selectChange = useFilesPanelStore((state) => state.selectChange);

  const opencodeClient = React.useMemo(
    () => (opencodeBaseUrl ? createClient(opencodeBaseUrl, workspaceRoot || undefined, { token: opencodeToken, mode: "jugglework" }) : null),
    [opencodeBaseUrl, opencodeToken, workspaceRoot],
  );

  const changesQuery = useSessionChanges(opencodeClient, sessionId, workspaceRoot, busy);
  const changes = changesQuery.data ?? [];
  const hasChanges = changes.length > 0;

  const expandedDirs = React.useMemo(() => new Set(session.expandedDirs), [session.expandedDirs]);
  const dirtyPaths = React.useMemo(() => new Set(Object.keys(session.drafts)), [session.drafts]);
  const activeTab = session.tabs.find((tab) => tab.path === session.activePath) ?? null;
  const showingChanges = session.activeKey === "changes" && hasChanges;
  // 全屏时目录树是可折叠的左栏；分栏模式宽度不够，还没打开任何内容时才让目录树占满面板
  const treeColumnVisible = session.fullscreen
    ? !session.treeCollapsed
    : session.tabs.length === 0 && !showingChanges;

  // TIPS: 改动被清空（例如会话回滚）时「变更」标签会消失，内容区必须退回文件，
  // 否则会停在一个已经不存在的标签上。
  React.useEffect(() => {
    if (session.activeKey === "changes" && !hasChanges && !changesQuery.isLoading) {
      setActiveKey(sessionId, "files");
    }
  }, [changesQuery.isLoading, hasChanges, session.activeKey, sessionId, setActiveKey]);

  const closeFile = (path: string) => {
    if (dirtyPaths.has(path) && !window.confirm(t("session_files.close_dirty_confirm"))) {
      return;
    }

    closeFileTab(sessionId, path);
  };

  const openChangeFile = (change: SessionChange) => {
    openFile(sessionId, { path: change.path, name: change.path.split("/").pop() ?? change.path });
  };

  const treeNode = (onOpened?: () => void) => (
    <FileTree
      client={opencodeClient}
      sessionId={sessionId}
      workspaceRoot={workspaceRoot}
      activePath={showingChanges ? null : session.activePath}
      expandedDirs={expandedDirs}
      onOpenFile={(entry) => {
        openFile(sessionId, entry);
        onOpened?.();
      }}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* TIPS: 标签、目录树开关、全屏开关共用这一行；全屏时它紧贴 macOS 的 hiddenInset
          标题栏，整行设为窗口拖拽区，里面的按钮各自标 titlebar-no-drag，既能拖窗口也点得动。 */}
      <div
        className={cn(
          // 与会话页头等高（.session-panel-header，见 styles/custom.css）
          "session-panel-header flex shrink-0 items-center gap-1 border-b border-border px-1.5 mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150",
          session.fullscreen && "mac:titlebar-drag",
        )}
      >
        {session.fullscreen ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 mac:titlebar-no-drag"
            aria-label={session.treeCollapsed ? t("session_files.expand_tree") : t("session_files.collapse_tree")}
            title={session.treeCollapsed ? t("session_files.expand_tree") : t("session_files.collapse_tree")}
            onClick={() => toggleTreeCollapsed(sessionId)}
          >
            <Folders className={cn("size-4", !session.treeCollapsed && "text-primary")} />
          </Button>
        ) : (
          <TreePopover
            label={t("session_files.browse_tree")}
            trigger={<Menu className="size-4" />}
            workspaceRoot={workspaceRoot}
          >
            {(close) => treeNode(close)}
          </TreePopover>
        )}
        <div className="min-w-0 flex-1 overflow-hidden">
          <FileTabs
            tabs={session.tabs}
            activePath={showingChanges ? null : session.activePath}
            dirtyPaths={dirtyPaths}
            changesTab={hasChanges ? {
              label: t("session_files.tab_changes"),
              count: changes.length,
              active: showingChanges,
              onSelect: () => setActiveKey(sessionId, "changes"),
            } : null}
            onSelect={(path) => selectFile(sessionId, path)}
            onClose={closeFile}
          />
        </div>
        {session.fullscreen ? null : (
          <TreePopover
            label={t("session_files.open_more")}
            trigger={<Plus className="size-3.5" />}
            workspaceRoot={workspaceRoot}
            align="end"
          >
            {(close) => treeNode(close)}
          </TreePopover>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 mac:titlebar-no-drag"
          aria-label={session.fullscreen ? t("session_files.exit_fullscreen") : t("session_files.fullscreen")}
          title={session.fullscreen ? t("session_files.exit_fullscreen") : t("session_files.fullscreen")}
          onClick={() => toggleFullscreen(sessionId)}
        >
          {session.fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {treeColumnVisible ? (
          <div
            className={cn(
              "flex min-h-0 flex-col",
              session.fullscreen ? "w-64 shrink-0 border-e border-border" : "flex-1",
            )}
          >
            <div className="shrink-0 truncate px-3 py-1.5 text-[11px] text-muted-foreground" title={workspaceRoot}>
              {workspaceRoot}
            </div>
            {treeNode()}
          </div>
        ) : null}
        {session.fullscreen || !treeColumnVisible ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {showingChanges ? (
              <ChangesView
                changes={changes}
                loading={changesQuery.isLoading}
                error={changesQuery.isError ? (changesQuery.error instanceof Error ? changesQuery.error.message : t("session_files.load_failed")) : null}
                selectedPath={session.selectedChangePath}
                onSelect={(path) => selectChange(sessionId, path)}
                onOpenFile={openChangeFile}
              />
            ) : activeTab && client && workspaceId ? (
              <FileViewer
                client={client}
                workspaceId={workspaceId}
                sessionId={sessionId}
                path={activeTab.path}
                name={activeTab.name}
                draft={session.drafts[activeTab.path]}
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
                {t("session_files.no_open_file")}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type TreePopoverProps = {
  /** 无障碍标签，同时作为按钮 title */
  label: string;
  /** 触发按钮里的图标 */
  trigger: React.ReactNode;
  /** 工作区根目录绝对路径，展示在弹层顶部 */
  workspaceRoot: string;
  /** 弹层相对触发按钮的对齐方式 */
  align?: "start" | "end";
  /** 弹层内容；参数是收起弹层的回调，仅在真正打开文件时调用 */
  children: (close: () => void) => React.ReactNode;
};

/**
 * 目录树悬浮弹层：鼠标移入即展开，点击可固定，选中文件后自动收起
 *
 * TIPS: base-ui 的 Popover 没有内置 openOnHover，这里自己接管 open 状态。
 * 关闭要留一段延迟，否则鼠标从按钮移到弹层的路上会先离开按钮把弹层收掉。
 *
 * @param label 无障碍标签
 * @param trigger 触发按钮里的图标
 * @param workspaceRoot 工作区根目录绝对路径
 * @param align 弹层对齐方式
 * @param children 弹层内容（目录树），接收收起弹层的回调
 */
function TreePopover({ label, trigger, workspaceRoot, align = "start", children }: TreePopoverProps) {
  const [open, setOpen] = React.useState(false);
  const closeTimerRef = React.useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 220);
  };

  React.useEffect(() => cancelClose, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 mac:titlebar-no-drag"
            aria-label={label}
            title={label}
            onMouseEnter={() => {
              cancelClose();
              setOpen(true);
            }}
            onMouseLeave={scheduleClose}
          >
            {trigger}
          </Button>
        )}
      />
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-80 gap-0 rounded-2xl p-0"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <div className="shrink-0 truncate border-b border-border/60 px-3 py-2 text-[11px] text-muted-foreground" title={workspaceRoot}>
          {workspaceRoot}
        </div>
        <div className="flex max-h-96 min-h-0 flex-col overflow-hidden">
          {children(() => {
            cancelClose();
            setOpen(false);
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

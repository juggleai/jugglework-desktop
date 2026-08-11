/** @jsxImportSource react */
import * as React from "react";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  RefreshCw,
  RotateCcw,
  Settings,
  Folder,
  FolderOpen,
  Tag,
} from "lucide-react";
import { LayoutGroup, LazyMotion, Reorder, domMax, m, useDragControls } from "motion/react";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import { JuggleWorkDenHelpLink } from "../../workspace/jugglework-den-help-link";
import type { OpenCreateWorkspace } from "../../workspace/types";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  isRemoteConnectionErrorMessage,
  getWorkspaceTaskLoadErrorDisplay,
  isRemoteConnectionWorkspace,
  isMacPlatform,
  isWindowsPlatform,
} from "../../../../app/utils";
import { t } from "../../../../i18n";
import { AppNavigationRail } from "../../../shell/app-navigation-rail";

import {
  Sidebar,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ListPanelHeader } from "@/react-app/shell/list-panel-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { SidebarContext, useSidebarContext } from "./app-sidebar-provider";
import type { SidebarContextValue } from "./app-sidebar-provider";
import {
  MAX_SESSIONS_PREVIEW,
  buildSessionTreeState,
  filterSessionsByTitle,
  flattenSessionRows,
  formatSessionRelativeTime,
  getRootSessions,
  isMainSession,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  isSessionArchived,
  partitionArchivedSessions,
  resolveWorkspaceSessionIndicator,
  workspaceLabel,
} from "./utils";
import type { FlattenedSessionRow, SessionListItem, SessionTreeState } from "./utils";
import {
  useSessionManagementStore,
  usePinnedSessionIds,
  useUnreadSessionIds,
  useSessionOrder,
  useWorkspaceGroups,
  type SessionGroupDefinition,
} from "./session-management-store";
import { useWorkspaceIndicatorStore } from "./workspace-indicator-store";
import { setTaskScope, useTaskScope, workspaceTaskScope } from "./task-scope-store";
import { cn } from "@/lib/utils";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "../status/session-activity-store";
import { SessionDotMatrixLoader } from "./session-dot-matrix-loader";
import { SessionCircularProgress } from "./session-circular-progress";

/** Fixed left lane from Paper — activity/chevron slot; never shifts the title. */
const LEFT_ACTIVITY_SLOT = "flex size-4 shrink-0 items-center justify-center";

/** Paper Desktop: unread #2FBE54, needs-action #E8933A (14px artboard → ~8px app). */
const OUTCOME_DOT_UNREAD = "#2FBE54";
const OUTCOME_DOT_NEEDS_ACTION = "#E8933A";

interface SessionLoadingIndicatorProps {
  status?: string;
  isActiveWork: boolean;
}

/** Left-lane activity only — never used for unread / completion. */
function SessionLoadingIndicator({ status, isActiveWork }: SessionLoadingIndicatorProps) {
  if (!isActiveWork) {
    return <span aria-hidden="true" className={LEFT_ACTIVITY_SLOT} />;
  }

  const title = isSessionActivityStatus(status) && status !== "idle"
    ? getSessionActivityStatusLabel(status)
    : t("workspace_list.session_streaming");

  return (
    <span className={LEFT_ACTIVITY_SLOT} role="status" title={title} aria-label={title}>
      <SessionCircularProgress />
    </span>
  );
}

interface SessionOutcomeIndicatorProps {
  className?: string;
  status?: string;
  isActiveWork: boolean;
  isUnread: boolean;
}

/** Right-edge outcome: orange = needs you, green = unread result, none = read/idle. */
function SessionOutcomeIndicator({ className, status, isActiveWork, isUnread }: SessionOutcomeIndicatorProps) {
  if (isActiveWork) return null;

  if (isNeedsAttentionSessionStatus(status)) {
    const title = isSessionActivityStatus(status)
      ? getSessionActivityStatusLabel(status)
      : t("workspace_list.session_needs_attention");
    return (
      <span
        data-session-attention-indicator
        className={cn("size-2 shrink-0 rounded-full", className)}
        style={{ backgroundColor: OUTCOME_DOT_NEEDS_ACTION }}
        title={title}
        aria-label={title}
      />
    );
  }

  if (!isUnread) return null;

  return (
    <span
      data-session-attention-indicator
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: OUTCOME_DOT_UNREAD }}
      title={t("workspace_list.session_unread")}
      aria-label={t("workspace_list.session_unread")}
    />
  );
}

function useCanManageSession() {
  // Pin and group actions come from the Zustand store (always available).
  // Rename/delete/archive depend on wired callbacks but the menu should
  // always render so pin/group remain accessible.
  return true;
}

type SessionActionsProps = {
  className: string;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

type SessionMenuContentProps = {
  variant: "dropdown" | "context";
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionMenuContent({ variant, sessionId, workspaceId, isPinned, isArchived }: SessionMenuContentProps) {
  const ctx = useSidebarContext();
  const { groups, assignments } = useWorkspaceGroups(workspaceId);
  const store = useSessionManagementStore;
  const assignedGroupId = assignments[sessionId] ?? null;

  if (variant === "dropdown") {
    return (
      <>
        <DropdownMenuItem onClick={() => store.getState().togglePin(sessionId)}>
          {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        </DropdownMenuItem>
        {ctx.onOpenRenameSession ? (
          <DropdownMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
            <Pencil className="size-4" />
            {t("workspace_list.rename_session")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Tag className="size-4" />
            {t("session_management.move_to_group")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {groups.length === 0 ? (
              <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t("session_management.no_groups_yet")}
                </span>
                <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                  <Plus className="size-3.5" />
                </span>
              </DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                  disabled={!assignedGroupId}
                >
                  {t("session_management.no_group")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {groups.map((group) => (
                  <DropdownMenuItem
                    key={group.id}
                    onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                    disabled={assignedGroupId === group.id}
                  >
                    {group.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                  <FolderPlus className="size-4" />
                  {t("session_management.new_group")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {ctx.onArchiveSession ? (
          <DropdownMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
            {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
          </DropdownMenuItem>
        ) : null}
        {ctx.onOpenDeleteSession ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
              <Trash2 className="size-4" />
              {t("workspace_list.delete_session")}
            </DropdownMenuItem>
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      <ContextMenuItem onClick={() => store.getState().togglePin(sessionId)}>
        {isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
        {isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
      </ContextMenuItem>
      {ctx.onOpenRenameSession ? (
        <ContextMenuItem onClick={() => ctx.onOpenRenameSession?.(sessionId)}>
          <Pencil className="size-4" />
          {t("workspace_list.rename_session")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <Tag className="mr-2 size-4" />
          {t("session_management.move_to_group")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {groups.length === 0 ? (
            <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t("session_management.no_groups_yet")}
              </span>
              <span className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                <Plus className="size-3.5" />
              </span>
            </ContextMenuItem>
          ) : (
            <>
              <ContextMenuItem
                onClick={() => store.getState().assignGroup(workspaceId, sessionId, null)}
                disabled={!assignedGroupId}
              >
                {t("session_management.no_group")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              {groups.map((group) => (
                <ContextMenuItem
                  key={group.id}
                  onClick={() => store.getState().assignGroup(workspaceId, sessionId, group.id)}
                  disabled={assignedGroupId === group.id}
                >
                  {group.label}
                </ContextMenuItem>
              ))}
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspaceId)}>
                <FolderPlus className="size-4" />
                {t("session_management.new_group")}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {ctx.onArchiveSession ? (
        <ContextMenuItem onClick={() => ctx.onArchiveSession?.(sessionId, !isArchived)}>
          {isArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          {isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
        </ContextMenuItem>
      ) : null}
      {ctx.onOpenDeleteSession ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => ctx.onOpenDeleteSession?.(sessionId)}>
            <Trash2 className="size-4" />
            {t("workspace_list.delete_session")}
          </ContextMenuItem>
        </>
      ) : null}
    </>
  );
}

function SessionActions({ className, sessionId, workspaceId, isPinned, isArchived }: SessionActionsProps) {
  if (!useCanManageSession()) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="size-6 text-muted-foreground"
        render={
          <Button variant="ghost" size="icon-sm" className={cn("size-6", className)}>
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} alignOffset={-4} className="w-56">
        <SessionMenuContent
          variant="dropdown"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type SessionHoverQuickActionsProps = {
  className?: string;
  sessionId: string;
  isPinned: boolean;
  isArchived: boolean;
  relativeTime: string | null;
};

/** Pin → Archive → relative time — same trailing slot as status dots (Paper hover). */
function SessionHoverQuickActions({
  className,
  sessionId,
  isPinned,
  isArchived,
  relativeTime,
}: SessionHoverQuickActionsProps) {
  const ctx = useSidebarContext();
  const store = useSessionManagementStore;

  return (
    <div
      data-session-hover-actions
      className={cn(
        "absolute right-2.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1.5 opacity-0 pointer-events-none transition-opacity group-hover/menu-sub-item:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-has-data-popup-open/menu-sub-item:opacity-100 group-has-data-popup-open/menu-sub-item:pointer-events-auto",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="size-5 text-muted-foreground hover:bg-transparent hover:text-foreground"
        aria-label={isPinned ? t("session_management.unpin_session") : t("session_management.pin_session")}
        onClick={(event) => {
          event.stopPropagation();
          store.getState().togglePin(sessionId);
        }}
      >
        {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </Button>
      {ctx.onArchiveSession ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 text-muted-foreground hover:bg-transparent hover:text-foreground"
          aria-label={isArchived ? t("session_management.unarchive_session") : t("session_management.archive_session")}
          onClick={(event) => {
            event.stopPropagation();
            ctx.onArchiveSession?.(sessionId, !isArchived);
          }}
        >
          {isArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        </Button>
      ) : null}
      {relativeTime ? (
        <span className="min-w-[1.25rem] text-right text-[11px] tabular-nums text-muted-foreground/80">
          {relativeTime}
        </span>
      ) : null}
    </div>
  );
}

type SessionContextMenuProps = {
  children: React.ReactElement;
  sessionId: string;
  workspaceId: string;
  isPinned: boolean;
  isArchived: boolean;
};

function SessionContextMenu({ children, sessionId, workspaceId, isPinned, isArchived }: SessionContextMenuProps) {
  if (!useCanManageSession()) return children;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} />
      <ContextMenuContent className="w-56">
        <SessionMenuContent
          variant="context"
          sessionId={sessionId}
          workspaceId={workspaceId}
          isPinned={isPinned}
          isArchived={isArchived}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type WorkspaceActionsMenuProps = {
  workspace: WorkspaceInfo;
  isConnectionActionBusy: boolean;
  canRecover: boolean;
  className: string;
};

function WorkspaceActionsMenu({ workspace, isConnectionActionBusy, canRecover, className }: WorkspaceActionsMenuProps) {
  const ctx = useSidebarContext();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-6", className)}
            onClick={(e) => {
              e.stopPropagation();
            }}
            aria-label={t("workspace_list.workspace_options")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="w-56">
        <DropdownMenuItem
          onClick={() => ctx.onCreateTaskInWorkspace(workspace.id)}
          disabled={ctx.newTaskDisabled}
        >
          <Plus className="size-4" />
          {t("session.cmd_new_session_title")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ctx.onOpenRenameWorkspace(workspace.id)}>
          <Pencil className="size-4" />
          {t("workspace_list.edit_name")}
        </DropdownMenuItem>
        {workspace.workspaceType === "local" ? (
          <DropdownMenuItem onClick={() => ctx.onRevealWorkspace(workspace.id)}>
            <FolderOpen className="size-4" />
            {isWindowsPlatform() ? t("workspace_list.reveal_explorer") : t("workspace_list.reveal_finder")}
          </DropdownMenuItem>
        ) : null}
        {workspace.workspaceType === "remote" ? (
          <>
            {canRecover ? (
              <DropdownMenuItem
                onClick={() => void Promise.resolve(ctx.onRecoverWorkspace(workspace.id))}
                disabled={isConnectionActionBusy}
              >
                <RefreshCw className="size-4" />
                {t("workspace_list.recover")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              onClick={() => void Promise.resolve(ctx.onTestWorkspaceConnection(workspace.id))}
              disabled={isConnectionActionBusy}
            >
              <RefreshCw className="size-4" />
              {t("workspace_list.test_connection")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => ctx.onEditWorkspaceConnection(workspace.id)}
              disabled={isConnectionActionBusy}
            >
              <Settings className="size-4" />
              {t("workspace_list.edit_connection")}
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => ctx.onOpenCreateGroupModal?.(workspace.id)}>
          <FolderPlus className="size-4" />
          {t("session_management.new_group")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => ctx.onForgetWorkspace(workspace.id)}
        >
          <Trash2 className="size-4" />
          {t("workspace_list.remove_workspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RemoteConnectionIssueCard(props: {
  message: string;
  tone: "error" | "offline";
  canRecover: boolean;
  busy: boolean;
  onRecover: () => void;
  onTest: () => void;
  onEdit: () => void;
}) {
  const isOffline = props.tone === "offline";

  return (
    <SidebarMenuSubItem>
      <div
        className={cn(
          "w-full rounded-[15px] border border-red-7/35 bg-red-1/40 px-3 py-3 text-left",
          isOffline && "border-amber-7/35 bg-amber-2/45",
        )}
      >
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-3/60 text-red-11",
              isOffline && "bg-amber-3/60 text-amber-11",
            )}
          >
            <AlertCircle size={14} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-dls-text">
              {t("workspace_list.remote_worker_unavailable")}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-gray-10">
              {t("workspace_list.remote_worker_unavailable_hint")}
            </div>
            <div
              className={cn(
                "mt-2 rounded-lg border border-red-7/25 bg-red-1/40 px-2 py-1.5 text-[11px] leading-4 text-red-11 whitespace-pre-wrap wrap-anywhere",
                isOffline && "border-amber-7/25 bg-amber-1/40 text-amber-11",
              )}
              title={props.message}
            >
              {props.message}
            </div>
            <JuggleWorkDenHelpLink />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {props.canRecover ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                  onClick={props.onRecover}
                  disabled={props.busy}
                >
                  <RotateCcw size={12} />
                  {t("workspace_list.recover")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                onClick={props.onTest}
                disabled={props.busy}
              >
                <RefreshCw size={12} />
                {t("workspace_list.test_connection")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-2 text-[11px]"
                onClick={props.onEdit}
                disabled={props.busy}
              >
                <Settings size={12} />
                {t("common.edit")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </SidebarMenuSubItem>
  );
}

export type AppSidebarProps = {
  workspaceSessionGroups: WorkspaceSessionGroup[];
  showInitialLoading?: boolean;
  selectedWorkspaceId: string;
  developerMode: boolean;
  selectedSessionId: string | null;
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  onPrefetchSession?: (workspaceId: string, sessionId: string) => void;
  onCreateTaskInWorkspace: (workspaceId: string, groupId?: string) => void;
  onOpenRenameSession?: (sessionId: string) => void;
  onOpenDeleteSession?: (sessionId: string) => void;
  onArchiveSession?: (sessionId: string, archived: boolean) => void;
  onOpenCreateGroupModal?: (workspaceId: string) => void;
  onOpenRenameWorkspace: (workspaceId: string) => void;
  onShareWorkspace: (workspaceId: string) => void;
  onRevealWorkspace: (workspaceId: string) => void;
  onRecoverWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onTestWorkspaceConnection: (workspaceId: string) => Promise<boolean> | boolean | void;
  onEditWorkspaceConnection: (workspaceId: string) => void;
  onForgetWorkspace: (workspaceId: string) => void;
  onOpenCreateWorkspace: OpenCreateWorkspace;
  onOpenCreateLocalWorkspace: () => void;
  onOpenConnectRemoteWorkspace: () => void;
  onOpenTaskSearch: () => void;
  onOpenAccount: () => void;
  onOpenHome: () => void;
  onOpenApps: () => void;
  onOpenChat: () => void;
  onOpenSettings: () => void;
  onReorderWorkspaces?: (workspaceIds: string[]) => void;
  onStartResize?: React.PointerEventHandler<HTMLButtonElement>;
};

function useSessionTree(
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
) {
  return React.useMemo(
    () => buildSessionTreeState(sessions, sessionStatusById),
    [sessions, sessionStatusById],
  );
}

function isSessionActivityStatus(status: string | undefined): status is SessionActivityStatus {
  return status === "idle" || status === "thinking" || status === "responding" || status === "stalled" || status === "error" || status === "compacting" || status === "waiting";
}

export function AppSidebar(props: AppSidebarProps) {
  const taskScope = useTaskScope();
  const [sessionQuery, setSessionQuery] = React.useState("");
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = React.useState<Record<string, number>>({});
  const [expandedSessionIds, setExpandedSessionIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const previousSessionStatusRef = React.useRef<Record<string, string>>({});

  // Green unread dots: agent finished while the user was on another session.
  React.useEffect(() => {
    const statuses = props.sessionStatusById ?? {};
    const previous = previousSessionStatusRef.current;
    const selectedId = props.selectedSessionId;
    const store = useSessionManagementStore.getState();

    for (const [sessionId, status] of Object.entries(statuses)) {
      if (sessionId === selectedId) {
        store.clearUnread(sessionId);
        continue;
      }
      const prior = previous[sessionId];
      if (isActiveWorkSessionStatus(prior) && status === "idle") {
        store.markUnread(sessionId);
      }
    }

    if (selectedId) store.clearUnread(selectedId);
    previousSessionStatusRef.current = statuses;
  }, [props.selectedSessionId, props.sessionStatusById]);

  const expandWorkspace = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
  }, []);

  const toggleWorkspaceExpanded = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSessionExpanded = React.useCallback((sessionId: string) => {
    const id = sessionId.trim();
    if (!id) return;
    setExpandedSessionIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    const id = props.selectedWorkspaceId.trim();
    if (!id) return;
    expandWorkspace(id);
  }, [props.selectedWorkspaceId, expandWorkspace]);

  const syncedWorkspaceIdRef = React.useRef<string | null>(null);
  const syncedTaskScopeRef = React.useRef(taskScope);

  // Keeps the rail's task scope and the opened workspace pointing at each
  // other: opening a session from outside the list (search, deep link) adopts
  // that workspace's scope, while switching scope on the rail focuses the
  // first workspace the new list contains.
  React.useEffect(() => {
    const workspaceId = props.selectedWorkspaceId.trim();
    const selected = props.workspaceSessionGroups.find(
      (group) => group.workspace.id === workspaceId,
    )?.workspace;

    if (selected && syncedWorkspaceIdRef.current !== workspaceId) {
      syncedWorkspaceIdRef.current = workspaceId;
      const scope = workspaceTaskScope(selected);
      syncedTaskScopeRef.current = scope;
      setTaskScope(scope);
      return;
    }

    if (syncedTaskScopeRef.current === taskScope) return;
    syncedTaskScopeRef.current = taskScope;
    if (selected && workspaceTaskScope(selected) === taskScope) return;

    const firstInScope = props.workspaceSessionGroups.find(
      (group) => workspaceTaskScope(group.workspace) === taskScope,
    )?.workspace;
    if (!firstInScope) return;
    syncedWorkspaceIdRef.current = firstInScope.id;
    void props.onSelectWorkspace(firstInScope.id);
  }, [props.onSelectWorkspace, props.selectedWorkspaceId, props.workspaceSessionGroups, taskScope]);

  const previewCount = (workspaceId: string) =>
    previewCountByWorkspaceId[workspaceId] ?? MAX_SESSIONS_PREVIEW;

  const showMoreSessions = (workspaceId: string, totalRoots: number) => {
    expandWorkspace(workspaceId);
    setPreviewCountByWorkspaceId((current) => ({
      ...current,
      [workspaceId]: Math.min((current[workspaceId] ?? MAX_SESSIONS_PREVIEW) + MAX_SESSIONS_PREVIEW, totalRoots),
    }));
  };

  React.useEffect(() => {
    const workspaceId = props.selectedWorkspaceId.trim();
    if (!workspaceId) return;

    const group = props.workspaceSessionGroups.find(
      (entry) => entry.workspace.id === workspaceId,
    );
    if (!group?.sessions.length) return;

    const selectedId = props.selectedSessionId?.trim() ?? "";
    const selectedIndex = selectedId
      ? group.sessions.findIndex((session) => session.id === selectedId)
      : -1;
    const start = selectedIndex >= 0 ? Math.max(0, selectedIndex - 2) : 0;
    const end = selectedIndex >= 0
      ? Math.min(group.sessions.length, selectedIndex + 3)
      : Math.min(group.sessions.length, 4);

    group.sessions.slice(start, end).forEach((session) => {
      props.onPrefetchSession?.(workspaceId, session.id);
    });
  }, [
    props.onPrefetchSession,
    props.selectedSessionId,
    props.selectedWorkspaceId,
    props.workspaceSessionGroups,
  ]);

  const trimmedSessionQuery = sessionQuery.trim();
  const isFiltering = trimmedSessionQuery.length > 0;

  // A query carries no meaning across scopes — the other list has its own sessions.
  React.useEffect(() => {
    setSessionQuery("");
  }, [taskScope]);

  const contextValue: SidebarContextValue = {
    selectedWorkspaceId: props.selectedWorkspaceId,
    selectedSessionId: props.selectedSessionId,
    developerMode: props.developerMode,
    showSessionActions: props.showSessionActions,
    sessionStatusById: props.sessionStatusById,
    newTaskDisabled: props.newTaskDisabled,
    connectingWorkspaceId: props.connectingWorkspaceId,
    workspaceConnectionStateById: props.workspaceConnectionStateById,
    onSelectWorkspace: props.onSelectWorkspace,
    onOpenSession: props.onOpenSession,
    onPrefetchSession: props.onPrefetchSession,
    onCreateTaskInWorkspace: props.onCreateTaskInWorkspace,
    onOpenRenameSession: props.onOpenRenameSession,
    onOpenDeleteSession: props.onOpenDeleteSession,
    onArchiveSession: props.onArchiveSession,
    onOpenCreateGroupModal: props.onOpenCreateGroupModal,
    onOpenRenameWorkspace: props.onOpenRenameWorkspace,
    onShareWorkspace: props.onShareWorkspace,
    onRevealWorkspace: props.onRevealWorkspace,
    onRecoverWorkspace: props.onRecoverWorkspace,
    onTestWorkspaceConnection: props.onTestWorkspaceConnection,
    onEditWorkspaceConnection: props.onEditWorkspaceConnection,
    onForgetWorkspace: props.onForgetWorkspace,
    expandWorkspace,
    toggleWorkspaceExpanded,
    toggleSessionExpanded,
    expandedWorkspaceIds,
    expandedSessionIds,
    filteringSessions: isFiltering,
  };

  // Sessions of the scope on screen, narrowed to the sidebar filter. Workspaces
  // left without a match drop out so the list only holds results.
  const visibleWorkspaceSessionGroups = React.useMemo(() => {
    const inScope = props.workspaceSessionGroups.filter(
      (group) => workspaceTaskScope(group.workspace) === taskScope,
    );
    if (!trimmedSessionQuery) return inScope;
    return inScope.flatMap((group) => {
      const sessions = filterSessionsByTitle(
        group.sessions.filter(isMainSession),
        trimmedSessionQuery,
      );
      return sessions.length ? [{ ...group, sessions }] : [];
    });
  }, [props.workspaceSessionGroups, taskScope, trimmedSessionQuery]);
  const unreadIds = useUnreadSessionIds();
  const localWorkspaceIndicator = React.useMemo(
    () => resolveWorkspaceSessionIndicator(
      props.workspaceSessionGroups
        .filter((group) => group.workspace.workspaceType === "local")
        .flatMap((group) => group.sessions),
      props.sessionStatusById,
      unreadIds,
    ),
    [props.sessionStatusById, props.workspaceSessionGroups, unreadIds],
  );
  React.useEffect(() => {
    useWorkspaceIndicatorStore.getState().setLocalWorkspaceIndicator(localWorkspaceIndicator);
  }, [localWorkspaceIndicator]);
  const pinnedIds = useSessionManagementStore((state) => state.pinnedIds);
  const pinnedSessions = React.useMemo(() => {
    const sessionsById = new Map<string, GlobalPinnedSessionEntry>();
    for (const group of visibleWorkspaceSessionGroups) {
      const roots = getRootSessions(partitionArchivedSessions(group.sessions).active);
      for (const session of roots) {
        sessionsById.set(session.id, { group, sessionId: session.id });
      }
    }
    return pinnedIds.flatMap((sessionId) => {
      const entry = sessionsById.get(sessionId);
      return entry ? [entry] : [];
    });
  }, [pinnedIds, visibleWorkspaceSessionGroups]);
  const archivedSessions = React.useMemo(() => {
    const entries: GlobalArchivedSessionEntry[] = [];
    for (const group of visibleWorkspaceSessionGroups) {
      for (const session of partitionArchivedSessions(group.sessions).archived.filter(isMainSession)) {
        entries.push({ group, session });
      }
    }
    return entries;
  }, [visibleWorkspaceSessionGroups]);
  const createTaskLabel = taskScope === "remote"
    ? t("navigation.create_cloud_task")
    : t("navigation.create_local_task");

  return (
    <SidebarContext.Provider value={contextValue}>
      <Sidebar
        collapsible="offcanvas"
        className="mac:**:data-[sidebar=sidebar]:bg-transparent"
      >
        <div className="flex h-full min-h-0 w-full">
          <AppNavigationRail
            homeActive
            onOpenTaskSearch={props.onOpenTaskSearch}
            onOpenCreateWorkspace={props.onOpenCreateWorkspace}
            onOpenAccount={props.onOpenAccount}
            onOpenHome={props.onOpenHome}
            onOpenApps={props.onOpenApps}
            onOpenChat={props.onOpenChat}
            onOpenSettings={props.onOpenSettings}
          />

          <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
            <ListPanelHeader
              title={taskScope === "remote" ? t("navigation.cloud_workspace") : t("navigation.local_workspace")}
              titleEnd={<SidebarTrigger className="titlebar-no-drag" />}
              searchValue={sessionQuery}
              searchPlaceholder={t("workspace_list.search_sessions")}
              onSearchChange={setSessionQuery}
              onSearchKeyDown={(event) => {
                if (event.key !== "Escape" || !sessionQuery) return;
                event.preventDefault();
                setSessionQuery("");
              }}
              onClearSearch={() => setSessionQuery("")}
              showClear={isFiltering}
              shortcut={isMacPlatform() ? "⌘⇧F" : "Ctrl+Shift+F"}
              addControl={(
                <button
                  type="button"
                  onClick={taskScope === "remote" ? props.onOpenConnectRemoteWorkspace : props.onOpenCreateLocalWorkspace}
                  aria-label={createTaskLabel}
                  title={createTaskLabel}
                  data-testid={taskScope === "remote" ? "sidebar-create-cloud-task" : "sidebar-create-local-task"}
                >
                  <Plus />
                </button>
              )}
            />

            <LazyMotion features={domMax}>
              <m.div
                layoutScroll
                data-slot="sidebar-content"
                data-sidebar="content"
                className="no-scrollbar flex min-h-0 flex-1 flex-col gap-px overflow-auto [--radius:var(--radius-xl)] group-data-[collapsible=icon]:overflow-hidden"
              >
                {pinnedSessions.length > 0 ? (
                  <GlobalPinnedSessions entries={pinnedSessions} />
                ) : null}
                <div className="flex flex-col gap-0">
                  {visibleWorkspaceSessionGroups.map((group) => (
                    <m.div
                      key={group.workspace.id}
                      layout="position"
                      transition={{ layout: { duration: 0.2, ease: [0.22, 1, 0.36, 1] } }}
                    >
                      {/* Keep session projection local to its workspace. When a
                          preceding workspace changes height, this outer block
                          slides once and its session rows travel with it. */}
                      <LayoutGroup id={`workspace-sessions-${group.workspace.id}`} inherit={false}>
                        <WorkspaceSidebarGroup
                          group={group}
                          className="py-0"
                          showInitialLoading={props.showInitialLoading}
                          previewCount={isFiltering ? Number.MAX_SAFE_INTEGER : previewCount(group.workspace.id)}
                          showMoreSessions={showMoreSessions}
                        />
                      </LayoutGroup>
                    </m.div>
                  ))}
                </div>
                {visibleWorkspaceSessionGroups.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center px-5 py-10 text-center text-xs text-dls-secondary">
                    {isFiltering ? t("workspace_list.no_matching_sessions") : t("workspace.no_tasks")}
                  </div>
                ) : null}
                {archivedSessions.length > 0 ? (
                  <GlobalArchivedSessions entries={archivedSessions} />
                ) : null}
              </m.div>
            </LazyMotion>
          </div>
        </div>
        <SidebarRail
          className="right-[-8px]! translate-x-0! bg-transparent! hover:bg-transparent!"
          style={{ cursor: "col-resize" }}
          aria-label={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          title={props.onStartResize ? t("session.resize_workspace_column") : undefined}
          onClick={props.onStartResize ? (event) => {
            event.preventDefault();
          } : undefined}
          onPointerDown={props.onStartResize}
        />
      </Sidebar>
    </SidebarContext.Provider>
  );
}

type GlobalPinnedSessionEntry = {
  group: WorkspaceSessionGroup;
  sessionId: string;
};

function GlobalPinnedSessions({ entries }: { entries: GlobalPinnedSessionEntry[] }) {
  return (
    <SidebarGroup data-global-pinned-sessions className="pb-1 pt-2">
      <SidebarGroupContent>
        <div className="px-3 pb-1 text-[11px] font-normal uppercase tracking-[0.04em] text-muted-foreground">
          {t("session_management.pinned")}
        </div>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuSub>
              {entries.map((entry) => (
                <GlobalPinnedSessionTree
                  key={`${entry.group.workspace.id}:${entry.sessionId}`}
                  group={entry.group}
                  sessionId={entry.sessionId}
                />
              ))}
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

type GlobalArchivedSessionEntry = {
  group: WorkspaceSessionGroup;
  session: SessionListItem;
};

function GlobalArchivedSessions({ entries }: { entries: GlobalArchivedSessionEntry[] }) {
  const ctx = useSidebarContext();
  const [expanded, setExpanded] = React.useState(false);
  const open = ctx.filteringSessions || expanded;

  return (
    <SidebarGroup data-global-archived-sessions className="pb-1 pt-1">
      <SidebarGroupContent>
        <Collapsible open={open} onOpenChange={setExpanded} className="group/archived">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="group/separator flex w-full cursor-pointer items-center gap-1.5 px-3 pb-1 pt-2.5 rounded transition-colors hover:bg-sidebar-accent/50"
              >
                <Archive className="size-3 shrink-0 text-muted-foreground" />
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("session_management.archived_label")}
                </span>
                <span className="text-[10px] tabular-nums text-muted-foreground/70">{entries.length}</span>
                <ChevronRight className="ml-auto size-3.5 text-muted-foreground transition-transform duration-200 group-data-open/archived:rotate-90" />
              </button>
            }
          />
          <CollapsibleContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSub>
                  {entries.map((entry) => (
                    <GlobalArchivedSessionItem
                      key={`${entry.group.workspace.id}:${entry.session.id}`}
                      group={entry.group}
                      session={entry.session}
                    />
                  ))}
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function GlobalArchivedSessionItem({ group, session }: GlobalArchivedSessionEntry) {
  const ctx = useSidebarContext();
  const pinnedIds = usePinnedSessionIds();
  const tree = useSessionTree(group.sessions, ctx.sessionStatusById);
  const forcedExpandedSessionIds = React.useMemo(
    () => new Set(
      ctx.selectedSessionId
        ? tree.ancestorIdsBySessionId.get(ctx.selectedSessionId) ?? []
        : [],
    ),
    [ctx.selectedSessionId, tree.ancestorIdsBySessionId],
  );

  return (
    <SessionMenuItem
      session={session}
      depth={0}
      tree={tree}
      workspaceId={group.workspace.id}
      forcedExpandedSessionIds={forcedExpandedSessionIds}
      isPinned={pinnedIds.has(session.id)}
      workspaceName={workspaceLabel(group.workspace)}
    />
  );
}

function GlobalPinnedSessionTree({ group, sessionId }: GlobalPinnedSessionEntry) {
  const ctx = useSidebarContext();
  const pinnedIds = usePinnedSessionIds();
  const tree = useSessionTree(group.sessions, ctx.sessionStatusById);
  const forcedExpandedSessionIds = React.useMemo(
    () => new Set(
      ctx.selectedSessionId
        ? tree.ancestorIdsBySessionId.get(ctx.selectedSessionId) ?? []
        : [],
    ),
    [ctx.selectedSessionId, tree.ancestorIdsBySessionId],
  );
  const rootIds = React.useMemo(() => new Set([sessionId]), [sessionId]);
  const rows = flattenSessionRows(
    group.sessions,
    1,
    tree,
    ctx.expandedSessionIds,
    forcedExpandedSessionIds,
    pinnedIds,
    [],
    { include: rootIds },
  );

  return rows.map((row) => (
    <SessionMenuItem
      key={row.session.id}
      session={row.session}
      depth={row.depth}
      tree={tree}
      workspaceId={group.workspace.id}
      forcedExpandedSessionIds={forcedExpandedSessionIds}
      isPinned={pinnedIds.has(row.session.id)}
      workspaceName={row.depth === 0 ? workspaceLabel(group.workspace) : undefined}
    />
  ));
}

type WorkspaceHeaderProps = React.ComponentProps<typeof SidebarMenuButton> & {
  workspace: WorkspaceInfo;
  sessionCount: number;
  statusLabel: string;
  isError: boolean;
  isLoading: boolean;
  isExpanded: boolean;
  showActivity: boolean;
  onToggleExpanded: () => void;
};

function WorkspaceHeader({
  workspace,
  sessionCount,
  statusLabel,
  isError,
  isLoading,
  isExpanded,
  showActivity,
  onToggleExpanded,
  onClick,
  ...props
}: WorkspaceHeaderProps) {
  return (
    <SidebarMenuButton
      {...props}
      className={cn(
        "relative h-12 rounded-xl border-0 bg-transparent px-2.5 shadow-none transition-colors duration-150",
        "group-hover/workspace-header:bg-sidebar-accent/25",
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onToggleExpanded();
      }}
      aria-expanded={isExpanded}
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-sidebar-foreground">
        {isExpanded ? (
          <FolderOpen className={cn("size-4.5", isLoading && "animate-pulse")} strokeWidth={1.8} />
        ) : (
          <Folder className={cn("size-4.5", isLoading && "animate-pulse")} strokeWidth={1.8} />
        )}
      </span>
      <div
        className={cn("min-w-0 flex-1", showActivity ? "pr-14" : "pr-7")}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-normal text-sidebar-foreground">{workspaceLabel(workspace)}</span>
          <span className="shrink-0 rounded-md bg-foreground/[0.07] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {sessionCount}
          </span>
        </span>
        {statusLabel ? (
          <span className={cn("mt-0.5 block truncate text-[11px] leading-none", isError ? "text-destructive" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        ) : null}
      </div>
    </SidebarMenuButton>
  );
}

type WorkspaceSidebarGroupProps = {
  className: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
};

function WorkspaceSidebarGroup({
  className,
  group,
  showInitialLoading,
  previewCount,
  showMoreSessions,
}: WorkspaceSidebarGroupProps) {
  const ctx = useSidebarContext();
  const workspace = group.workspace;
  const tree = useSessionTree(group.sessions, ctx.sessionStatusById);

  const forcedExpandedSessionIds = React.useMemo(
    () => new Set(
      ctx.selectedSessionId
        ? tree.ancestorIdsBySessionId.get(ctx.selectedSessionId) ?? []
        : [],
    ),
    [ctx.selectedSessionId, tree.ancestorIdsBySessionId],
  );

  const isConnecting = ctx.connectingWorkspaceId === workspace.id;
  const connectionState: WorkspaceConnectionState = ctx.workspaceConnectionStateById[workspace.id] ?? {
    status: "idle",
    message: null,
  };
  const isConnectionActionBusy = isConnecting || connectionState.status === "connecting";
  const isRemoteWorkspace = isRemoteConnectionWorkspace(workspace);
  const canRecover = isRemoteWorkspace && connectionState.status === "error";
  const taskLoadError = getWorkspaceTaskLoadErrorDisplay(workspace, group.error);
  const connectionIssueMessage = connectionState.status === "error"
    ? connectionState.message?.trim() || taskLoadError.message
    : group.error?.trim() || taskLoadError.message;
  const showRemoteConnectionIssue =
    (isRemoteWorkspace || isRemoteConnectionErrorMessage(connectionIssueMessage)) &&
    Boolean(connectionIssueMessage) &&
    (connectionState.status === "error" || group.status === "error");
  // While filtering the workspace stays open — a collapsed group would hide its matches.
  const isExpanded = ctx.filteringSessions || ctx.expandedWorkspaceIds.has(workspace.id);

  const statusLabel = (() => {
    if (showRemoteConnectionIssue) return t("workspace_list.unavailable");
    if (connectionState.status === "error") return connectionState.message?.trim() || taskLoadError.message;
    if (group.status === "error") return taskLoadError.label;
    if (isConnectionActionBusy) return t("workspace_list.connecting");
    if (isRemoteWorkspace && connectionState.status === "connected") return connectionState.message?.trim() || t("workspace_list.connected");
    return "";
  })();

  const pinnedIds = usePinnedSessionIds();
  const orderIds = useSessionOrder(workspace.id);
  const { groups: wsGroups, assignments: wsAssignments } = useWorkspaceGroups(workspace.id);
  const store = useSessionManagementStore;

  const { active: activeSessions } = React.useMemo(
    () => partitionArchivedSessions(group.sessions),
    [group.sessions],
  );
  const hasActiveWork = React.useMemo(
    () => activeSessions.some((session) => (
      isActiveWorkSessionStatus(ctx.sessionStatusById?.[session.id])
    )),
    [activeSessions, ctx.sessionStatusById],
  );
  const showWorkspaceActivity = hasActiveWork && !isExpanded;
  const sessionRows = flattenSessionRows(
    group.sessions,
    wsGroups.length > 0 ? Number.MAX_SAFE_INTEGER : previewCount,
    tree,
    ctx.expandedSessionIds,
    forcedExpandedSessionIds,
    EMPTY_PINNED_IDS,
    orderIds,
    { exclude: pinnedIds },
  );
  const visibleRootIds = React.useMemo(
    () => sessionRows.flatMap((row) => (row.depth === 0 ? [row.session.id] : [])),
    [sessionRows],
  );
  const workspaceLayoutKey = React.useMemo(
    () => [
      wsGroups.map((group) => group.id).join(","),
      sessionRows
        .map((row) => `${row.depth}:${row.session.id}:${wsAssignments[row.session.id] ?? ""}`)
        .join("|"),
    ].join("::"),
    [sessionRows, wsAssignments, wsGroups],
  );
  const previousWorkspaceLayoutKeyRef = React.useRef<string | null>(null);
  const sessionLayoutChanged = previousWorkspaceLayoutKeyRef.current === null
    || previousWorkspaceLayoutKeyRef.current !== workspaceLayoutKey;
  React.useLayoutEffect(() => {
    previousWorkspaceLayoutKeyRef.current = workspaceLayoutKey;
  }, [workspaceLayoutKey]);
  // Disable row-level layout projection when only an ancestor workspace moved.
  // The workspace wrapper performs the single FLIP animation in that case.
  const workspaceLayoutDependency = sessionLayoutChanged ? workspaceLayoutKey : undefined;
  const activeRootCount = React.useMemo(
    () => getRootSessions(activeSessions).filter((session) => !pinnedIds.has(session.id)).length,
    [activeSessions, pinnedIds],
  );
  const remainingRootSessions = Math.max(0, activeRootCount - previewCount);
  const showMoreLabel = remainingRootSessions > 0
    ? t("workspace_list.show_more", {
      count: Math.min(MAX_SESSIONS_PREVIEW, remainingRootSessions),
    })
    : t("workspace_list.show_more_fallback");

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          <Collapsible
            render={<SidebarMenuItem />}
            open={isExpanded}
            onOpenChange={() => ctx.toggleWorkspaceExpanded(workspace.id)}
            className="group/collapsible"
          >
            <div className="group/workspace-header relative max-md:hidden">
              <WorkspaceHeader
                workspace={workspace}
                sessionCount={getRootSessions(activeSessions).length}
                statusLabel={statusLabel}
                isError={group.status === "error"}
                isLoading={group.status === "loading" || isConnecting}
                isExpanded={isExpanded}
                showActivity={showWorkspaceActivity}
                onToggleExpanded={() => ctx.toggleWorkspaceExpanded(workspace.id)}
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {showWorkspaceActivity ? (
                  <span
                    className="flex size-6 items-center justify-center"
                    role="status"
                    title={t("workspace_list.session_streaming")}
                    aria-label={t("workspace_list.session_streaming")}
                  >
                    <SessionCircularProgress />
                  </span>
                ) : null}
                <WorkspaceActionsMenu
                  workspace={workspace}
                  isConnectionActionBusy={isConnectionActionBusy}
                  canRecover={canRecover}
                  className="size-6 rounded-lg text-muted-foreground hover:bg-background/60 hover:text-foreground data-popup-open:bg-background/60 data-popup-open:text-foreground"
                />
              </div>
            </div>

            <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
              <SidebarMenuSub className="ml-3 mt-0 border-l-0 pb-1 pl-1 pt-0">
                {showRemoteConnectionIssue ? (
                  <RemoteConnectionIssueCard
                    message={connectionIssueMessage}
                    tone={taskLoadError.tone}
                    canRecover={canRecover}
                    busy={isConnectionActionBusy}
                    onRecover={() => {
                      void Promise.resolve(ctx.onRecoverWorkspace(workspace.id));
                    }}
                    onTest={() => {
                      void Promise.resolve(ctx.onTestWorkspaceConnection(workspace.id));
                    }}
                    onEdit={() => {
                      ctx.onEditWorkspaceConnection(workspace.id);
                    }}
                  />
                ) : showInitialLoading || (group.status === "loading" && group.sessions.length === 0) ? (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs truncate">
                      <SessionDotMatrixLoader label={t("workspace.loading_tasks")} />
                      <span className="truncate">{t("workspace.loading_tasks")}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : activeSessions.length > 0 ? (
                  <>
                    {wsGroups.length > 0 ? (
                      <GroupedSessionList
                        sessionRows={sessionRows}
                        groups={wsGroups}
                        assignments={wsAssignments}
                        pinnedIds={pinnedIds}
                        tree={tree}
                        workspaceId={workspace.id}
                        forcedExpandedSessionIds={forcedExpandedSessionIds}
                        store={store}
                        layoutDependency={workspaceLayoutDependency}
                      />
                    ) : (
                      <Reorder.Group
                        as="div"
                        axis="y"
                        values={visibleRootIds}
                        onReorder={(ids) => {
                          const visible = new Set(ids);
                          const allRootIds = getRootSessions(activeSessions).map((s) => s.id);
                          const full = [...ids, ...allRootIds.filter((id) => !visible.has(id))];
                          store.getState().reorderSessions(workspace.id, full);
                        }}
                        className="flex flex-col"
                      >
                        {sessionRows.map((row) => (
                          <SessionMenuItem
                            key={row.session.id}
                            session={row.session}
                            depth={row.depth}
                            tree={tree}
                            workspaceId={workspace.id}
                            forcedExpandedSessionIds={forcedExpandedSessionIds}
                            isPinned={pinnedIds.has(row.session.id)}
                            reorderable={row.depth === 0}
                            layoutDependency={workspaceLayoutDependency}
                          />
                        ))}
                      </Reorder.Group>
                    )}
                    {wsGroups.length === 0 && activeRootCount > previewCount ? (
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                          className="text-muted-foreground text-xs"
                          onClick={() => showMoreSessions(workspace.id, activeRootCount)}
                        >
                          <span className="flex min-w-0 items-center gap-1">
                            <span className="truncate">{showMoreLabel}</span>
                            <span aria-hidden className="shrink-0">⋅</span>
                            <span
                              role="button"
                              tabIndex={0}
                              className="shrink-0 hover:text-foreground"
                              onClick={(event) => {
                                event.stopPropagation();
                                ctx.onOpenCreateGroupModal?.(workspace.id);
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                event.stopPropagation();
                                ctx.onOpenCreateGroupModal?.(workspace.id);
                              }}
                            >
                              {t("session_management.create_group")}
                            </span>
                          </span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ) : null}
                  </>
                ) : group.status === "error" ? (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      aria-disabled
                      className={cn("text-xs", taskLoadError.tone === "offline" ? "text-amber-600" : "text-destructive")}
                    >
                      <span className="truncate">{taskLoadError.message}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ) : (
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      className="text-muted-foreground text-xs"
                      onClick={() => ctx.onCreateTaskInWorkspace(workspace.id)}
                      aria-disabled={ctx.newTaskDisabled}
                    >
                      <span className="truncate">
                        {isRemoteWorkspace && connectionState.status === "connected"
                          ? connectionState.message?.trim() || t("workspace.connected_no_tasks")
                          : t("workspace.no_tasks")}
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )}
              </SidebarMenuSub>
            </CollapsibleContent>
          </Collapsible>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

const SESSION_DRAG_TYPE = "application/x-jugglework-session-id";
let activeSessionDragWorkspaceId: string | null = null;
const EMPTY_PINNED_IDS = new Set<string>();
const UNGROUPED_GROUP_ID = "__jugglework_ungrouped";

function SessionGroupActions({ group, groups, workspaceId, count }: {
  group: SessionGroupDefinition;
  groups: SessionGroupDefinition[];
  workspaceId: string;
  count: number;
}) {
  const ctx = useSidebarContext();
  const [expanded, setExpanded] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameLabel, setRenameLabel] = React.useState(group.label);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteDestination, setDeleteDestination] = React.useState(UNGROUPED_GROUP_ID);
  const otherGroups = groups.filter((candidate) => candidate.id !== group.id);
  const trimmedRenameLabel = renameLabel.trim();
  const deleteDestinationLabel = deleteDestination === UNGROUPED_GROUP_ID
    ? t("session_management.ungrouped")
    : otherGroups.find((candidate) => candidate.id === deleteDestination)?.label;

  React.useEffect(() => {
    if (!renameOpen) setRenameLabel(group.label);
  }, [group.label, renameOpen]);

  const saveRename = () => {
    if (!trimmedRenameLabel) return;
    useSessionManagementStore.getState().renameGroup(workspaceId, group.id, trimmedRenameLabel);
    setRenameOpen(false);
  };

  return (
    <>
      <span
        data-session-group-actions={group.id}
        className={cn(
          "relative ml-auto flex h-5 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150",
          expanded ? "w-15" : "w-4",
        )}
        onMouseLeave={() => setExpanded(false)}
      >
        <span data-session-group-count className="text-[10px] tabular-nums text-muted-foreground/70 group-hover/separator:hidden">
          {count}
        </span>
        {!expanded ? (
          <button
            type="button"
            className="hidden size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground group-hover/separator:flex"
            onMouseEnter={() => setExpanded(true)}
            onFocus={() => setExpanded(true)}
            onClick={(event) => event.stopPropagation()}
            aria-label={t("session_management.group_actions")}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        ) : (
          <span className="flex items-center">
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                ctx.onCreateTaskInWorkspace(workspaceId, group.id);
                setExpanded(false);
              }}
              aria-label={t("session_management.new_session_in_group")}
            >
              <Plus className="size-3" />
            </button>
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setRenameLabel(group.label);
                setRenameOpen(true);
              }}
              aria-label={t("session_management.rename_group")}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteDestination(UNGROUPED_GROUP_ID);
                setDeleteOpen(true);
              }}
              aria-label={t("session_management.delete_group")}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </span>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("session_management.rename_group")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameLabel}
            onChange={(event) => setRenameLabel(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveRename();
            }}
            aria-label={t("session_management.group_name")}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="button" disabled={!trimmedRenameLabel} onClick={saveRename}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("session_management.delete_group")}</DialogTitle>
          </DialogHeader>
          <label className="grid gap-2 text-sm font-medium">
            {t("session_management.move_sessions_to")}
            <Select
              value={deleteDestination}
              onValueChange={(value) => setDeleteDestination(value ?? UNGROUPED_GROUP_ID)}
            >
              <SelectTrigger className="w-full rounded-xl" data-destination-group-id={deleteDestination}>
                <SelectValue>{deleteDestinationLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectItem value={UNGROUPED_GROUP_ID}>{t("session_management.ungrouped")}</SelectItem>
                {otherGroups.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                useSessionManagementStore.getState().removeGroup(
                  workspaceId,
                  group.id,
                  deleteDestination === UNGROUPED_GROUP_ID ? null : deleteDestination,
                );
                setDeleteOpen(false);
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SessionGroupSeparator({ label, count, expanded, onToggle, group, groups, workspaceId, onTitlePointerDown }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  group?: SessionGroupDefinition;
  groups?: SessionGroupDefinition[];
  workspaceId?: string;
  onTitlePointerDown?: React.PointerEventHandler<HTMLSpanElement>;
}) {
  return (
    <div
      data-session-group={group?.id}
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onToggle();
      }}
      className="group/separator flex w-full items-center gap-1.5 rounded px-2 pb-1 pt-2.5 text-left transition-colors first:pt-1 hover:bg-sidebar-accent/50"
      aria-expanded={expanded}
    >
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")} />
      <span
        className="min-w-0 flex-1 cursor-grab touch-none truncate text-[11px] font-normal uppercase tracking-[0.04em] text-muted-foreground active:cursor-grabbing"
        onPointerDown={onTitlePointerDown}
      >
        {label}
      </span>
      {group && groups && workspaceId ? (
        <SessionGroupActions group={group} groups={groups} workspaceId={workspaceId} count={count} />
      ) : (
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{count}</span>
      )}
    </div>
  );
}

/** Drop zone wrapping a group's header + sessions. Dropping a session anywhere in the zone assigns it to this group. */
function GroupDropZone({ groupId, workspaceId, children }: {
  groupId: string | null;
  workspaceId: string;
  children: React.ReactNode;
}) {
  const [dragOver, setDragOver] = React.useState(false);
  const store = useSessionManagementStore;

  return (
    <div
      className={cn(
        "rounded transition-colors",
        dragOver && "bg-accent/40 ring-1 ring-accent/60",
      )}
      onDragOver={(e) => {
        if (
          activeSessionDragWorkspaceId === workspaceId
          && e.dataTransfer.types.includes(SESSION_DRAG_TYPE)
        ) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving this container, not when entering a child.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        setDragOver(false);
        if (activeSessionDragWorkspaceId !== workspaceId) return;
        e.preventDefault();
        e.stopPropagation();
        const payload = e.dataTransfer.getData(SESSION_DRAG_TYPE);
        try {
          const parsed = JSON.parse(payload) as { sessionId?: unknown; workspaceId?: unknown };
          if (
            typeof parsed.sessionId === "string"
            && parsed.sessionId
            && parsed.workspaceId === workspaceId
          ) {
            store.getState().assignGroup(workspaceId, parsed.sessionId, groupId);
          }
        } catch {
          // Ignore stale or malformed drag payloads.
        }
      }}
    >
      {children}
    </div>
  );
}

/** Renders sessions partitioned by group. Empty groups always show. Ungrouped sessions render at the end. */
function GroupedSessionList({ sessionRows, groups, assignments, pinnedIds, tree, workspaceId, forcedExpandedSessionIds, store, layoutDependency }: {
  sessionRows: FlattenedSessionRow[];
  groups: SessionGroupDefinition[];
  assignments: Record<string, string>;
  pinnedIds: Set<string>;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  store: typeof useSessionManagementStore;
  layoutDependency?: string;
}) {
  const ctx = useSidebarContext();
  const [previewCountByGroup, setPreviewCountByGroup] = React.useState<Record<string, number>>({});

  const groupPreviewCount = (groupId: string) =>
    previewCountByGroup[groupId] ?? MAX_SESSIONS_PREVIEW;

  const showMoreInGroup = React.useCallback((groupId: string, totalCount: number) => {
    setPreviewCountByGroup((current) => ({
      ...current,
      [groupId]: Math.min(
        (current[groupId] ?? MAX_SESSIONS_PREVIEW) + MAX_SESSIONS_PREVIEW,
        totalCount,
      ),
    }));
  }, []);

  // Partition root rows into per-group buckets + ungrouped.
  const rootRowsByGroup = new Map<string, FlattenedSessionRow[]>();
  const ungroupedRows: FlattenedSessionRow[] = [];
  // Child rows follow their parent regardless of group.
  const childrenByParent = new Map<string, FlattenedSessionRow[]>();
  const rowIndexById = new Map(sessionRows.map((row, index) => [row.session.id, index]));

  for (const row of sessionRows) {
    if (row.depth > 0) {
      const rowIndex = rowIndexById.get(row.session.id);
      if (rowIndex === undefined) continue;
      let parentId: string | null = null;
      for (let j = rowIndex - 1; j >= 0; j--) {
        if (sessionRows[j].depth < row.depth) { parentId = sessionRows[j].session.id; break; }
      }
      if (parentId) {
        const kids = childrenByParent.get(parentId) ?? [];
        kids.push(row);
        childrenByParent.set(parentId, kids);
      }
      continue;
    }
    const groupId = assignments[row.session.id];
    if (groupId && groups.some((g) => g.id === groupId)) {
      const bucket = rootRowsByGroup.get(groupId) ?? [];
      bucket.push(row);
      rootRowsByGroup.set(groupId, bucket);
    } else {
      ungroupedRows.push(row);
    }
  }

  const renderRow = (row: FlattenedSessionRow) => (
    <React.Fragment key={row.session.id}>
      <SessionMenuItem
        session={row.session}
        depth={row.depth}
        tree={tree}
        workspaceId={workspaceId}
        forcedExpandedSessionIds={forcedExpandedSessionIds}
        isPinned={pinnedIds.has(row.session.id)}
        groupDraggable={row.depth === 0}
        layoutDependency={layoutDependency}
      />
      {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
    </React.Fragment>
  );

  const renderGroup = (group: SessionGroupDefinition) => {
    const rows = rootRowsByGroup.get(group.id) ?? [];
    // Filtering opens every group and drops the preview cap: a match must never
    // sit behind a collapsed header or a "show more" row.
    const expanded = ctx.filteringSessions
      || !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(group.id);
    const limit = ctx.filteringSessions ? Number.MAX_SAFE_INTEGER : groupPreviewCount(group.id);

    return (
      <SessionGroupSection
        key={group.id}
        group={group}
        rows={rows}
        expanded={expanded}
        workspaceId={workspaceId}
        store={store}
        renderRow={renderRow}
        previewCount={limit}
        onShowMore={() => showMoreInGroup(group.id, rows.length)}
        layoutDependency={layoutDependency}
      />
    );
  };

  const ungroupedExpanded = ctx.filteringSessions
    || !(store.getState().groupsByWorkspace[workspaceId]?.collapsedGroupIds ?? []).includes(UNGROUPED_GROUP_ID);
  const ungroupedLimit = ctx.filteringSessions ? Number.MAX_SAFE_INTEGER : groupPreviewCount(UNGROUPED_GROUP_ID);
  const visibleUngroupedRows = ungroupedRows.slice(0, ungroupedLimit);
  const ungroupedRemaining = Math.max(0, ungroupedRows.length - ungroupedLimit);
  const visibleUngroupedRootIds = visibleUngroupedRows.map((r) => r.session.id);

  return (
    <>
      <Reorder.Group
        as="div"
        axis="y"
        values={groups.map((group) => group.id)}
        onReorder={(ids) => store.getState().reorderGroups(workspaceId, ids)}
        className="flex flex-col"
      >
        {groups.map(renderGroup)}
      </Reorder.Group>
      {ungroupedRows.length > 0 ? (
        <GroupDropZone groupId={null} workspaceId={workspaceId}>
          <Collapsible
            open={ungroupedExpanded}
            onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
          >
            <SessionGroupSeparator
              label={t("session_management.ungrouped")}
              count={ungroupedRows.length}
              expanded={ungroupedExpanded}
              onToggle={() => store.getState().toggleGroupExpanded(workspaceId, UNGROUPED_GROUP_ID)}
            />
            <CollapsibleContent>
              <Reorder.Group
                as="div"
                axis="y"
                values={visibleUngroupedRootIds}
                onReorder={(ids) => {
                  const allRootIds = sessionRows.filter((r) => r.depth === 0).map((r) => r.session.id);
                  const ungroupedSet = new Set(ungroupedRows.map((r) => r.session.id));
                  const visibleSet = new Set(ids);
                  const fullUngrouped = [...ids, ...ungroupedRows.map((r) => r.session.id).filter((id) => !visibleSet.has(id))];
                  let ui = 0;
                  const full = allRootIds.map((id) => ungroupedSet.has(id) ? fullUngrouped[ui++] : id);
                  store.getState().reorderSessions(workspaceId, full);
                }}
                className="flex flex-col"
              >
                {visibleUngroupedRows.map((row) => (
                  <React.Fragment key={row.session.id}>
                    <SessionMenuItem
                      session={row.session}
                      depth={row.depth}
                      tree={tree}
                      workspaceId={workspaceId}
                      forcedExpandedSessionIds={forcedExpandedSessionIds}
                      isPinned={pinnedIds.has(row.session.id)}
                      reorderable={row.depth === 0}
                      groupDraggable={row.depth === 0}
                      layoutDependency={layoutDependency}
                    />
                    {(childrenByParent.get(row.session.id) ?? []).map(renderRow)}
                  </React.Fragment>
                ))}
              </Reorder.Group>
              {ungroupedRemaining > 0 ? (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    className="text-muted-foreground text-xs"
                    onClick={() => showMoreInGroup(UNGROUPED_GROUP_ID, ungroupedRows.length)}
                  >
                    <span className="truncate">
                      {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, ungroupedRemaining) })}
                    </span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </GroupDropZone>
      ) : null}
    </>
  );
}

function SessionGroupSection({ group, rows, expanded, workspaceId, store, renderRow, previewCount, onShowMore, layoutDependency }: {
  group: SessionGroupDefinition;
  rows: FlattenedSessionRow[];
  expanded: boolean;
  workspaceId: string;
  store: typeof useSessionManagementStore;
  renderRow: (row: FlattenedSessionRow) => React.ReactNode;
  previewCount: number;
  onShowMore: () => void;
  layoutDependency?: string;
}) {
  const dragControls = useDragControls();
  const visibleRows = rows.slice(0, previewCount);
  const remaining = Math.max(0, rows.length - previewCount);

  return (
    <Reorder.Item
      as="div"
      value={group.id}
      id={group.id}
      layout="position"
      layoutDependency={layoutDependency}
      transition={{
        layout: layoutDependency
          ? { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
          : { duration: 0 },
      }}
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      <GroupDropZone groupId={group.id} workspaceId={workspaceId}>
        <Collapsible
          open={expanded}
          onOpenChange={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
          className="group/session-group"
        >
          <SessionGroupSeparator
            label={group.label}
            count={rows.length}
            expanded={expanded}
            onToggle={() => store.getState().toggleGroupExpanded(workspaceId, group.id)}
            group={group}
            groups={store.getState().groupsByWorkspace[workspaceId]?.groups ?? []}
            workspaceId={workspaceId}
            onTitlePointerDown={(event) => dragControls.start(event)}
          />
          <CollapsibleContent>
            {visibleRows.length > 0
              ? (
                <>
                  {visibleRows.map(renderRow)}
                  {remaining > 0 ? (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton
                        className="text-muted-foreground text-xs"
                        onClick={onShowMore}
                      >
                        <span className="truncate">
                          {t("workspace_list.show_more", { count: Math.min(MAX_SESSIONS_PREVIEW, remaining) })}
                        </span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ) : null}
                </>
              )
              : (
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton aria-disabled className="text-muted-foreground text-xs italic">
                    <span className="truncate">{t("session_management.empty_group")}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )}
          </CollapsibleContent>
        </Collapsible>
      </GroupDropZone>
    </Reorder.Item>
  );
}

type SessionMenuItemProps = {
  session: SessionListItem;
  depth: number;
  tree: SessionTreeState;
  workspaceId: string;
  forcedExpandedSessionIds: Set<string>;
  isPinned?: boolean;
  reorderable?: boolean;
  groupDraggable?: boolean;
  layoutDependency?: string;
  workspaceName?: string;
};

function SessionMenuItem({
  session,
  tree,
  workspaceId,
  forcedExpandedSessionIds,
  depth,
  isPinned = false,
  reorderable = false,
  groupDraggable = false,
  layoutDependency,
  workspaceName,
}: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const unreadIds = useUnreadSessionIds();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const itemTitle = workspaceName ? `${displayTitle} — ${workspaceName}` : displayTitle;
  const sessionActivityStatus = ctx.sessionStatusById?.[session.id];
  const resolvedActiveWork = isActiveWorkSessionStatus(sessionActivityStatus);
  const isUnread = unreadIds.has(session.id) && !isSelected;
  const isArchived = isSessionArchived(session);
  const relativeTime = formatSessionRelativeTime(session.time?.updated ?? session.time?.created);

  const openSession = () => {
    useSessionManagementStore.getState().clearUnread(session.id);
    ctx.onOpenSession(workspaceId, session.id);
  };

  const prefetchSession = () => {
    if (workspaceId !== ctx.selectedWorkspaceId) {
      return;
    }

    ctx.onPrefetchSession?.(workspaceId, session.id);
  };

  const dragProps = depth === 0 && groupDraggable ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      activeSessionDragWorkspaceId = workspaceId;
      e.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify({ sessionId: session.id, workspaceId }));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      activeSessionDragWorkspaceId = null;
    },
  } : {};

  const accessibleState = resolvedActiveWork && isSessionActivityStatus(sessionActivityStatus)
    ? `${displayTitle}, ${getSessionActivityStatusLabel(sessionActivityStatus)}`
    : isNeedsAttentionSessionStatus(sessionActivityStatus)
      ? `${displayTitle}, ${t("workspace_list.session_needs_attention")}`
      : isUnread
        ? `${displayTitle}, ${t("workspace_list.session_unread")}`
        : itemTitle;

  const rowButtonClass = cn(
    // Soft pill @ 11px radius from Paper; overlay tint adapts to theme
    // (light: --ow-light-hover ≈ black/5, dark: #FFFFFF17 ≈ white/9).
    // The left activity slot is the indent — dot-matrix sits in the chevron
    // lane and the title starts in the group-label lane without shifting.
    "relative h-12 rounded-[11px] transition-[padding,background-color] duration-150 ps-3 pe-7 group-hover/menu-sub-item:pe-20 group-has-data-popup-open/menu-sub-item:pe-20 data-active:font-medium",
    isSelected
      ? "!bg-black/[0.045] hover:!bg-black/[0.055] group-hover/menu-sub-item:!bg-black/[0.055] dark:!bg-white/[0.08] dark:hover:!bg-white/[0.095] dark:group-hover/menu-sub-item:!bg-white/[0.095]"
      : "hover:!bg-black/[0.025] group-hover/menu-sub-item:!bg-black/[0.025] dark:hover:!bg-white/[0.045] dark:group-hover/menu-sub-item:!bg-white/[0.045]",
    depth > 0 && "ps-7",
  );

  const leading = (
    <>
      <SessionLoadingIndicator status={sessionActivityStatus} isActiveWork={resolvedActiveWork} />
      {workspaceName ? <WorkspaceIcon workspaceId={workspaceId} sizeClass="size-3.5" /> : null}
    </>
  );

  const trailing = (
    <>
      <SessionOutcomeIndicator
        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-100 group-hover/menu-sub-item:opacity-0 pointer-events-none select-none"
        status={sessionActivityStatus}
        isActiveWork={resolvedActiveWork}
        isUnread={isUnread}
      />
      <SessionHoverQuickActions
        sessionId={session.id}
        isPinned={isPinned}
        isArchived={isArchived}
        relativeTime={relativeTime}
      />
    </>
  );

  const item = (
    <SidebarMenuSubItem {...dragProps} data-sidebar-session-id={session.id}>
      <SessionContextMenu sessionId={session.id} workspaceId={workspaceId} isPinned={isPinned} isArchived={isArchived}>
        <SidebarMenuSubButton
          isActive={isSelected}
          onClick={openSession}
          onPointerEnter={prefetchSession}
          onFocus={prefetchSession}
          aria-label={accessibleState}
          className={rowButtonClass}
        >
          {leading}
          <span className="min-w-0 flex-1 truncate" title={itemTitle}>{displayTitle}</span>
        </SidebarMenuSubButton>
      </SessionContextMenu>
      {trailing}
    </SidebarMenuSubItem>
  );

  if (!reorderable) return item;

  return (
    <Reorder.Item
      as="div"
      value={session.id}
      id={session.id}
      layout="position"
      layoutDependency={layoutDependency}
      transition={{
        layout: layoutDependency
          ? { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
          : { duration: 0 },
      }}
      dragElastic={0}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
    >
      {item}
    </Reorder.Item>
  );
}

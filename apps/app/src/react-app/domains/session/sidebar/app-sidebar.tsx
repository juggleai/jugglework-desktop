/** @jsxImportSource react */
import * as React from "react";
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ChevronRight,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Folder,
  FolderOpen,
  Tag,
  X,
} from "lucide-react";
import { LayoutGroup, LazyMotion, Reorder, domMax, m, useDragControls } from "motion/react";

import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import { JuggleWorkDenHelpLink } from "../../workspace/jugglework-den-help-link";
import { isRemoteWorkerUnreachableState } from "../../workspace/remote-workspace-diagnostics";
import type { OpenCreateWorkspace } from "../../workspace/types";
import type {
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../../../app/types";
import {
  isRemoteConnectionErrorMessage,
  getWorkspaceTaskLoadErrorDisplay,
  isRemoteConnectionWorkspace,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  collectRecentSessions,
  flattenSessionRows,
  formatSessionRelativeTime,
  getRootSessions,
  isMainSession,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  isSessionArchived,
  partitionArchivedSessions,
  partitionRecentSessionsIntoSections,
  resolveWorkspaceSessionIndicator,
  sortRootsByRecency,
  workspaceLabel,
} from "./utils";
import {
  PINNED_GROUP_ID,
  PROJECTS_GROUP_ID,
  RECENT_LIST_ID,
  RECENT_GROUP_ID,
  SECTION_GROUP_PREFIX,
  normalizeSectionLabel,
  normalizeSidebarGroupOrder,
  useSidebarSectionsStore,
  type ChatSortMode,
  type SidebarSection,
} from "./sidebar-sections-store";
import type { FlattenedSessionRow, RecentSessionEntry, SessionListItem, SessionTreeState } from "./utils";
import {
  useSessionManagementStore,
  usePinnedSessionIds,
  useSessionOrder,
  useWorkspaceGroups,
  type SessionGroupDefinition,
} from "./session-management-store";
import {
  useAcknowledgedAttentionSessionIds,
  useSessionCompletionStore,
  useUnseenCompletedSessionIds,
} from "./session-completion-store";
import { useWorkspaceIndicatorStore } from "./workspace-indicator-store";
import { setTaskScope, useTaskScope, useTaskScopeStore, workspaceTaskScope, type TaskScope } from "./task-scope-store";
import { cn } from "@/lib/utils";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { getSessionActivityStatusLabel, type SessionActivityStatus } from "../status/session-activity-store";
import { SessionDotMatrixLoader } from "./session-dot-matrix-loader";
import { SessionCircularProgress } from "./session-circular-progress";

/** 固定的左侧占位槽；loading 移到行尾后仍保留它，使会话标题与工作区标题对齐。 */
const LEFT_ACTIVITY_SLOT = "flex size-4 shrink-0 items-center justify-center";

/** Paper Desktop: unread #2FBE54, needs-action #E8933A (14px artboard → ~8px app). */
const OUTCOME_DOT_UNREAD = "#2FBE54";
const OUTCOME_DOT_NEEDS_ACTION = "#E8933A";

interface SessionLoadingIndicatorProps {
  status?: string;
  isActiveWork: boolean;
}

/** 会话行尾活动状态；悬浮或键盘操作时由快捷操作接管同一位置。 */
function SessionLoadingIndicator({ status, isActiveWork }: SessionLoadingIndicatorProps) {
  if (!isActiveWork) return null;

  const title = isSessionActivityStatus(status) && status !== "idle"
    ? getSessionActivityStatusLabel(status)
    : t("workspace_list.session_streaming");

  return (
    <span
      data-session-loading-indicator
      className="absolute right-2.5 top-1/2 z-10 flex size-5 -translate-y-1/2 items-center justify-center transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-has-data-popup-open/menu-sub-item:opacity-0 group-has-[:focus-visible]/menu-sub-item:opacity-0"
      role="status"
      title={title}
      aria-label={title}
    >
      <SessionCircularProgress className="dark:text-white" />
    </span>
  );
}

interface SessionOutcomeIndicatorProps {
  className?: string;
  status?: string;
  isActiveWork: boolean;
  isCompleted: boolean;
}

/** Right-edge outcome: orange = needs you, green = completed unseen, none = seen/idle. */
function SessionOutcomeIndicator({ className, status, isActiveWork, isCompleted }: SessionOutcomeIndicatorProps) {
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

  if (!isCompleted) return null;

  return (
    <span
      data-session-attention-indicator
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: OUTCOME_DOT_UNREAD }}
      title={t("workspace_list.session_completed_unseen")}
      aria-label={t("workspace_list.session_completed_unseen")}
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
        {!isArchived ? <MoveToSectionDropdownSub sessionId={sessionId} /> : null}
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
      {!isArchived ? <MoveToSectionContextSub sessionId={sessionId} /> : null}
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

/** Opens the section-name dialog owned by the sidebar root. */
const SidebarSectionDialogContext = React.createContext<{
  openCreateSection: (assignSessionId?: string) => void;
  openRenameSection: (section: SidebarSection) => void;
} | null>(null);

function useSidebarSectionDialog() {
  return React.use(SidebarSectionDialogContext);
}

function MoveToSectionDropdownSub({ sessionId }: { sessionId: string }) {
  const localScope = useTaskScope() === "local";
  const sections = useSidebarSectionsStore((state) => state.sections);
  const assignedSectionId = useSidebarSectionsStore((state) => state.assignments[sessionId] ?? null);
  const dialog = useSidebarSectionDialog();
  const assignSession = useSidebarSectionsStore.getState().assignSession;
  // Sections are rendered only in the local list.
  if (!localScope) return null;

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput className="size-4" />
        {t("sidebar_sections.move_to_section")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        {sections.length > 0 ? (
          <>
            <DropdownMenuItem onClick={() => assignSession(sessionId, null)} disabled={!assignedSectionId}>
              {t("sidebar_sections.remove_from_section")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {sections.map((section) => (
              <DropdownMenuItem
                key={section.id}
                onClick={() => assignSession(sessionId, section.id)}
                disabled={assignedSectionId === section.id}
              >
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={() => dialog?.openCreateSection(sessionId)}>
          <Plus className="size-4" />
          {t("sidebar_sections.new_section")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function MoveToSectionContextSub({ sessionId }: { sessionId: string }) {
  const localScope = useTaskScope() === "local";
  const sections = useSidebarSectionsStore((state) => state.sections);
  const assignedSectionId = useSidebarSectionsStore((state) => state.assignments[sessionId] ?? null);
  const dialog = useSidebarSectionDialog();
  const assignSession = useSidebarSectionsStore.getState().assignSession;
  if (!localScope) return null;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInput className="mr-2 size-4" />
        {t("sidebar_sections.move_to_section")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {sections.length > 0 ? (
          <>
            <ContextMenuItem onClick={() => assignSession(sessionId, null)} disabled={!assignedSectionId}>
              {t("sidebar_sections.remove_from_section")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {sections.map((section) => (
              <ContextMenuItem
                key={section.id}
                onClick={() => assignSession(sessionId, section.id)}
                disabled={assignedSectionId === section.id}
              >
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem onClick={() => dialog?.openCreateSection(sessionId)}>
          <Plus className="size-4" />
          {t("sidebar_sections.new_section")}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/**
 * "⋯" menu on the Projects/Recent headings: chat sort mode and New section.
 * The trigger shares the heading's hover/focus/open reveal rules.
 */
function SidebarListOptionsMenu({ revealClassName }: { revealClassName: string }) {
  const sortMode = useSidebarSectionsStore((state) => state.sortMode);
  const dialog = useSidebarSectionDialog();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <button
            type="button"
            aria-label={t("sidebar_sections.list_options")}
            title={t("sidebar_sections.list_options")}
            data-sidebar-list-options
            className={cn(
              "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:pointer-events-auto data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-foreground data-popup-open:opacity-100",
              revealClassName,
            )}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-4" />
          </button>
        )}
      />
      <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowDownUp className="size-4" />
            {t("sidebar_sections.chat_sort")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(value) => {
                if (value === "recent" || value === "manual") useSidebarSectionsStore.getState().setSortMode(value);
              }}
            >
              {(["recent", "manual"] as const satisfies readonly ChatSortMode[]).map((mode) => (
                <DropdownMenuRadioItem key={mode} value={mode} data-sort-mode={mode}>
                  {mode === "recent" ? t("sidebar_sections.sort_recent") : t("sidebar_sections.sort_manual")}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-sidebar-new-section onClick={() => dialog?.openCreateSection()}>
          <Plus className="size-4" />
          {t("sidebar_sections.new_section")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shared create/rename dialog for sidebar sections. */
function SidebarSectionNameDialog({
  state,
  onClose,
}: {
  state: { mode: "create"; assignSessionId?: string } | { mode: "rename"; section: SidebarSection } | null;
  onClose: () => void;
}) {
  const [label, setLabel] = React.useState("");
  React.useEffect(() => {
    if (state) setLabel(state.mode === "rename" ? state.section.label : "");
  }, [state]);
  const normalized = normalizeSectionLabel(label);
  const submit = () => {
    if (!state || !normalized) return;
    const store = useSidebarSectionsStore.getState();
    if (state.mode === "rename") {
      store.renameSection(state.section.id, normalized);
    } else {
      const id = store.createSection(normalized);
      if (id && state.assignSessionId) store.assignSession(state.assignSessionId, id);
    }
    onClose();
  };

  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {state?.mode === "rename" ? t("sidebar_sections.rename_section") : t("sidebar_sections.new_section")}
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={label}
          maxLength={60}
          placeholder={t("sidebar_sections.section_name")}
          onChange={(event) => setLabel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          aria-label={t("sidebar_sections.section_name")}
          data-sidebar-section-name-input
        />
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button type="button" disabled={!normalized} onClick={submit} data-sidebar-section-submit>
            {state?.mode === "rename" ? t("common.save") : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/** Pin → Archive → relative time — 与运行 loading 共用行尾位置，悬浮时优先显示。 */
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
        "absolute right-2.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-has-data-popup-open/menu-sub-item:opacity-100 group-has-data-popup-open/menu-sub-item:pointer-events-auto group-has-[:focus-visible]/menu-sub-item:opacity-100 group-has-[:focus-visible]/menu-sub-item:pointer-events-auto",
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
        <DropdownMenuItem className="text-sm" onClick={() => ctx.onOpenRenameWorkspace(workspace.id)}>
          <Pencil className="size-4" />
          {t("workspace_list.edit_name")}
        </DropdownMenuItem>
        <DropdownMenuItem className="text-sm" onClick={() => ctx.onShareWorkspace(workspace.id)}>
          <Share2 className="size-4" />
          {t("workspace_list.share")}
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
  rebuilt: boolean;
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
              {props.rebuilt
                ? t("workspace_list.remote_worker_rebuilt_title")
                : t("workspace_list.remote_worker_unavailable")}
            </div>
            <div className="mt-1 text-[11px] leading-5 text-gray-10">
              {props.rebuilt
                ? t("workspace_list.remote_worker_rebuilt_hint")
                : t("workspace_list.remote_worker_unavailable_hint")}
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
              {props.rebuilt ? (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px]"
                  onClick={props.onEdit}
                  disabled={props.busy}
                >
                  <Settings size={12} />
                  {t("workspace_list.update_connection")}
                </Button>
              ) : null}
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
  visibleSessionIds?: string[];
  showSessionActions?: boolean;
  sessionStatusById?: Record<string, string>;
  connectingWorkspaceId: string | null;
  workspaceConnectionStateById: Record<string, WorkspaceConnectionState>;
  newTaskDisabled: boolean;
  isTaskCreationPending?: (workspaceId: string) => boolean;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onExpandWorkspace?: (workspaceId: string) => void;
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
  onOpenReviews: () => void;
  onOpenSettings: () => void;
  railPreviewActive?: boolean;
  railPreviewMotionDisabled?: boolean;
  previewTaskScope?: TaskScope;
  onRailPreviewEnter?: React.MouseEventHandler<HTMLElement>;
  onRailPreviewLeave?: React.MouseEventHandler<HTMLElement>;
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
  return status === "idle" || status === "thinking" || status === "responding" || status === "retrying" || status === "stalled" || status === "error" || status === "compacting" || status === "waiting" || status === "incomplete";
}

export function AppSidebar(props: AppSidebarProps) {
  const storedTaskScope = useTaskScope();
  const taskScope = props.previewTaskScope ?? storedTaskScope;
  // Automation runs need a registered workspace so their sessions remain addressable,
  // but those internal directories are not user-created local workspaces and must not
  // appear in the ordinary workspace/session sidebar.
  const sidebarWorkspaceSessionGroups = React.useMemo(
    () => props.workspaceSessionGroups.filter((group) => !group.workspace.automationManaged),
    [props.workspaceSessionGroups],
  );
  const lastWorkspaceByScope = useTaskScopeStore((state) => state.lastWorkspaceByScope);
  const rememberWorkspace = useTaskScopeStore((state) => state.rememberWorkspace);
  const [projectsExpanded, setProjectsExpanded] = React.useState(true);
  const [recentExpanded, setRecentExpanded] = React.useState(true);
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [previewCountByWorkspaceId, setPreviewCountByWorkspaceId] = React.useState<Record<string, number>>({});
  const [expandedSessionIds, setExpandedSessionIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const autoExpandedWorkspaceIdRef = React.useRef("");

  const visibleSessionIds = React.useMemo(
    () => new Set(props.visibleSessionIds ?? (props.selectedSessionId ? [props.selectedSessionId] : [])),
    [props.selectedSessionId, props.visibleSessionIds],
  );

  // Green completion dots: agent finished while the session was not visible.
  React.useEffect(() => {
    const statuses = props.sessionStatusById ?? {};
    const accessibleMainSessionIds = new Set(
      sidebarWorkspaceSessionGroups.flatMap((group) => group.sessions.filter(isMainSession).map((session) => session.id)),
    );
    useSessionCompletionStore.getState().reconcile(statuses, accessibleMainSessionIds, visibleSessionIds);
  }, [props.sessionStatusById, sidebarWorkspaceSessionGroups, visibleSessionIds]);

  const expandWorkspace = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    setExpandedWorkspaceIds((previous) => {
      if (previous.has(id)) return previous;
      const next = new Set(previous);
      next.add(id);
      return next;
    });
    props.onExpandWorkspace?.(id);
  }, [props.onExpandWorkspace]);

  const toggleWorkspaceExpanded = React.useCallback((workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;
    const willExpand = !expandedWorkspaceIds.has(id);
    setExpandedWorkspaceIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    if (willExpand) props.onExpandWorkspace?.(id);
  }, [expandedWorkspaceIds, props.onExpandWorkspace]);

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
    if (!id || autoExpandedWorkspaceIdRef.current === id) return;
    // TIPS: 只在选中的工作区真正变化时自动展开一次。用户手动折叠当前工作区后，普通重渲染
    // 或 onExpandWorkspace 回调身份变化都不能覆盖这次显式操作。
    autoExpandedWorkspaceIdRef.current = id;
    expandWorkspace(id);
  }, [props.selectedWorkspaceId, expandWorkspace]);

  const syncedWorkspaceIdRef = React.useRef<string | null>(null);
  const syncedTaskScopeRef = React.useRef(taskScope);

  // Keeps the rail's task scope and the opened workspace pointing at each
  // other: opening a session from outside the list (search, deep link) adopts
  // that workspace's scope, while switching scope on the rail focuses the
  // first workspace the new list contains.
  React.useEffect(() => {
    if (props.previewTaskScope) return;
    const workspaceId = props.selectedWorkspaceId.trim();
    const selected = sidebarWorkspaceSessionGroups.find(
      (group) => group.workspace.id === workspaceId,
    )?.workspace;

    if (selected && syncedWorkspaceIdRef.current !== workspaceId) {
      syncedWorkspaceIdRef.current = workspaceId;
      const scope = workspaceTaskScope(selected);
      syncedTaskScopeRef.current = scope;
      setTaskScope(scope);
      rememberWorkspace(scope, workspaceId);
      return;
    }

    if (syncedTaskScopeRef.current === taskScope) return;
    syncedTaskScopeRef.current = taskScope;
    if (selected && workspaceTaskScope(selected) === taskScope) return;

    // Returning to a scope should reopen the workspace the user last visited
    // there, not the first one the list happens to contain. Restoring the id
    // is enough: the route layer follows up by navigating to the remembered
    // session of that workspace. Falls back to the first in-scope workspace
    // when the previous one was deleted or has not been seen this run.
    const groupsInScope = sidebarWorkspaceSessionGroups.filter(
      (group) => workspaceTaskScope(group.workspace) === taskScope,
    );
    const rememberedId = lastWorkspaceByScope[taskScope];
    const restored = rememberedId
      ? groupsInScope.find((group) => group.workspace.id === rememberedId)?.workspace
      : undefined;
    const target = restored ?? groupsInScope[0]?.workspace;
    if (!target) return;
    syncedWorkspaceIdRef.current = target.id;
    void props.onSelectWorkspace(target.id);
  }, [props.onSelectWorkspace, props.previewTaskScope, props.selectedWorkspaceId, sidebarWorkspaceSessionGroups, taskScope, lastWorkspaceByScope, rememberWorkspace]);

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

  const contextValue: SidebarContextValue = {
    selectedWorkspaceId: props.selectedWorkspaceId,
    selectedSessionId: props.selectedSessionId,
    visibleSessionIds,
    developerMode: props.developerMode,
    showSessionActions: props.showSessionActions,
    sessionStatusById: props.sessionStatusById,
    newTaskDisabled: props.newTaskDisabled,
    isTaskCreationPending: props.isTaskCreationPending,
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
    filteringSessions: false,
  };

  const workspaceSessionGroupsInScope = React.useMemo(
    () => sidebarWorkspaceSessionGroups.filter(
      (group) => workspaceTaskScope(group.workspace) === taskScope,
    ),
    [sidebarWorkspaceSessionGroups, taskScope],
  );
  const reorderLocalWorkspaces = React.useCallback((visibleIds: string[]) => {
    const orderedVisibleIds = [...visibleIds];
    const merged = props.workspaceSessionGroups.map((group) => {
      const isReorderableLocalWorkspace = !group.workspace.automationManaged
        && workspaceTaskScope(group.workspace) === "local";
      return isReorderableLocalWorkspace
        ? orderedVisibleIds.shift() ?? group.workspace.id
        : group.workspace.id;
    });
    props.onReorderWorkspaces?.(merged);
  }, [props.onReorderWorkspaces, props.workspaceSessionGroups]);

  const unseenCompletedSessionIds = useUnseenCompletedSessionIds();
  const localWorkspaceIndicator = React.useMemo(
    () => resolveWorkspaceSessionIndicator(
      sidebarWorkspaceSessionGroups
        .filter((group) => group.workspace.workspaceType === "local")
        .flatMap((group) => group.sessions.filter(isMainSession)),
      props.sessionStatusById,
      unseenCompletedSessionIds,
    ),
    [props.sessionStatusById, sidebarWorkspaceSessionGroups, unseenCompletedSessionIds],
  );
  React.useEffect(() => {
    useWorkspaceIndicatorStore.getState().setLocalWorkspaceIndicator(localWorkspaceIndicator);
  }, [localWorkspaceIndicator]);
  const pinnedIds = useSessionManagementStore((state) => state.pinnedIds);
  const pinnedSessions = React.useMemo(() => {
    const sessionsById = new Map<string, GlobalPinnedSessionEntry>();
    for (const group of workspaceSessionGroupsInScope) {
      const roots = getRootSessions(partitionArchivedSessions(group.sessions).active);
      for (const session of roots) {
        sessionsById.set(session.id, { group, sessionId: session.id });
      }
    }
    return pinnedIds.flatMap((sessionId) => {
      const entry = sessionsById.get(sessionId);
      return entry ? [entry] : [];
    });
  }, [pinnedIds, workspaceSessionGroupsInScope]);
  const archivedSessions = React.useMemo(() => {
    const entries: GlobalArchivedSessionEntry[] = [];
    for (const group of workspaceSessionGroupsInScope) {
      for (const session of partitionArchivedSessions(group.sessions).archived.filter(isMainSession)) {
        entries.push({ group, session });
      }
    }
    return entries;
  }, [workspaceSessionGroupsInScope]);
  const sidebarSections = useSidebarSectionsStore((state) => state.sections);
  const savedSidebarGroupOrder = useSidebarSectionsStore((state) => state.groupOrder);
  const sectionAssignments = useSidebarSectionsStore((state) => state.assignments);
  const chatSortMode = useSidebarSectionsStore((state) => state.sortMode);
  const sectionManualOrder = useSidebarSectionsStore((state) => state.manualOrder);
  const sectionedSessions = React.useMemo(
    () => partitionRecentSessionsIntoSections(
      collectRecentSessions(workspaceSessionGroupsInScope, new Set(pinnedIds)),
      {
        sectionIds: sidebarSections.map((section) => section.id),
        assignments: sectionAssignments,
        sortMode: chatSortMode,
        manualOrder: sectionManualOrder,
        recentListId: RECENT_LIST_ID,
      },
    ),
    [chatSortMode, pinnedIds, sectionAssignments, sectionManualOrder, sidebarSections, workspaceSessionGroupsInScope],
  );
  const recentSessions = sectionedSessions.recent;
  const sidebarGroupOrder = React.useMemo(
    () => normalizeSidebarGroupOrder(savedSidebarGroupOrder, sidebarSections.map((section) => section.id)),
    [savedSidebarGroupOrder, sidebarSections],
  );
  const [sectionDialog, setSectionDialog] = React.useState<
    { mode: "create"; assignSessionId?: string } | { mode: "rename"; section: SidebarSection } | null
  >(null);
  const sectionDialogContext = React.useMemo(() => ({
    openCreateSection: (assignSessionId?: string) => setSectionDialog({ mode: "create", assignSessionId }),
    openRenameSection: (section: SidebarSection) => setSectionDialog({ mode: "rename", section }),
  }), []);

  return (
    <SidebarContext.Provider value={contextValue}>
    <SidebarSectionDialogContext.Provider value={sectionDialogContext}>
      <Sidebar
        collapsible="offcanvas"
        className={cn(
          "border-e-0! mac:**:data-[sidebar=sidebar]:bg-transparent",
          props.railPreviewActive && "pointer-events-none",
          props.railPreviewMotionDisabled && "!transition-none",
        )}
      >
        <div
          className={cn(
            "relative flex h-full min-h-0 w-full",
            props.railPreviewActive && "pointer-events-none",
          )}
        >
          {props.railPreviewActive ? (
            <div
              aria-hidden="true"
              className="pointer-events-auto absolute left-[53px] right-12 top-[45px] z-10 h-10 mac:titlebar-no-drag"
              onMouseEnter={props.onRailPreviewEnter}
              onMouseLeave={props.onRailPreviewLeave}
              data-session-preview-title-hover-guard
            />
          ) : null}
          {props.railPreviewActive ? <div className="w-12 shrink-0" aria-hidden="true" /> : (
            <AppNavigationRail
              workspaceId={props.selectedWorkspaceId}
              homeActive
              onOpenTaskSearch={props.onOpenTaskSearch}
              onOpenCreateWorkspace={props.onOpenCreateWorkspace}
              onOpenAccount={props.onOpenAccount}
              onOpenHome={props.onOpenHome}
              onOpenApps={props.onOpenApps}
              onOpenChat={props.onOpenChat}
              onOpenReviews={props.onOpenReviews}
              onOpenSettings={props.onOpenSettings}
            />
          )}

          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-secondary-sidebar-bg)] md:-mr-px md:mb-1.5 md:ml-1 md:mt-[var(--session-shell-top-inset)] md:overflow-hidden md:rounded-l-[18px] md:border md:border-r-0 md:border-dls-border md:shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
              props.railPreviewActive && "md:rounded-r-[18px] md:border-r md:shadow-[0_18px_48px_rgba(15,23,42,0.18)] dark:md:shadow-[0_18px_48px_rgba(0,0,0,0.42)]",
              props.railPreviewActive && "pointer-events-auto",
            )}
            onMouseEnter={props.onRailPreviewEnter}
            onMouseLeave={props.onRailPreviewLeave}
            data-session-list-surface
            data-session-list-preview={props.railPreviewActive ? "true" : undefined}
          >
            <ListPanelHeader
              title={taskScope === "remote" ? t("navigation.cloud_workspace") : t("navigation.local_workspace")}
              titleOnly
              titleEnd={(
                <button
                  type="button"
                  className="jw-list-panel-icon-button"
                  onClick={props.onOpenTaskSearch}
                  aria-label={t("workspace_list.search_sessions")}
                  title={t("workspace_list.search_sessions")}
                  data-session-list-title-search
                >
                  <Search />
                </button>
              )}
            />

            <LazyMotion features={domMax}>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <m.div
                  layoutScroll
                  data-slot="sidebar-content"
                  data-sidebar="content"
                  className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain [--radius:var(--radius-xl)] group-data-[collapsible=icon]:overflow-hidden"
                >
                  {taskScope === "local" ? (
                    <Reorder.Group
                      as="div"
                      axis="y"
                      values={sidebarGroupOrder}
                      onReorder={(next) => useSidebarSectionsStore.getState().setGroupOrder(next)}
                      className="flex shrink-0 flex-col gap-0.5"
                      data-sidebar-group-order
                    >
                      {sidebarGroupOrder.map((groupId) => {
                        if (groupId === PINNED_GROUP_ID) {
                          return pinnedSessions.length > 0 ? (
                            <SidebarGroupReorderItem key={groupId} groupId={groupId}>
                              {(startDrag) => <GlobalPinnedSessions entries={pinnedSessions} onTitlePointerDown={startDrag} />}
                            </SidebarGroupReorderItem>
                          ) : null;
                        }
                        if (groupId === PROJECTS_GROUP_ID) {
                          return (
                            <SidebarGroupReorderItem key={groupId} groupId={groupId}>
                              {(startDrag) => (
                                <LocalProjectsSection
                                  groups={workspaceSessionGroupsInScope}
                                  expanded={projectsExpanded}
                                  onExpandedChange={setProjectsExpanded}
                                  onAddWorkspace={props.onOpenCreateLocalWorkspace}
                                  showInitialLoading={props.showInitialLoading}
                                  previewCount={previewCount}
                                  showMoreSessions={showMoreSessions}
                                  onReorderWorkspaces={reorderLocalWorkspaces}
                                  onTitlePointerDown={startDrag}
                                />
                              )}
                            </SidebarGroupReorderItem>
                          );
                        }
                        if (groupId === RECENT_GROUP_ID) {
                          return (
                            <SidebarGroupReorderItem key={groupId} groupId={groupId}>
                              {(startDrag) => (
                                <LocalRecentSessions
                                  entries={recentSessions}
                                  expanded={recentExpanded}
                                  onExpandedChange={setRecentExpanded}
                                  emptyLabel={t("workspace.no_tasks")}
                                  manualSort={chatSortMode === "manual"}
                                  onTitlePointerDown={startDrag}
                                />
                              )}
                            </SidebarGroupReorderItem>
                          );
                        }
                        if (groupId.startsWith(SECTION_GROUP_PREFIX)) {
                          const sectionId = groupId.slice(SECTION_GROUP_PREFIX.length);
                          const section = sidebarSections.find((candidate) => candidate.id === sectionId);
                          if (!section) return null;
                          return (
                            <SidebarGroupReorderItem key={groupId} groupId={groupId}>
                              {(startDrag) => (
                                <LocalSidebarSection
                                  section={section}
                                  entries={sectionedSessions.bySection.get(section.id) ?? []}
                                  manualSort={chatSortMode === "manual"}
                                  onTitlePointerDown={startDrag}
                                />
                              )}
                            </SidebarGroupReorderItem>
                          );
                        }
                        return null;
                      })}
                    </Reorder.Group>
                  ) : (
                    <div className="flex shrink-0 flex-col gap-0.5">
                      {pinnedSessions.length > 0 ? <GlobalPinnedSessions entries={pinnedSessions} /> : null}
                      {workspaceSessionGroupsInScope.map((group) => (
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
                              previewCount={previewCount(group.workspace.id)}
                              showMoreSessions={showMoreSessions}
                            />
                          </LayoutGroup>
                        </m.div>
                      ))}
                    </div>
                  )}
                  {taskScope !== "local" && workspaceSessionGroupsInScope.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center px-5 py-10 text-center text-xs text-dls-secondary">
                      {t("workspace.no_tasks")}
                    </div>
                  ) : null}
                </m.div>
                {archivedSessions.length > 0 ? (
                  <GlobalArchivedSessions entries={archivedSessions} />
                ) : null}
              </div>
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
      <SidebarSectionNameDialog state={sectionDialog} onClose={() => setSectionDialog(null)} />
    </SidebarSectionDialogContext.Provider>
    </SidebarContext.Provider>
  );
}

type GlobalPinnedSessionEntry = {
  group: WorkspaceSessionGroup;
  sessionId: string;
};

type SidebarGroupDragStarter = React.PointerEventHandler<HTMLElement>;

function SidebarGroupReorderItem({
  groupId,
  children,
}: {
  groupId: string;
  children: (startDrag: SidebarGroupDragStarter) => React.ReactNode;
}) {
  const dragControls = useDragControls();
  const startDrag = React.useCallback<SidebarGroupDragStarter>((event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragControls.start(event);
  }, [dragControls]);

  return (
    <Reorder.Item
      as="div"
      value={groupId}
      dragListener={false}
      dragControls={dragControls}
      dragElastic={0}
      layout="position"
      data-sidebar-group-reorder-item={groupId}
      className="relative"
    >
      {children(startDrag)}
    </Reorder.Item>
  );
}

function LocalProjectsSection({
  groups,
  expanded,
  onExpandedChange,
  onAddWorkspace,
  showInitialLoading,
  previewCount,
  showMoreSessions,
  onReorderWorkspaces,
  onTitlePointerDown,
}: {
  groups: WorkspaceSessionGroup[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onAddWorkspace: () => void;
  showInitialLoading?: boolean;
  previewCount: (workspaceId: string) => number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
  onReorderWorkspaces: (workspaceIds: string[]) => void;
  onTitlePointerDown?: SidebarGroupDragStarter;
}) {
  return (
    <SidebarGroup data-local-projects className="shrink-0 px-0 pb-1 pt-3">
      <SidebarGroupContent>
        <Collapsible open={expanded} onOpenChange={onExpandedChange} className="group/projects">
          <div className="group/projects-heading relative">
            <CollapsibleTrigger
              render={(
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-1 rounded-lg px-3 pe-20 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/25 hover:text-sidebar-foreground"
                >
                  <span
                    className={cn(onTitlePointerDown && "cursor-grab touch-none active:cursor-grabbing")}
                    onPointerDown={onTitlePointerDown}
                  >
                    {t("workspace_list.projects")}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-[transform,opacity] duration-150",
                      expanded
                        ? "rotate-90 opacity-0 group-hover/projects-heading:opacity-100 group-focus-visible/projects-heading:opacity-100"
                        : "opacity-100",
                    )}
                    strokeWidth={1.8}
                  />
                </button>
              )}
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              <SidebarListOptionsMenu revealClassName={PROJECTS_HEADING_REVEAL} />
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onAddWorkspace();
                }}
                aria-label={t("workspace_list.add_workspace")}
                title={t("workspace_list.add_workspace")}
                data-local-projects-add-workspace
                className={cn(
                  "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  PROJECTS_HEADING_REVEAL,
                )}
              >
                <Plus className="size-4" />
              </button>
            </div>
          </div>
          <CollapsibleContent className="pt-0.5">
            <Reorder.Group
              as="div"
              axis="y"
              values={groups.map((group) => group.workspace.id)}
              onReorder={onReorderWorkspaces}
              className="flex flex-col gap-0.5"
            >
              {groups.map((group) => (
                <WorkspaceReorderItem
                  key={group.workspace.id}
                  group={group}
                  className="py-0"
                  showInitialLoading={showInitialLoading}
                  previewCount={previewCount(group.workspace.id)}
                  showMoreSessions={showMoreSessions}
                />
              ))}
            </Reorder.Group>
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

// Heading actions stay hidden until hover, keyboard focus, or an open menu, and
// never intercept pointer events while hidden.
const PROJECTS_HEADING_REVEAL = "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/projects-heading:pointer-events-auto group-hover/projects-heading:opacity-100 group-has-[:focus-visible]/projects-heading:pointer-events-auto group-has-[:focus-visible]/projects-heading:opacity-100 group-has-data-popup-open/projects-heading:pointer-events-auto group-has-data-popup-open/projects-heading:opacity-100";
const LIST_HEADING_REVEAL = "pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/list-heading:pointer-events-auto group-hover/list-heading:opacity-100 group-has-[:focus-visible]/list-heading:pointer-events-auto group-has-[:focus-visible]/list-heading:opacity-100 group-has-data-popup-open/list-heading:pointer-events-auto group-has-data-popup-open/list-heading:opacity-100";

/** Collapsible heading shared by Recent and user sections. */
function SidebarListHeading({
  label,
  actions,
  dataAttribute,
  onTitlePointerDown,
  expanded,
}: {
  label: string;
  actions: React.ReactNode;
  dataAttribute?: Record<string, string>;
  onTitlePointerDown?: SidebarGroupDragStarter;
  expanded: boolean;
}) {
  return (
    <div className="group/list-heading relative" {...dataAttribute}>
      <CollapsibleTrigger
        render={(
          <button
            type="button"
            className="group/list-trigger flex h-8 w-full items-center gap-1 rounded-lg px-3 pe-12 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/25 hover:text-sidebar-foreground"
          >
            <span
              className={cn("min-w-0 truncate", onTitlePointerDown && "cursor-grab touch-none active:cursor-grabbing")}
              onPointerDown={onTitlePointerDown}
            >
              {label}
            </span>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 transition-[transform,opacity] duration-150",
                expanded
                  ? "rotate-90 opacity-0 group-hover/list-heading:opacity-100 group-focus-visible/list-trigger:opacity-100"
                  : "opacity-100",
              )}
              strokeWidth={1.8}
            />
          </button>
        )}
      />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5">{actions}</div>
    </div>
  );
}

/**
 * Root-session list for Recent and sections. In manual mode rows are
 * draggable and the new order is saved under `listId`.
 */
function SidebarSessionList({
  entries,
  listId,
  manualSort,
  dataAttribute,
}: {
  entries: RecentSessionEntry[];
  listId: string;
  manualSort: boolean;
  dataAttribute?: Record<string, string>;
}) {
  const ids = React.useMemo(() => entries.map((entry) => entry.session.id), [entries]);
  const items = entries.map((entry) => (
    <LocalRecentSessionItem
      key={`${entry.group.workspace.id}:${entry.session.id}`}
      entry={entry}
      reorderable={manualSort}
    />
  ));
  return (
    <SidebarMenu className="px-2" {...dataAttribute}>
      <SidebarMenuItem>
        <SidebarMenuSub className="gap-0.5 border-l-0">
          {manualSort ? (
            <Reorder.Group
              as="div"
              axis="y"
              values={ids}
              onReorder={(next) => useSidebarSectionsStore.getState().setManualOrder(listId, next)}
              className="flex flex-col gap-0.5"
            >
              {items}
            </Reorder.Group>
          ) : items}
        </SidebarMenuSub>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function LocalRecentSessions({
  entries,
  expanded,
  onExpandedChange,
  emptyLabel,
  manualSort,
  onTitlePointerDown,
}: {
  entries: RecentSessionEntry[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  emptyLabel: string;
  manualSort: boolean;
  onTitlePointerDown?: SidebarGroupDragStarter;
}) {
  return (
    <SidebarGroup data-local-recent-sessions className="shrink-0 px-0 pb-2 pt-2">
      <SidebarGroupContent>
        <Collapsible open={expanded} onOpenChange={onExpandedChange}>
          <SidebarListHeading
            label={t("workspace_list.recent")}
            actions={<SidebarListOptionsMenu revealClassName={LIST_HEADING_REVEAL} />}
            onTitlePointerDown={onTitlePointerDown}
            expanded={expanded}
          />
          <CollapsibleContent className="pt-0.5">
            {entries.length > 0 ? (
              <SidebarSessionList
                entries={entries}
                listId={RECENT_LIST_ID}
                manualSort={manualSort}
                dataAttribute={{ "data-local-recent-session-list": "" }}
              />
            ) : (
              <div className="px-3 py-5 text-xs text-dls-secondary">{emptyLabel}</div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function LocalSidebarSection({
  section,
  entries,
  manualSort,
  onTitlePointerDown,
}: {
  section: SidebarSection;
  entries: RecentSessionEntry[];
  manualSort: boolean;
  onTitlePointerDown?: SidebarGroupDragStarter;
}) {
  const ctx = useSidebarContext();
  const collapsed = useSidebarSectionsStore((state) => state.collapsedSectionIds.includes(section.id));
  const unseenCompletedSessionIds = useUnseenCompletedSessionIds();
  const acknowledgedAttentionSessionIds = useAcknowledgedAttentionSessionIds();
  const dialog = useSidebarSectionDialog();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const store = useSidebarSectionsStore.getState;
  const hasUnread = entries.some(({ session }) => {
    const status = ctx.sessionStatusById?.[session.id];
    return unseenCompletedSessionIds.has(session.id)
      || (isNeedsAttentionSessionStatus(status) && !acknowledgedAttentionSessionIds.has(session.id));
  });
  const markAllRead = () => {
    const completionStore = useSessionCompletionStore.getState();
    for (const { session } of entries) {
      completionStore.clear(session.id);
      const status = ctx.sessionStatusById?.[session.id];
      if (isNeedsAttentionSessionStatus(status)) completionStore.acknowledgeAttention(session.id);
    }
  };
  const archiveChats = () => {
    if (!ctx.onArchiveSession) return;
    for (const { session } of entries) ctx.onArchiveSession(session.id, true);
  };

  return (
    <SidebarGroup data-sidebar-section={section.id} className="shrink-0 px-0 pb-1 pt-2">
      <SidebarGroupContent>
        <SidebarSectionDropZone sectionId={section.id}>
          <Collapsible open={!collapsed} onOpenChange={() => store().toggleSectionCollapsed(section.id)}>
            <SidebarListHeading
              label={section.label}
              onTitlePointerDown={onTitlePointerDown}
              expanded={!collapsed}
              actions={(
                <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <button
                      type="button"
                      aria-label={t("sidebar_sections.section_options")}
                      title={t("sidebar_sections.section_options")}
                      data-sidebar-section-options
                      onClick={(event) => event.stopPropagation()}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-foreground",
                        LIST_HEADING_REVEAL,
                      )}
                    >
                      <MoreHorizontal className="size-4" />
                    </button>
                  )}
                />
                <DropdownMenuContent align="start" side="bottom" sideOffset={4} className="w-56">
                  <DropdownMenuItem onClick={() => dialog?.openRenameSection(section)}>
                    <Settings className="size-4" />
                    {t("common.edit")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled={!hasUnread} onClick={markAllRead}>
                    <span aria-hidden className="flex size-4 items-center justify-center">✓</span>
                    {t("sidebar_sections.mark_all_read")}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={entries.length === 0 || !ctx.onArchiveSession} onClick={archiveChats}>
                    <Archive className="size-4" />
                    {t("sidebar_sections.archive_chats")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => dialog?.openCreateSection()}>
                    <Plus className="size-4" />
                    {t("sidebar_sections.new_section")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                    <X className="size-4" />
                    {t("sidebar_sections.remove_section")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
                </DropdownMenu>
              )}
            />
            <CollapsibleContent className="pt-0.5">
              {entries.length > 0 ? (
                <SidebarSessionList entries={entries} listId={section.id} manualSort={manualSort} />
              ) : (
                <div className="px-3 py-2 text-xs text-dls-secondary">{t("sidebar_sections.empty_section")}</div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </SidebarSectionDropZone>
      </SidebarGroupContent>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("sidebar_sections.remove_section")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("sidebar_sections.delete_section_hint", { name: section.label })}
          </p>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              data-sidebar-section-delete-confirm
              onClick={() => {
                store().removeSection(section.id);
                setDeleteOpen(false);
              }}
            >
              {t("sidebar_sections.remove_section")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarGroup>
  );
}

/** Accepts a root session dragged from Recent or another custom section. */
function SidebarSectionDropZone({ sectionId, children }: { sectionId: string; children: React.ReactNode }) {
  const [dragOver, setDragOver] = React.useState(false);

  return (
    <div
      data-sidebar-section-drop-zone={sectionId}
      className={cn(
        "rounded-lg transition-colors",
        dragOver && "bg-sidebar-accent/50 ring-1 ring-sidebar-ring/50",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          const payload = JSON.parse(event.dataTransfer.getData(SESSION_DRAG_TYPE)) as { sessionId?: unknown };
          if (typeof payload.sessionId === "string" && payload.sessionId) {
            useSidebarSectionsStore.getState().assignSession(payload.sessionId, sectionId);
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

function LocalRecentSessionItem({ entry, reorderable = false }: { entry: RecentSessionEntry; reorderable?: boolean }) {
  const ctx = useSidebarContext();
  const pinnedIds = usePinnedSessionIds();
  const tree = useSessionTree(entry.group.sessions, ctx.sessionStatusById);
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
      session={entry.session}
      depth={0}
      tree={tree}
      workspaceId={entry.group.workspace.id}
      forcedExpandedSessionIds={forcedExpandedSessionIds}
      isPinned={pinnedIds.has(entry.session.id)}
      workspaceName={workspaceLabel(entry.group.workspace)}
      showWorkspaceIcon={false}
      flushLeft
      reorderable={reorderable}
      groupDraggable
    />
  );
}

function GlobalPinnedSessions({ entries, onTitlePointerDown }: {
  entries: GlobalPinnedSessionEntry[];
  onTitlePointerDown?: SidebarGroupDragStarter;
}) {
  const [expanded, setExpanded] = React.useState(true);

  return (
    <SidebarGroup data-global-pinned-sessions className="shrink-0 px-0 pb-1 pt-2">
      <SidebarGroupContent>
        <Collapsible open={expanded} onOpenChange={setExpanded} className="group/pinned">
          <CollapsibleTrigger
            render={(
              <button
                type="button"
                className="group/pinned-heading flex h-8 w-full items-center gap-1 rounded-lg px-3 text-left text-[13px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/25 hover:text-sidebar-foreground"
              >
                <span
                  className={cn(onTitlePointerDown && "cursor-grab touch-none active:cursor-grabbing")}
                  onPointerDown={onTitlePointerDown}
                >
                  {t("session_management.pinned")}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-[transform,opacity] duration-150",
                    expanded
                      ? "rotate-90 opacity-0 group-hover/pinned-heading:opacity-100 group-focus-visible/pinned-heading:opacity-100"
                      : "opacity-100",
                  )}
                  strokeWidth={1.8}
                />
              </button>
            )}
          />
          <CollapsibleContent className="pt-0.5">
            <SidebarMenu data-global-pinned-session-list className="px-2">
              <SidebarMenuItem>
                <SidebarMenuSub className="gap-0.5 border-l-0">
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
          </CollapsibleContent>
        </Collapsible>
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
    <SidebarGroup
      data-global-archived-sessions
      className={cn(
        "min-h-0 shrink-0 overflow-hidden border-t border-dls-border py-1 transition-[flex-basis] duration-200 ease-out motion-reduce:transition-none",
        open ? "basis-1/3" : "basis-10",
      )}
    >
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <Collapsible open={open} onOpenChange={setExpanded} className="group/archived flex min-h-0 flex-1 flex-col">
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="group/separator relative flex h-8 w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-left transition-colors duration-150 hover:bg-sidebar-accent/25"
              >
                <span className="relative flex size-5 shrink-0 items-center justify-center text-sidebar-foreground">
                  <Archive className="size-4" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 truncate text-[14px] font-normal text-sidebar-foreground">
                  {t("session_management.archived_label")}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-open/archived:rotate-90" />
              </button>
            }
          />
          <CollapsibleContent className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuSub className="gap-0.5">
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
      showWorkspaceIcon={false}
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
      showWorkspaceIcon={false}
      flushLeft
    />
  ));
}

type WorkspaceReorderItemProps = {
  className: string;
  group: WorkspaceSessionGroup;
  showInitialLoading?: boolean;
  previewCount: number;
  showMoreSessions: (workspaceId: string, totalRoots: number) => void;
};

// A normal click still expands/collapses a workspace. Start reordering only
// after deliberate pointer movement so the two interactions do not conflict.
const WORKSPACE_DRAG_THRESHOLD_PX = 5;

function WorkspaceReorderItem({
  className,
  group,
  showInitialLoading,
  previewCount,
  showMoreSessions,
}: WorkspaceReorderItemProps) {
  const dragControls = useDragControls();

  const startDragOnThreshold = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const startX = event.clientX;
      const startY = event.clientY;
      let dragStarted = false;

      const cleanup = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", cleanup);
        window.removeEventListener("pointercancel", cleanup);
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (dragStarted) return;
        const moved = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
        if (moved < WORKSPACE_DRAG_THRESHOLD_PX) return;
        dragStarted = true;
        cleanup();
        dragControls.start(moveEvent);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", cleanup);
      window.addEventListener("pointercancel", cleanup);
    },
    [dragControls],
  );

  return (
    <Reorder.Item
      as="div"
      value={group.workspace.id}
      id={group.workspace.id}
      layout="position"
      dragElastic={0}
      dragListener={false}
      dragControls={dragControls}
      transformTemplate={(_latest, generated) => generated.replace(/ ?scale[XY]?\([^)]*\)/g, "")}
      className="relative"
    >
      <LayoutGroup id={`local-project-sessions-${group.workspace.id}`} inherit={false}>
        <WorkspaceSidebarGroup
          group={group}
          className={className}
          showInitialLoading={showInitialLoading}
          previewCount={previewCount}
          showMoreSessions={showMoreSessions}
          onWorkspaceTitlePointerDown={startDragOnThreshold}
        />
      </LayoutGroup>
    </Reorder.Item>
  );
}

type WorkspaceHeaderProps = React.ComponentProps<typeof SidebarMenuButton> & {
  workspace: WorkspaceInfo;
  statusLabel: string;
  isError: boolean;
  isLoading: boolean;
  isExpanded: boolean;
  showActivity: boolean;
  onToggleExpanded: () => void;
  onTitlePointerDown?: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceHeader({
  workspace,
  statusLabel,
  isError,
  isLoading,
  isExpanded,
  showActivity,
  onToggleExpanded,
  onTitlePointerDown,
  onClick,
  ...props
}: WorkspaceHeaderProps) {
  return (
    <SidebarMenuButton
      {...props}
      className={cn(
        // TIPS: gap-1.5 + size-5 图标槽，让工作区名称贴近文件夹图标；名称起点与会话行标题对齐。
        "relative h-8 gap-1.5 rounded-xl border-0 bg-transparent px-2.5 leading-5 tracking-normal shadow-none transition-colors duration-150",
        "group-hover/workspace-header:bg-sidebar-accent/25",
      )}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onToggleExpanded();
      }}
      aria-expanded={isExpanded}
    >
      <span className="relative flex size-5 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-sidebar-foreground">
        {isExpanded ? (
          <FolderOpen className={cn("size-4.5", isLoading && "animate-pulse")} strokeWidth={1.8} />
        ) : (
          <Folder className={cn("size-4.5", isLoading && "animate-pulse")} strokeWidth={1.8} />
        )}
      </span>
      <div
        // TIPS: 默认仅给 loading 留出小槽，尽可能展示名称；悬浮、菜单打开或键盘聚焦时
        // 扩大尾部留白，让名称以省略号收缩并给「加号 + 更多」让位，与会话行行为一致。
        className={cn(
          "min-w-0 flex-1 transition-[padding] duration-150 group-hover/workspace-header:pr-10 group-has-data-popup-open/workspace-header:pr-10 group-has-[:focus-visible]/workspace-header:pr-10",
          onTitlePointerDown && "cursor-grab touch-none active:cursor-grabbing",
          showActivity ? "pr-6" : "pr-0",
        )}
        onPointerDown={onTitlePointerDown}
      >
        <span className="block truncate text-[14px] font-normal text-sidebar-foreground">{workspaceLabel(workspace)}</span>
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
  onWorkspaceTitlePointerDown?: React.PointerEventHandler<HTMLDivElement>;
};

function WorkspaceSidebarGroup({
  className,
  group,
  showInitialLoading,
  previewCount,
  showMoreSessions,
  onWorkspaceTitlePointerDown,
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
    if (group.status === "error") return taskLoadError.message;
    if (isConnectionActionBusy) return t("workspace_list.connecting");
    if (isRemoteWorkspace && connectionState.status === "connected") return connectionState.message?.trim() || t("workspace_list.connected");
    return "";
  })();

  const pinnedIds = usePinnedSessionIds();
  const orderIds = useSessionOrder(workspace.id);
  const { groups: wsGroups, assignments: wsAssignments } = useWorkspaceGroups(workspace.id);
  const sidebarSections = useSidebarSectionsStore((state) => state.sections);
  const sidebarSectionAssignments = useSidebarSectionsStore((state) => state.assignments);
  const store = useSessionManagementStore;
  const sectionedRootIds = React.useMemo(() => {
    const validSectionIds = new Set(sidebarSections.map((section) => section.id));
    return new Set(
      Object.entries(sidebarSectionAssignments)
        .filter(([, sectionId]) => validSectionIds.has(sectionId))
        .map(([sessionId]) => sessionId),
    );
  }, [sidebarSectionAssignments, sidebarSections]);
  const rootsHiddenFromWorkspace = React.useMemo(
    () => new Set([...pinnedIds, ...sectionedRootIds]),
    [pinnedIds, sectionedRootIds],
  );

  const { active: activeSessions } = React.useMemo(
    () => partitionArchivedSessions(group.sessions),
    [group.sessions],
  );
  // Pinned roots already surface their activity in the global pinned section.
  // Exclude their whole subtree here so a collapsed workspace only advertises
  // work that is still represented inside that workspace.
  const hasActiveWork = React.useMemo(
    () => getRootSessions(activeSessions).some((session) => (
      !rootsHiddenFromWorkspace.has(session.id) && tree.activeIds.has(session.id)
    )),
    [activeSessions, rootsHiddenFromWorkspace, tree.activeIds],
  );
  const showWorkspaceActivity = hasActiveWork && !isExpanded;
  const chatSortMode = useSidebarSectionsStore((state) => state.sortMode);
  const manualSort = chatSortMode === "manual";
  // Recent mode orders by update time and ignores the saved drag order. Manual
  // mode follows the drag order, with roots it has not seen yet placed first.
  const effectiveOrderIds = React.useMemo(() => {
    const roots = sortRootsByRecency(getRootSessions(activeSessions));
    if (!manualSort) return roots.map((session) => session.id);
    const known = new Set(orderIds);
    return [...roots.filter((session) => !known.has(session.id)).map((session) => session.id), ...orderIds];
  }, [activeSessions, manualSort, orderIds]);
  const sessionRows = flattenSessionRows(
    group.sessions,
    wsGroups.length > 0 ? Number.MAX_SAFE_INTEGER : previewCount,
    tree,
    ctx.expandedSessionIds,
    forcedExpandedSessionIds,
    EMPTY_PINNED_IDS,
    effectiveOrderIds,
    { exclude: rootsHiddenFromWorkspace },
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
    () => getRootSessions(activeSessions).filter((session) => !rootsHiddenFromWorkspace.has(session.id)).length,
    [activeSessions, rootsHiddenFromWorkspace],
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
                statusLabel={statusLabel}
                isError={group.status === "error"}
                isLoading={group.status === "loading" || isConnecting}
                isExpanded={isExpanded}
                showActivity={showWorkspaceActivity}
                onToggleExpanded={() => ctx.toggleWorkspaceExpanded(workspace.id)}
                onTitlePointerDown={onWorkspaceTitlePointerDown}
              />
              {/* TIPS: 行尾同一锚点上「运行中 loading」与「加号/更多」互斥呈现：
                  折叠且有任务运行时默认只显示 loading；悬停、键盘聚焦（:focus-visible）
                  或菜单打开（data-popup-open）时淡入操作图标并淡出 loading，鼠标移开即恢复。
                  显隐用 :has(:focus-visible) 而非 focus-within —— 点击行会留下 DOM 焦点，
                  focus-within 会让图标在鼠标移走后常驻；:focus-visible 只在键盘聚焦时命中。
                  loading 绝对定位在同一锚点，切换时行内布局零抖动；图标隐藏时不接收指针事件，
                  避免挡住右侧空白处的点击。 */}
              <div className="absolute right-1 top-1/2 -translate-y-1/2">
                {showWorkspaceActivity ? (
                  <span
                    className="absolute right-0 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center transition-opacity duration-150 group-hover/workspace-header:opacity-0 group-has-data-popup-open/workspace-header:opacity-0 group-has-[:focus-visible]/workspace-header:opacity-0"
                    role="status"
                    title={t("workspace_list.session_streaming")}
                    aria-label={t("workspace_list.session_streaming")}
                  >
                    <SessionCircularProgress />
                  </span>
                ) : null}
                <div
                  data-workspace-actions
                  className="flex items-center gap-0.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover/workspace-header:opacity-100 group-hover/workspace-header:pointer-events-auto group-has-data-popup-open/workspace-header:opacity-100 group-has-data-popup-open/workspace-header:pointer-events-auto group-has-[:focus-visible]/workspace-header:opacity-100 group-has-[:focus-visible]/workspace-header:pointer-events-auto"
                >
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 rounded-lg text-muted-foreground hover:bg-background/60 hover:text-foreground"
                    disabled={ctx.newTaskDisabled || ctx.isTaskCreationPending?.(workspace.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      ctx.onCreateTaskInWorkspace(workspace.id);
                    }}
                    aria-label={t("session.cmd_new_session_title")}
                  >
                    <Plus className="size-4" />
                  </Button>
                  <WorkspaceActionsMenu
                    workspace={workspace}
                    isConnectionActionBusy={isConnectionActionBusy}
                    canRecover={canRecover}
                    className="size-6 rounded-lg text-muted-foreground hover:bg-background/60 hover:text-foreground data-popup-open:bg-background/60 data-popup-open:text-foreground"
                  />
                </div>
              </div>
            </div>

            <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden pt-0.5 transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
              {/* TIPS: 不加左缩进，会话行的选中底色才能与工作区行左右对齐等宽（两者都是 x=80..315）。 */}
              <SidebarMenuSub className="mt-0 gap-0.5 border-l-0 pb-1 pt-0">
                {showRemoteConnectionIssue ? (
                  <RemoteConnectionIssueCard
                    message={connectionIssueMessage}
                    tone={taskLoadError.tone}
                    canRecover={canRecover}
                    busy={isConnectionActionBusy}
                    rebuilt={isRemoteWorkerUnreachableState(connectionState)}
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
                        className="flex flex-col gap-0.5"
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
                            reorderable={manualSort && row.depth === 0}
                            groupDraggable={row.depth === 0}
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
                      aria-disabled={ctx.newTaskDisabled || ctx.isTaskCreationPending?.(workspace.id)}
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
        className="min-w-0 flex-1 cursor-grab touch-none truncate text-[13px] font-normal leading-5 tracking-normal text-muted-foreground active:cursor-grabbing"
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
  const manualSort = useSidebarSectionsStore((state) => state.sortMode === "manual");
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
        className="flex flex-col gap-0.5"
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
            <CollapsibleContent className="pt-0.5">
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
                className="flex flex-col gap-0.5"
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
                      reorderable={manualSort && row.depth === 0}
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
          <CollapsibleContent className="flex flex-col gap-0.5 pt-0.5">
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
  /** Remove the reserved activity/workspace leading lane for flat global lists. */
  flushLeft?: boolean;
  /**
   * 是否在标题前显示工作区色点。默认跟随 workspaceName。
   * TIPS: 「已归档」要求与工作区内的会话行长得完全一致，所以关掉色点；
   * workspaceName 仍然保留，悬浮提示与无障碍标签照样能读出所属工作区。
   */
  showWorkspaceIcon?: boolean;
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
  showWorkspaceIcon = Boolean(workspaceName),
  flushLeft = false,
}: SessionMenuItemProps) {
  const ctx = useSidebarContext();
  const unseenCompletedSessionIds = useUnseenCompletedSessionIds();
  const acknowledgedAttentionSessionIds = useAcknowledgedAttentionSessionIds();
  const isSelected = ctx.selectedSessionId === session.id;
  const displayTitle = getDisplaySessionTitle(session.title);
  const itemTitle = workspaceName ? `${displayTitle} — ${workspaceName}` : displayTitle;
  const sessionActivityStatus = ctx.sessionStatusById?.[session.id];
  const resolvedActiveWork = isActiveWorkSessionStatus(sessionActivityStatus);
  const needsAttention = isNeedsAttentionSessionStatus(sessionActivityStatus)
    && !acknowledgedAttentionSessionIds.has(session.id);
  const isCompleted = unseenCompletedSessionIds.has(session.id) && !ctx.visibleSessionIds.has(session.id);
  const isArchived = isSessionArchived(session);
  const relativeTime = formatSessionRelativeTime(session.time?.updated ?? session.time?.created);

  const openSession = () => {
    useSessionCompletionStore.getState().clear(session.id);
    if (isNeedsAttentionSessionStatus(sessionActivityStatus)) {
      useSessionCompletionStore.getState().acknowledgeAttention(session.id);
    }
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
    : needsAttention
      ? `${displayTitle}, ${t("workspace_list.session_needs_attention")}`
      : isCompleted
        ? `${displayTitle}, ${t("workspace_list.session_completed_unseen")}`
        : itemTitle;

  const rowButtonClass = cn(
    // Soft pill @ 11px radius from Paper; overlay tint adapts to theme
    // (light: --ow-light-hover ≈ black/5, dark: #FFFFFF17 ≈ white/9).
    "relative h-8 rounded-[11px] text-[14px] data-[size=md]:text-[14px] leading-5 tracking-normal transition-[padding,background-color] duration-150 ps-3 pe-7 group-hover/menu-sub-item:pe-20 group-has-data-popup-open/menu-sub-item:pe-20 data-active:font-medium",
    isSelected
      ? "!bg-black/[0.045] hover:!bg-black/[0.055] group-hover/menu-sub-item:!bg-black/[0.055] dark:!bg-white/[0.08] dark:hover:!bg-white/[0.095] dark:group-hover/menu-sub-item:!bg-white/[0.095]"
      : "hover:!bg-black/[0.025] group-hover/menu-sub-item:!bg-black/[0.025] dark:hover:!bg-white/[0.045] dark:group-hover/menu-sub-item:!bg-white/[0.045]",
    depth > 0 && "ps-7",
  );

  const leading = flushLeft ? null : (
    <>
      <span aria-hidden="true" className={LEFT_ACTIVITY_SLOT} />
      {showWorkspaceIcon ? <WorkspaceIcon workspaceId={workspaceId} sizeClass="size-3.5" /> : null}
    </>
  );

  const trailing = (
    <>
      {/* TIPS: 与工作区行保持一致，loading 和悬浮操作绝对定位到同一尾部锚点；
          默认展示运行状态，悬浮、菜单打开或键盘聚焦时 loading 淡出、操作淡入，结束后自动恢复。 */}
      <SessionLoadingIndicator status={sessionActivityStatus} isActiveWork={resolvedActiveWork} />
      <SessionOutcomeIndicator
        className="absolute right-3 top-1/2 -translate-y-1/2 opacity-100 transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-has-data-popup-open/menu-sub-item:opacity-0 group-has-[:focus-visible]/menu-sub-item:opacity-0 pointer-events-none select-none"
        status={needsAttention ? sessionActivityStatus : undefined}
        isActiveWork={resolvedActiveWork}
        isCompleted={isCompleted}
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

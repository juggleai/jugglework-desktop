/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  CalendarDays,
  ChevronDown,
  CircleCheckBig,
  Eye,
  ListTodo,
  Plus,
  SquarePen,
  UserRoundCheck,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { TaskSection } from "./task-page-state";

const primaryNavigation: Array<[TaskSection, string, LucideIcon]> = [
  ["today", "tasks.today", CalendarDays],
  ["assigned", "tasks.assigned_to_me", UserRoundCheck],
  ["following", "tasks.following", Eye],
  ["activity", "tasks.activity", Activity],
];

const quickAccessNavigation: Array<[TaskSection, string, LucideIcon]> = [
  ["all", "tasks.all", ListTodo],
  ["created", "tasks.created_by_me", SquarePen],
  ["delegated", "tasks.assigned_by_me", UserRoundPlus],
  ["completed", "tasks.completed", CircleCheckBig],
];

const taskNavigation = [...primaryNavigation, ...quickAccessNavigation];

export type TasksSidebarRegistration = {
  section: TaskSection;
  activityUnreadCount?: number;
  onSectionChange?: (section: TaskSection) => void;
  lists?: Array<{ id: string; name: string; marker: string; version: number }>;
  selectedListId?: string | null;
  onSelectList?: (id: string) => void;
  onCreateList?: (name: string) => Promise<boolean>;
  createListRequested?: boolean;
  onCreateListRequestHandled?: () => void;
  onArchiveList?: (id: string, version: number) => void;
};

export function taskSectionHeading(section: TaskSection) {
  return taskNavigation.find(([candidate]) => candidate === section)?.[1] ?? "tasks.today";
}

export function TasksSidebar(props: TasksSidebarRegistration & { preview?: boolean }) {
  const [quickAccessExpanded, setQuickAccessExpanded] = useState(true);
  const [creatingList, setCreatingList] = useState(false);
  const [createListName, setCreateListName] = useState("");
  const [createListPending, setCreateListPending] = useState(false);
  const createListPendingRef = useRef(false);
  const skipCreateListBlurRef = useRef(false);
  const startCreatingList = () => {
    skipCreateListBlurRef.current = false;
    setCreateListName(`${t("tasks.lists").replace(/s$/i, "")} ${(props.lists?.length ?? 0) + 1}`);
    setCreatingList(true);
  };
  useEffect(() => {
    if (!props.createListRequested) return;
    startCreatingList();
    props.onCreateListRequestHandled?.();
  }, [props.createListRequested]);
  const cancelCreatingList = () => {
    if (createListPendingRef.current) return;
    setCreateListName("");
    setCreatingList(false);
  };
  const submitCreateList = async (name = createListName) => {
    const trimmed = name.trim();
    if (!trimmed) {
      cancelCreatingList();
      return;
    }
    if (!props.onCreateList || createListPendingRef.current) return;
    createListPendingRef.current = true;
    setCreateListPending(true);
    const created = await props.onCreateList(trimmed);
    createListPendingRef.current = false;
    setCreateListPending(false);
    if (created) {
      setCreateListName("");
      setCreatingList(false);
      return;
    }
  };
  const navigationButton = ([section, key, Icon]: [TaskSection, string, LucideIcon]) => (
    <button
      key={section}
      data-testid={`tasks-sidebar-section-${section}`}
      type="button"
      onClick={() => props.onSectionChange?.(section)}
      aria-current={!props.selectedListId && props.section === section ? "page" : undefined}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] font-normal transition-colors",
        !props.selectedListId && props.section === section ? "bg-blue-3 font-medium text-blue-11 dark:bg-blue-4/45 dark:text-blue-10" : "text-dls-text/80 hover:bg-dls-hover hover:text-dls-text",
      )}
    >
      <Icon aria-hidden="true" className="size-[17px] shrink-0" strokeWidth={1.75} />
      {t(key)}
      {section === "activity" && (props.activityUnreadCount ?? 0) > 0 ? <span data-testid="task-activity-sidebar-badge" className="ml-auto flex min-w-5 items-center justify-center rounded-full bg-blue-9 px-1.5 py-0.5 text-[11px] font-medium text-white">{props.activityUnreadCount! > 99 ? "99+" : props.activityUnreadCount}</span> : null}
    </button>
  );

  return (
    <aside
      aria-label={t("tasks.navigation")}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-[var(--app-secondary-sidebar-bg)] text-[15px]",
        props.preview ? "rounded-[18px] border border-dls-border" : "border-r border-dls-border",
      )}
      data-testid={props.preview ? "tasks-sidebar-preview" : "tasks-sidebar"}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-5 pt-4 mac:titlebar-no-drag">
        <div className="mb-5 flex h-10 items-center gap-3 px-3">
          <ListTodo aria-hidden="true" className="size-[19px] text-dls-secondary" strokeWidth={1.8} />
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-dls-text">{t("tasks.title")}</h1>
        </div>
        <nav aria-label={t("tasks.navigation")} className="space-y-1.5">
          {primaryNavigation.map(navigationButton)}
        </nav>
        <div className="mx-2 my-4 border-t border-dls-border" />
        <section>
          <button
            type="button"
            aria-expanded={quickAccessExpanded}
            onClick={() => setQuickAccessExpanded((expanded) => !expanded)}
            className="flex h-9 w-full items-center justify-between rounded-lg px-3 text-left text-sm font-medium text-dls-text/75 transition-colors hover:bg-dls-hover hover:text-dls-text"
          >
            <span>{t("tasks.quick_access")}</span>
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", !quickAccessExpanded && "-rotate-90")} strokeWidth={1.8} />
          </button>
          {quickAccessExpanded ? <nav aria-label={t("tasks.quick_access")} className="mt-1.5 space-y-1">{quickAccessNavigation.map(navigationButton)}</nav> : null}
        </section>
        <div className="mx-2 my-4 border-t border-dls-border" />
        <section>
          <div className="flex h-9 items-center justify-between px-3 text-sm font-medium text-dls-text/75">
            <span>{t("tasks.lists")}</span>
            {props.onCreateList ? <button type="button" onClick={startCreatingList} aria-label={t("tasks.create_list")} aria-expanded={creatingList} className="rounded p-1 hover:bg-dls-hover hover:text-dls-text"><Plus className="size-3.5" /></button> : null}
          </div>
          <div className="mt-1.5 space-y-1">
            {creatingList ? <form data-testid="task-sidebar-list-create" className="rounded-lg bg-blue-3/70 px-2 py-1.5 dark:bg-blue-4/35" onSubmit={(event) => { event.preventDefault(); void submitCreateList(); }}><input autoFocus data-testid="task-sidebar-list-create-input" aria-label={t("tasks.list_name")} placeholder={t("tasks.list_name")} value={createListName} disabled={createListPending} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setCreateListName(event.currentTarget.value)} onBlur={(event) => { if (skipCreateListBlurRef.current) { skipCreateListBlurRef.current = false; return; } if (!createListPendingRef.current) void submitCreateList(event.currentTarget.value); }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); skipCreateListBlurRef.current = true; cancelCreatingList(); } }} className="h-8 w-full rounded-md border border-blue-8 bg-dls-surface px-2 text-sm text-dls-text outline-none ring-1 ring-blue-8/20 placeholder:text-dls-secondary/60 focus:ring-2 focus:ring-blue-8/35 disabled:opacity-60" /></form> : null}
            {props.lists?.map((list) => <div key={list.id} className="group flex items-center"><button type="button" data-testid={`tasks-sidebar-list-${list.id}`} aria-current={props.selectedListId === list.id ? "page" : undefined} className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${props.selectedListId === list.id ? "bg-blue-3 font-medium text-blue-11 dark:bg-blue-4/45 dark:text-blue-10" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"}`} onClick={() => props.onSelectList?.(list.id)}><ListTodo aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.7} /><span className="truncate">{list.name}</span></button><button type="button" className="invisible rounded p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text group-hover:visible group-has-[:focus-visible]:visible focus:visible" aria-label={t("tasks.archive_list")} onClick={() => props.onArchiveList?.(list.id, list.version)}><Archive className="size-3.5" /></button></div>)}
          </div>
        </section>
      </div>
    </aside>
  );
}

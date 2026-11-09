/** @jsxImportSource react */
import { useState } from "react";
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
  onSectionChange?: (section: TaskSection) => void;
  lists?: Array<{ id: string; name: string; marker: string; version: number }>;
  selectedListId?: string | null;
  onSelectList?: (id: string) => void;
  onCreateList?: () => void;
  onArchiveList?: (id: string, version: number) => void;
};

export function taskSectionHeading(section: TaskSection) {
  return taskNavigation.find(([candidate]) => candidate === section)?.[1] ?? "tasks.today";
}

export function TasksSidebar(props: TasksSidebarRegistration & { preview?: boolean }) {
  const [quickAccessExpanded, setQuickAccessExpanded] = useState(true);
  const navigationButton = ([section, key, Icon]: [TaskSection, string, LucideIcon]) => (
    <button
      key={section}
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
            {props.onCreateList ? <button type="button" onClick={props.onCreateList} aria-label={t("tasks.create_list")} className="rounded p-1 hover:bg-dls-hover hover:text-dls-text"><Plus className="size-3.5" /></button> : null}
          </div>
          <div className="mt-1.5 space-y-1">{props.lists?.map((list) => <div key={list.id} className="group flex items-center"><button type="button" aria-current={props.selectedListId === list.id ? "page" : undefined} className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${props.selectedListId === list.id ? "bg-blue-3 font-medium text-blue-11 dark:bg-blue-4/45 dark:text-blue-10" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"}`} onClick={() => props.onSelectList?.(list.id)}>{list.marker} {list.name}</button><button type="button" className="invisible rounded p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text group-hover:visible group-has-[:focus-visible]:visible focus:visible" aria-label={t("tasks.archive_list")} onClick={() => props.onArchiveList?.(list.id, list.version)}><Archive className="size-3.5" /></button></div>)}</div>
        </section>
      </div>
    </aside>
  );
}

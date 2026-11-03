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
      aria-current={props.section === section ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors",
        props.section === section ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.8} />
      {t(key)}
    </button>
  );

  return (
    <aside
      aria-label={t("tasks.navigation")}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden bg-[var(--app-secondary-sidebar-bg)]",
        props.preview ? "rounded-[18px] border border-dls-border" : "border-r border-dls-border",
      )}
      data-testid={props.preview ? "tasks-sidebar-preview" : "tasks-sidebar"}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5 mac:titlebar-no-drag">
        <div className="mb-4 flex items-center gap-2 px-2">
          <ListTodo aria-hidden="true" className="size-5 text-dls-accent" strokeWidth={1.8} />
          <h1 className="text-base font-semibold text-dls-text">{t("tasks.title")}</h1>
        </div>
        <nav aria-label={t("tasks.navigation")} className="space-y-1">
          {primaryNavigation.map(navigationButton)}
        </nav>
        <div className="my-3 border-t border-dls-border" />
        <section>
          <button
            type="button"
            aria-expanded={quickAccessExpanded}
            onClick={() => setQuickAccessExpanded((expanded) => !expanded)}
            className="flex h-8 w-full items-center justify-between rounded-lg px-2 text-left text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
          >
            <span>{t("tasks.quick_access")}</span>
            <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform", !quickAccessExpanded && "-rotate-90")} strokeWidth={1.8} />
          </button>
          {quickAccessExpanded ? <nav aria-label={t("tasks.quick_access")} className="mt-1 space-y-1">{quickAccessNavigation.map(navigationButton)}</nav> : null}
        </section>
        <div className="my-4 border-t border-dls-border" />
        <section>
          <div className="flex items-center justify-between px-2 text-xs font-medium uppercase tracking-wide text-dls-secondary">
            <span>{t("tasks.lists")}</span>
            {props.onCreateList ? <button type="button" onClick={props.onCreateList} aria-label={t("tasks.create_list")} className="rounded p-1 hover:bg-dls-hover hover:text-dls-text"><Plus className="size-3.5" /></button> : null}
          </div>
          <div className="mt-2 space-y-1">{props.lists?.map((list) => <div key={list.id} className="group flex items-center"><button type="button" className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${props.selectedListId === list.id ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:bg-dls-hover"}`} onClick={() => props.onSelectList?.(list.id)}>{list.marker} {list.name}</button><button type="button" className="invisible rounded p-1 text-dls-secondary hover:bg-dls-hover hover:text-dls-text group-hover:visible group-has-[:focus-visible]:visible focus:visible" aria-label={t("tasks.archive_list")} onClick={() => props.onArchiveList?.(list.id, list.version)}><Archive className="size-3.5" /></button></div>)}</div>
        </section>
      </div>
    </aside>
  );
}

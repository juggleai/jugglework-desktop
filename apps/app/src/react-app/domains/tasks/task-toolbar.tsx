import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Filter, Group, ListFilter, Settings2 } from "lucide-react";

import type { DenProductTaskList, DenProductTaskPriority } from "@/app/lib/den";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { taskWorkbenchFields, type TaskWorkbenchField, type TaskWorkbenchGroup, type TaskWorkbenchSettings, type TaskWorkbenchSort, type TaskWorkbenchStatus } from "./task-view-state";

const priorities: DenProductTaskPriority[] = ["none", "low", "medium", "high"];
const sorts: TaskWorkbenchSort[] = ["updated_at", "created_at", "start_at", "due_at", "priority"];
const fields: Array<[TaskWorkbenchField, string]> = [
  ["assignee", "tasks.field_assignee"], ["start", "tasks.field_start"], ["due", "tasks.field_due"],
  ["creator", "tasks.field_creator"], ["created", "tasks.field_created"], ["id", "tasks.field_id"], ["list", "tasks.field_list"],
];

function Menu(props: { label: string; icon: ReactNode; badge?: number; disabled?: boolean; children: ReactNode; testId: string }) {
  return <div data-testid={props.testId} title={props.disabled ? t("tasks.group_board_unavailable") : undefined}>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" disabled={props.disabled} className="h-8 gap-1.5 px-2.5 text-dls-secondary" />}>
        {props.icon}<span>{props.label}</span>{props.badge ? <Badge className="h-4 min-w-4 px-1 text-[10px]">{props.badge}</Badge> : null}<ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 rounded-xl border border-dls-border bg-dls-surface p-2 shadow-xl mac:titlebar-no-drag">
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

export function TaskToolbar(props: { settings: TaskWorkbenchSettings; lists: DenProductTaskList[]; onChange: (next: TaskWorkbenchSettings) => void }) {
  const overdueEnabled = props.settings.status !== "completed";
  const activeFilterCount = props.settings.priorities.length + props.settings.listIds.length + Number(overdueEnabled && props.settings.overdue);
  const update = <K extends keyof TaskWorkbenchSettings>(key: K, value: TaskWorkbenchSettings[K]) => props.onChange({ ...props.settings, [key]: value });
  const toggleArray = <T,>(items: T[], value: T, checked: boolean) => checked ? [...new Set([...items, value])] : items.filter((item) => item !== value);
  const statusLabels: Array<[TaskWorkbenchStatus, string]> = [["incomplete", "tasks.status_incomplete"], ["completed", "tasks.completed"], ["all", "tasks.status_all"]];
  const groupLabels: Array<[TaskWorkbenchGroup, string]> = [["none", "tasks.group_none"], ["list", "tasks.group_list"], ["creator", "tasks.group_creator"]];
  return <div className="flex flex-wrap items-center gap-2" aria-label={t("tasks.quick_settings")}>
    <Menu label={t("tasks.status")} icon={<ListFilter className="size-3.5" />} testId="task-status-menu">
      <DropdownMenuRadioGroup value={props.settings.status} onValueChange={(value) => props.onChange({ ...props.settings, status: value as TaskWorkbenchStatus, overdue: value === "completed" ? false : props.settings.overdue })}>
        {statusLabels.map(([value, label]) => <DropdownMenuRadioItem key={value} value={value} className="rounded-lg px-2 py-1.5 text-sm font-normal">{t(label)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </Menu>
    <Menu label={t("tasks.filter")} icon={<Filter className="size-3.5" />} badge={activeFilterCount} testId="task-filter-menu">
      <DropdownMenuGroup>
        <DropdownMenuLabel className="px-2 pb-1 pt-0 text-xs font-medium text-dls-secondary">{t("tasks.priority")}</DropdownMenuLabel>
        {priorities.map((priority) => <DropdownMenuCheckboxItem key={priority} checked={props.settings.priorities.includes(priority)} onCheckedChange={(checked) => update("priorities", toggleArray(props.settings.priorities, priority, checked))} className="rounded-lg px-2 py-1.5 pe-8 text-sm font-normal">{t(`tasks.priority_${priority}`)}</DropdownMenuCheckboxItem>)}
      </DropdownMenuGroup>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuGroup>
        <DropdownMenuLabel className="px-2 pb-1 pt-0 text-xs font-medium text-dls-secondary">{t("tasks.lists")}</DropdownMenuLabel>
        {props.lists.length ? props.lists.map((list) => <DropdownMenuCheckboxItem key={list.id} checked={props.settings.listIds.includes(list.id)} onCheckedChange={(checked) => update("listIds", toggleArray(props.settings.listIds, list.id, checked))} className="rounded-lg px-2 py-1.5 pe-8 text-sm font-normal">{list.marker} {list.name}</DropdownMenuCheckboxItem>) : <div className="px-2 py-1 text-xs text-dls-secondary">{t("tasks.no_lists")}</div>}
      </DropdownMenuGroup>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuCheckboxItem checked={overdueEnabled && props.settings.overdue} disabled={!overdueEnabled} onCheckedChange={(checked) => update("overdue", checked)} className="rounded-lg px-2 py-1.5 pe-8 text-sm font-normal">{t("tasks.overdue_only")}</DropdownMenuCheckboxItem>
      {activeFilterCount ? <><DropdownMenuSeparator className="my-2" /><DropdownMenuItem onClick={() => props.onChange({ ...props.settings, priorities: [], listIds: [], overdue: false })} className="justify-center rounded-lg py-1.5 text-sm font-normal">{t("tasks.clear_filters")}</DropdownMenuItem></> : null}
    </Menu>
    <Menu label={t("tasks.sort")} icon={<Settings2 className="size-3.5" />} testId="task-sort-menu">
      <DropdownMenuRadioGroup value={props.settings.sort} onValueChange={(value) => update("sort", value as TaskWorkbenchSort)}>
        {sorts.map((sort) => <DropdownMenuRadioItem key={sort} value={sort} className="rounded-lg px-2 py-1.5 text-sm font-normal">{t(`tasks.sort_${sort.replace("_at", "")}`)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator className="my-2" />
      <DropdownMenuItem onClick={() => update("direction", props.settings.direction === "asc" ? "desc" : "asc")} className="rounded-lg px-2 py-1.5 text-sm font-normal">{props.settings.direction === "asc" ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}{props.settings.direction === "asc" ? t("tasks.ascending") : t("tasks.descending")}</DropdownMenuItem>
      {props.settings.sort === "start_at" ? <p className="px-2 pt-2 text-xs text-dls-secondary">{t("tasks.start_sort_loaded")}</p> : null}
    </Menu>
    <Menu label={t("tasks.group")} icon={<Group className="size-3.5" />} disabled={props.settings.view === "board"} testId="task-group-menu">
      <DropdownMenuRadioGroup value={props.settings.group} onValueChange={(value) => update("group", value as TaskWorkbenchGroup)}>
        {groupLabels.map(([value, label]) => <DropdownMenuRadioItem key={value} value={value} className="rounded-lg px-2 py-1.5 text-sm font-normal">{t(label)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </Menu>
    <Menu label={t("tasks.fields")} icon={<Settings2 className="size-3.5" />} testId="task-fields-menu">
      <DropdownMenuCheckboxItem checked disabled className="rounded-lg px-2 py-1.5 pe-8 text-sm font-normal">{t("tasks.field_title")}</DropdownMenuCheckboxItem>
      {fields.map(([field, label]) => <DropdownMenuCheckboxItem key={field} checked={props.settings.fields.includes(field)} onCheckedChange={(checked) => update("fields", toggleArray(props.settings.fields, field, checked))} className="rounded-lg px-2 py-1.5 pe-8 text-sm font-normal">{t(label)}</DropdownMenuCheckboxItem>)}
    </Menu>
  </div>;
}

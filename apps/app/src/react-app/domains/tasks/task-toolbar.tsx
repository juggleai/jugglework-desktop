import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Eye, EyeOff, Filter, GripVertical, Group, ListFilter, SlidersHorizontal } from "lucide-react";

import type { DenOrganizationMember, DenProductTaskList, DenProductTaskPriority } from "@/app/lib/den";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { TaskFilterPanel } from "./task-filter-panel";
import { reorderTaskWorkbenchFields, taskWorkbenchFields, type TaskWorkbenchField, type TaskWorkbenchGroup, type TaskWorkbenchSettings, type TaskWorkbenchSort, type TaskWorkbenchStatus } from "./task-view-state";

const priorities: DenProductTaskPriority[] = ["none", "low", "medium", "high"];
const sorts: TaskWorkbenchSort[] = ["start_at", "due_at", "created_at", "updated_at", "completed_at"];
const fieldLabels: Record<TaskWorkbenchField, string> = {
  assignee: "tasks.field_assignee", start: "tasks.field_start", due: "tasks.field_due", creator: "tasks.field_creator",
  assigner: "tasks.field_assigner", followers: "tasks.field_followers", created: "tasks.field_created", completed: "tasks.field_completed",
  updated: "tasks.field_updated", id: "tasks.field_id", list: "tasks.field_list",
};

function Menu(props: { label: string; icon: ReactNode; badge?: number; disabled?: boolean; children: ReactNode; testId: string; contentClassName?: string; hideChevron?: boolean }) {
  return <div data-testid={props.testId} title={props.disabled ? t("tasks.group_board_unavailable") : undefined}>
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={props.disabled} className={`h-8 gap-1.5 rounded-md px-2 text-[13px] font-normal shadow-none ${props.badge ? "bg-blue-3 text-blue-11 hover:bg-blue-4 dark:bg-blue-4/30 dark:text-blue-10" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"}`} />}>
        {props.icon}<span>{props.label}</span>{props.badge ? <Badge className="h-[18px] min-w-[18px] border-0 bg-blue-4 px-1 text-[10px] text-blue-11 dark:bg-blue-5/35 dark:text-blue-10">{props.badge}</Badge> : null}{props.hideChevron ? null : <ChevronDown className="size-3 opacity-70" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={`min-w-52 rounded-xl border border-dls-border bg-dls-surface p-2 shadow-xl mac:titlebar-no-drag ${props.contentClassName ?? ""}`}>
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

function FieldSettingsMenu(props: { settings: TaskWorkbenchSettings; onChange: (next: TaskWorkbenchSettings) => void }) {
  const [draggedField, setDraggedField] = useState<TaskWorkbenchField | null>(null);
  const orderedFields = props.settings.fieldOrder.length ? props.settings.fieldOrder : taskWorkbenchFields;
  const visibleFields = new Set(props.settings.fields);
  const applyOrder = (nextOrder: TaskWorkbenchField[]) => props.onChange({
    ...props.settings,
    fieldOrder: nextOrder,
    fields: nextOrder.filter((field) => visibleFields.has(field)),
  });
  const move = (source: TaskWorkbenchField, target: TaskWorkbenchField) => applyOrder(reorderTaskWorkbenchFields(orderedFields, source, target));
  const moveByKeyboard = (event: KeyboardEvent<HTMLButtonElement>, field: TaskWorkbenchField) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = orderedFields.indexOf(field);
    const target = orderedFields[index + (event.key === "ArrowUp" ? -1 : 1)];
    if (target) move(field, target);
  };
  const toggle = (field: TaskWorkbenchField) => {
    const nextVisible = new Set(visibleFields);
    if (nextVisible.has(field)) nextVisible.delete(field);
    else nextVisible.add(field);
    props.onChange({ ...props.settings, fields: orderedFields.filter((item) => nextVisible.has(item)) });
  };
  const startDrag = (event: DragEvent<HTMLButtonElement>, field: TaskWorkbenchField) => {
    setDraggedField(field);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", field);
  };
  return <Menu label={t("tasks.fields")} icon={<SlidersHorizontal className="size-3.5" />} testId="task-fields-menu" contentClassName="w-[320px] p-3" hideChevron>
    <div className="px-1 pb-2 pt-0.5 text-base font-semibold text-dls-text">{t("tasks.fields")}</div>
    <div role="list" aria-label={t("tasks.fields")} className="flex max-h-[min(620px,calc(100vh-160px))] flex-col gap-0.5 overflow-y-auto">
      {orderedFields.map((field) => {
        const visible = visibleFields.has(field);
        return <div key={field} role="listitem" data-testid={`task-field-row-${field}`} data-dragging={draggedField === field ? "true" : undefined} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const source = draggedField ?? event.dataTransfer.getData("text/plain") as TaskWorkbenchField; if (taskWorkbenchFields.includes(source)) move(source, field); setDraggedField(null); }} className="group flex h-10 items-center gap-2 rounded-lg px-1 text-sm text-dls-text transition-colors hover:bg-dls-hover data-[dragging=true]:opacity-45">
          <button type="button" draggable aria-label={`${t("tasks.reorder_field")}: ${t(fieldLabels[field])}`} title={t("tasks.reorder_field_hint")} onDragStart={(event) => startDrag(event, field)} onDragEnd={() => setDraggedField(null)} onKeyDown={(event) => moveByKeyboard(event, field)} className="flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-dls-secondary/55 outline-none hover:bg-dls-active hover:text-dls-secondary focus-visible:ring-2 focus-visible:ring-blue-8 active:cursor-grabbing"><GripVertical className="size-4" /></button>
          <span className="min-w-0 flex-1 truncate">{t(fieldLabels[field])}</span>
          <button type="button" data-testid={`task-field-visibility-${field}`} aria-label={`${visible ? t("tasks.hide_field") : t("tasks.show_field")}: ${t(fieldLabels[field])}`} aria-pressed={visible} onClick={() => toggle(field)} className="flex size-8 shrink-0 items-center justify-center rounded-md text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-8">{visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}</button>
        </div>;
      })}
    </div>
  </Menu>;
}

function sortLabel(sort: TaskWorkbenchSort) {
  return t(`tasks.sort_${sort.replace("_at", "")}`);
}

function SortMenu(props: { settings: TaskWorkbenchSettings; onChange: (next: TaskWorkbenchSettings) => void }) {
  const select = (sort: TaskWorkbenchSort, direction: "asc" | "desc" = "desc") => props.onChange({ ...props.settings, sort, direction });
  return <Menu label={`${t("tasks.sort")}: ${sortLabel(props.settings.sort)}`} icon={<ArrowUpDown className="size-3.5" />} testId="task-sort-menu">
    <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={t("tasks.sort")}>
      {sorts.map((sort) => {
        const active = props.settings.sort === sort;
        const label = sortLabel(sort);
        return <div key={sort} data-testid={`task-sort-option-${sort}`} className="group flex min-h-10 items-center rounded-lg px-1.5 transition-colors hover:bg-dls-hover">
          <button type="button" role="radio" aria-checked={active} onClick={() => select(sort)} className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm font-normal outline-none ${active ? "text-blue-10" : "text-dls-text"}`}>
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
          <div className={`ml-1 flex shrink-0 items-center gap-0.5 ${active ? "" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
            <button type="button" data-testid={`task-sort-${sort}-asc`} aria-label={`${label} · ${t("tasks.ascending")}`} aria-pressed={active && props.settings.direction === "asc"} onClick={() => select(sort, "asc")} className={`flex size-8 items-center justify-center rounded-md transition-all hover:bg-dls-active ${active && props.settings.direction === "asc" ? "text-blue-10" : active ? "pointer-events-none w-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-8 group-hover:opacity-100 text-dls-secondary" : "text-dls-secondary"}`}><ArrowUp className="size-4 shrink-0" /></button>
            <button type="button" data-testid={`task-sort-${sort}-desc`} aria-label={`${label} · ${t("tasks.descending")}`} aria-pressed={active && props.settings.direction === "desc"} onClick={() => select(sort, "desc")} className={`flex size-8 items-center justify-center rounded-md transition-all hover:bg-dls-active ${active && props.settings.direction === "desc" ? "text-blue-10" : active ? "pointer-events-none w-0 overflow-hidden opacity-0 group-hover:pointer-events-auto group-hover:w-8 group-hover:opacity-100 text-dls-secondary" : "text-dls-secondary"}`}><ArrowDown className="size-4 shrink-0" /></button>
          </div>
        </div>;
      })}
    </div>
    {props.settings.sort === "start_at" || props.settings.sort === "completed_at" ? <p className="px-2 pt-2 text-xs text-dls-secondary">{t("tasks.time_sort_loaded")}</p> : null}
  </Menu>;
}

export function TaskToolbar(props: { settings: TaskWorkbenchSettings; lists: DenProductTaskList[]; members: DenOrganizationMember[]; onChange: (next: TaskWorkbenchSettings) => void }) {
  const overdueEnabled = props.settings.status !== "completed";
  const update = <K extends keyof TaskWorkbenchSettings>(key: K, value: TaskWorkbenchSettings[K]) => props.onChange({ ...props.settings, [key]: value });
  const statusLabels: Array<[TaskWorkbenchStatus, string]> = [["incomplete", "tasks.status_incomplete"], ["completed", "tasks.completed"], ["all", "tasks.status_all"]];
  const groupLabels: Array<[TaskWorkbenchGroup, string]> = [["none", "tasks.group_none"], ["list", "tasks.group_list"], ["creator", "tasks.group_creator"], ["start", "tasks.group_start"], ["due", "tasks.group_due"]];
  return <div className="flex flex-wrap items-center gap-0.5" aria-label={t("tasks.quick_settings")}>
    <Menu label={t(statusLabels.find(([value]) => value === props.settings.status)?.[1] ?? "tasks.status")} icon={<ListFilter className="size-3.5" />} testId="task-status-menu">
      <DropdownMenuRadioGroup value={props.settings.status} onValueChange={(value) => props.onChange({ ...props.settings, status: value as TaskWorkbenchStatus, overdue: value === "completed" ? false : props.settings.overdue })}>
        {statusLabels.map(([value, label]) => <DropdownMenuRadioItem key={value} value={value} className="rounded-lg px-2 py-1.5 text-sm font-normal">{t(label)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </Menu>
    <TaskFilterPanel settings={{ ...props.settings, overdue: overdueEnabled && props.settings.overdue }} lists={props.lists} members={props.members} onChange={props.onChange} />
    <SortMenu settings={props.settings} onChange={props.onChange} />
    <Menu label={`${t("tasks.group")}: ${t(groupLabels.find(([value]) => value === props.settings.group)?.[1] ?? "tasks.group_none")}`} icon={<Group className="size-3.5" />} disabled={props.settings.view === "board"} testId="task-group-menu">
      <DropdownMenuRadioGroup value={props.settings.group} onValueChange={(value) => update("group", value as TaskWorkbenchGroup)}>
        {groupLabels.map(([value, label]) => <DropdownMenuRadioItem key={value} value={value} className="rounded-lg px-2 py-1.5 text-sm font-normal">{t(label)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </Menu>
    <FieldSettingsMenu settings={props.settings} onChange={props.onChange} />
  </div>;
}

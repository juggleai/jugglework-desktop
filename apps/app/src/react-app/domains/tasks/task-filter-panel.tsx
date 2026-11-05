import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Filter, Plus, X } from "lucide-react";

import type { DenOrganizationMember, DenProductTaskList } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import type { TaskPersonFilterOperator, TaskWorkbenchSettings } from "./task-view-state";

type FilterField = "assignee" | "start" | "due" | "completed" | "assigner" | "follower" | "creator" | "created" | "updated";
type PersonFilterField = "assignee" | "assigner" | "follower" | "creator";
const filterFields: FilterField[] = ["assignee", "start", "due", "completed", "assigner", "follower", "creator", "created", "updated"];
const personOperators: TaskPersonFilterOperator[] = ["contains", "not_contains", "empty", "not_empty"];
const isPersonField = (field: FilterField): field is PersonFilterField => field === "assignee" || field === "assigner" || field === "follower" || field === "creator";

function memberName(member: DenOrganizationMember) {
  return member.user.name?.trim() || member.user.account?.trim() || member.user.email?.trim() || member.id;
}

function MemberToken({ member }: { member: DenOrganizationMember }) {
  const name = memberName(member);
  return <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-dls-hover px-1.5 py-0.5"><Avatar size="sm"><AvatarImage src={member.user.avatar ?? undefined} /><AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="max-w-28 truncate">{name}</span></span>;
}

function MultiValuePicker<T extends { id: string }>(props: { testId: string; values: string[]; options: T[]; placeholder: string; renderOption: (option: T) => ReactNode; renderToken?: (option: T) => ReactNode; onChange: (values: string[]) => void }) {
  const selected = props.options.filter((option) => props.values.includes(option.id));
  const toggle = (id: string) => props.onChange(props.values.includes(id) ? props.values.filter((value) => value !== id) : [...props.values, id]);
  return <Popover>
    <PopoverTrigger render={<button type="button" className="flex min-h-9 w-full min-w-0 items-center gap-1.5 rounded-lg border border-dls-border bg-dls-surface px-2 py-1 text-left text-sm outline-none hover:bg-dls-hover focus-visible:ring-2 focus-visible:ring-blue-8" />}>
      <span className="flex min-w-0 flex-1 flex-wrap gap-1">{selected.length ? selected.map((option) => <span key={option.id}>{props.renderToken?.(option) ?? props.renderOption(option)}</span>) : <span className="text-dls-secondary">{props.placeholder}</span>}</span><ChevronDown className="size-4 shrink-0 text-dls-secondary" />
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={4} className="w-[var(--anchor-width)] min-w-56 gap-1 rounded-xl border border-dls-border bg-dls-surface p-1.5 shadow-xl">
      {props.options.length ? props.options.map((option) => {
        const active = props.values.includes(option.id);
        return <button key={option.id} type="button" role="checkbox" data-testid={`${props.testId}-${option.id}`} aria-checked={active} onClick={() => toggle(option.id)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-dls-hover"><span className={`flex size-4 shrink-0 items-center justify-center rounded border ${active ? "border-blue-9 bg-blue-9 text-white" : "border-dls-border"}`}>{active ? <Check className="size-3" /> : null}</span><span className="min-w-0 flex-1">{props.renderOption(option)}</span></button>;
      }) : <span className="px-2 py-2 text-sm text-dls-secondary">{props.placeholder}</span>}
    </PopoverContent>
  </Popover>;
}

export function TaskFilterPanel(props: { settings: TaskWorkbenchSettings; lists: DenProductTaskList[]; members: DenOrganizationMember[]; onChange: (next: TaskWorkbenchSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [conditions, setConditions] = useState<FilterField[]>(() => {
    const initial: FilterField[] = [];
    if (props.settings.assigneeMemberIds.length || props.settings.assigneeMemberOperator === "empty" || props.settings.assigneeMemberOperator === "not_empty") initial.push("assignee");
    if (props.settings.assignerMemberIds.length || props.settings.assignerMemberOperator === "empty" || props.settings.assignerMemberOperator === "not_empty") initial.push("assigner");
    if (props.settings.followerMemberIds.length || props.settings.followerMemberOperator === "empty" || props.settings.followerMemberOperator === "not_empty") initial.push("follower");
    if (props.settings.creatorMemberIds.length || props.settings.creatorMemberOperator === "empty" || props.settings.creatorMemberOperator === "not_empty") initial.push("creator");
    return initial;
  });
  const personActive = (field: PersonFilterField) => {
    const operator = memberOperator(field);
    return operator === "empty" || operator === "not_empty" || memberIds(field).length > 0;
  };
  const activeCount = (["assignee", "assigner", "follower", "creator"] as PersonFilterField[]).filter(personActive).length;
  const clearField = (field: FilterField) => {
    if (!isPersonField(field)) return;
    const idsKey = field === "assignee" ? "assigneeMemberIds" : field === "assigner" ? "assignerMemberIds" : field === "creator" ? "creatorMemberIds" : "followerMemberIds";
    const operatorKey = field === "assignee" ? "assigneeMemberOperator" : field === "assigner" ? "assignerMemberOperator" : field === "creator" ? "creatorMemberOperator" : "followerMemberOperator";
    props.onChange({ ...props.settings, [idsKey]: [], [operatorKey]: "contains" });
  };
  const remove = (field: FilterField) => { clearField(field); setConditions((current) => current.filter((item) => item !== field)); };
  const add = () => { const next = filterFields.find((field) => !conditions.includes(field)); if (next) setConditions((current) => [...current, next]); };
  const rename = (index: number, field: FilterField) => {
    const previous = conditions[index]!;
    if (previous === field) return;
    clearField(previous);
    setConditions((current) => current.map((item, itemIndex) => itemIndex === index ? field : item));
  };
  const clear = () => { props.onChange({ ...props.settings, assigneeMemberIds: [], assigneeMemberOperator: "contains", assignerMemberIds: [], assignerMemberOperator: "contains", creatorMemberIds: [], creatorMemberOperator: "contains", followerMemberIds: [], followerMemberOperator: "contains" }); setConditions([]); };
  function memberIds(field: PersonFilterField) { return field === "assignee" ? props.settings.assigneeMemberIds : field === "assigner" ? props.settings.assignerMemberIds : field === "creator" ? props.settings.creatorMemberIds : props.settings.followerMemberIds; }
  function memberOperator(field: PersonFilterField) { return field === "assignee" ? props.settings.assigneeMemberOperator : field === "assigner" ? props.settings.assignerMemberOperator : field === "creator" ? props.settings.creatorMemberOperator : props.settings.followerMemberOperator; }
  const updateMembers = (field: PersonFilterField, values: string[]) => props.onChange({ ...props.settings, [field === "assignee" ? "assigneeMemberIds" : field === "assigner" ? "assignerMemberIds" : field === "creator" ? "creatorMemberIds" : "followerMemberIds"]: values });
  const updateOperator = (field: PersonFilterField, operator: TaskPersonFilterOperator) => props.onChange({
    ...props.settings,
    [field === "assignee" ? "assigneeMemberOperator" : field === "assigner" ? "assignerMemberOperator" : field === "creator" ? "creatorMemberOperator" : "followerMemberOperator"]: operator,
    ...(operator === "empty" || operator === "not_empty" ? { [field === "assignee" ? "assigneeMemberIds" : field === "assigner" ? "assignerMemberIds" : field === "creator" ? "creatorMemberIds" : "followerMemberIds"]: [] } : {}),
  });
  const memberOptions = props.members.map((member) => ({ id: member.id, member }));
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" data-testid="task-filter-menu" className={`h-8 gap-1.5 rounded-md px-2 text-[13px] font-normal shadow-none ${activeCount ? "bg-blue-3 text-blue-11 hover:bg-blue-4" : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"}`} />}><Filter className="size-3.5" /><span>{t("tasks.filter")}</span>{activeCount ? <Badge className="h-[18px] min-w-[18px] border-0 bg-blue-4 px-1 text-[10px] text-blue-11">{activeCount}</Badge> : null}</PopoverTrigger>
    <PopoverContent align="start" sideOffset={8} data-testid="task-filter-panel" className="w-[min(900px,calc(100vw-80px))] gap-4 rounded-xl border border-dls-border bg-dls-surface p-5 shadow-xl">
      <div className="flex items-center justify-between"><strong className="text-base">{t("tasks.filter")}</strong><Button type="button" variant="ghost" size="sm" onClick={clear}>{t("tasks.clear_filters")}</Button></div>
      <div className="space-y-2">{conditions.map((field, index) => {
        return <div key={`${field}:${index}`} data-testid={`task-filter-condition-${field}`} className="grid grid-cols-[52px_180px_130px_minmax(220px,1fr)_40px] items-center gap-2">
          <span className="text-center text-dls-secondary">{index === 0 ? t("tasks.filter_when") : t("tasks.filter_and")}</span>
          <Select value={field} onValueChange={(value) => rename(index, value as FilterField)}><SelectTrigger data-testid={`task-filter-field-${index}`} data-filter-options={filterFields.filter((item) => item === field || !conditions.includes(item)).join(",")} className="w-full rounded-lg"><SelectValue>{t(`tasks.filter_field_${field}`)}</SelectValue></SelectTrigger><SelectContent align="start">{filterFields.filter((item) => item === field || !conditions.includes(item)).map((item) => <SelectItem key={item} value={item}>{t(`tasks.filter_field_${item}`)}</SelectItem>)}</SelectContent></Select>
          {isPersonField(field) ? <Select value={memberOperator(field)} onValueChange={(value) => updateOperator(field, value as TaskPersonFilterOperator)}><SelectTrigger data-testid={`task-filter-operator-${field}`} className="w-full rounded-lg"><SelectValue>{t(`tasks.filter_operator_${memberOperator(field)}`)}</SelectValue></SelectTrigger><SelectContent>{personOperators.map((operator) => <SelectItem key={operator} value={operator}>{t(`tasks.filter_operator_${operator}`)}</SelectItem>)}</SelectContent></Select> : <div className="flex h-9 items-center rounded-lg border border-dls-border px-3 text-sm text-dls-secondary">{t("tasks.filter_time_pending")}</div>}
          {isPersonField(field) && (memberOperator(field) === "contains" || memberOperator(field) === "not_contains") ? <MultiValuePicker testId={`task-filter-member-${field}`} values={memberIds(field)} options={memberOptions} placeholder={t("tasks.filter_select_member")} onChange={(values) => updateMembers(field, values)} renderOption={({ member }) => <MemberToken member={member} />} /> : isPersonField(field) ? <div data-testid={`task-filter-no-value-${field}`} className="h-9" /> : <div className="flex h-9 items-center rounded-lg border border-dls-border px-3 text-sm text-dls-secondary">{t("tasks.filter_time_pending")}</div>}
          <Button type="button" variant="ghost" size="icon-sm" aria-label={t("tasks.remove_filter")} onClick={() => remove(field)}><X className="size-4" /></Button>
        </div>;
      })}</div>
      <Button type="button" data-testid="task-filter-add" variant="outline" className="w-fit" disabled={conditions.length >= filterFields.length} onClick={add}><Plus className="size-4" />{t("tasks.add_filter")}</Button>
    </PopoverContent>
  </Popover>;
}

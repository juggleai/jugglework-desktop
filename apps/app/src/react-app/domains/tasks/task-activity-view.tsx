/** @jsxImportSource react */
import * as React from "react";
import { AtSign, Bell, CalendarClock, Check, CheckCircle2, CircleAlert, Eye, ListTodo, LoaderCircle, MessageSquare, RotateCcw, UserRoundPlus, XCircle } from "lucide-react";

import type { DenProductTaskActivityItem } from "@/app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type ActivityGroup = { key: string; label: string; items: DenProductTaskActivityItem[] };

function localDayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function groupTaskActivity(items: DenProductTaskActivityItem[], now = new Date()): ActivityGroup[] {
  const today = localDayStart(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const week = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  const result = new Map<string, ActivityGroup>();
  for (const item of [...items].sort((left, right) => right.event.sequence - left.event.sequence)) {
    const occurred = new Date(item.event.occurredAt);
    const day = Number.isFinite(occurred.getTime()) ? localDayStart(occurred) : today;
    const group = day >= today
      ? { key: "today", label: t("tasks.activity_today") }
      : day >= yesterday
        ? { key: "yesterday", label: t("tasks.activity_yesterday") }
        : day >= week
          ? { key: "week", label: t("tasks.activity_this_week") }
          : { key: localDayKey(day), label: new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(day) };
    const existing = result.get(group.key) ?? { ...group, items: [] };
    existing.items.push(item);
    result.set(group.key, existing);
  }
  return [...result.values()];
}

function payloadString(item: DenProductTaskActivityItem, key: string) {
  const value = item.event.payload[key];
  return typeof value === "string" ? value : null;
}

function activityPresentation(item: DenProductTaskActivityItem) {
  const actor = item.actor?.name || t("tasks.activity_system_actor");
  const type = item.event.eventType;
  if (type === "task.assignee_added") return { Icon: UserRoundPlus, title: t("tasks.activity_assignee_added", { actor }), detail: null };
  if (type === "task.follower_added") return { Icon: Eye, title: t("tasks.activity_follower_added", { actor }), detail: null };
  if (type === "task.due_changed") return { Icon: CalendarClock, title: t("tasks.activity_due_changed", { actor }), detail: [payloadString(item, "before"), payloadString(item, "after")].filter(Boolean).join(" → ") || null };
  if (type === "task.completed") return { Icon: CheckCircle2, title: t("tasks.activity_completed", { actor }), detail: null };
  if (type === "task.reopened") return { Icon: RotateCcw, title: t("tasks.activity_reopened", { actor }), detail: null };
  if (type === "task.canceled") return { Icon: XCircle, title: t("tasks.activity_canceled", { actor }), detail: null };
  if (type === "comment.mentioned") return { Icon: AtSign, title: t("tasks.activity_mentioned", { actor }), detail: payloadString(item, "excerpt") };
  if (type === "comment.created") return { Icon: MessageSquare, title: t("tasks.activity_commented", { actor }), detail: payloadString(item, "excerpt") };
  if (type === "reminder.due_soon") return { Icon: Bell, title: t("tasks.activity_due_soon"), detail: null };
  if (type === "reminder.overdue") return { Icon: CircleAlert, title: t("tasks.activity_overdue"), detail: null };
  if (type === "task.list_moved") return { Icon: ListTodo, title: t("tasks.activity_list_moved", { actor }), detail: null };
  return { Icon: Check, title: t("tasks.activity_updated", { actor }), detail: null };
}

function ActivityRow(props: { item: DenProductTaskActivityItem; pending: boolean; onOpen: (item: DenProductTaskActivityItem) => void; onRead: (item: DenProductTaskActivityItem) => void; onOpenList?: (listId: string) => void }) {
  const { Icon, title, detail } = activityPresentation(props.item);
  const unread = props.item.readAt === null && props.item.attentionLevel !== "ambient";
  const occurred = new Date(props.item.event.occurredAt);
  const time = Number.isFinite(occurred.getTime()) ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(occurred) : "";
  return <article data-testid={`task-activity-row-${props.item.event.id}`} className={`group relative flex gap-3 border-b border-dls-border px-4 py-4 last:border-b-0 ${unread ? "bg-blue-2/45" : "bg-dls-surface"}`}>
    <span className="relative mt-0.5 shrink-0"><Avatar><AvatarImage src={props.item.actor?.avatar ?? undefined} /><AvatarFallback>{props.item.actor?.name.slice(0, 1).toUpperCase() || <Icon className="size-4" />}</AvatarFallback></Avatar>{unread ? <span className="absolute -left-1 top-1 size-2 rounded-full bg-blue-9 ring-2 ring-dls-surface" aria-label={t("tasks.activity_unread")} /> : null}</span>
    <div className="min-w-0 flex-1"><div className="flex items-start gap-3"><button type="button" data-testid={`task-activity-open-${props.item.event.id}`} disabled={!props.item.task.accessible} onClick={() => props.onOpen(props.item)} className="min-w-0 flex-1 text-left disabled:cursor-default"><p className="text-sm text-dls-text">{title}</p><p className="mt-1 truncate text-sm font-medium text-dls-text">{props.item.task.accessible ? props.item.task.title || t("tasks.activity_unavailable_task") : t("tasks.activity_unavailable_task")}</p>{detail && props.item.task.accessible ? <p className="mt-1 line-clamp-2 text-xs text-dls-secondary">{detail}</p> : null}</button><time className="shrink-0 text-xs text-dls-secondary">{time}</time></div>
      <div className="mt-2 flex items-center justify-between gap-3">{props.item.list && props.item.task.accessible ? <button type="button" data-testid={`task-activity-list-${props.item.event.id}`} onClick={() => props.onOpenList?.(props.item.list!.id)} className="max-w-64 truncate text-xs text-dls-secondary hover:text-blue-10">{props.item.list.marker} {props.item.list.name}</button> : <span />}{unread ? <button type="button" data-testid={`task-activity-read-${props.item.event.id}`} disabled={props.pending} onClick={() => props.onRead(props.item)} className="text-xs text-blue-10 hover:underline disabled:opacity-50">{t("tasks.activity_mark_read")}</button> : null}</div>
    </div>
  </article>;
}

export function TaskActivityView(props: {
  items: DenProductTaskActivityItem[];
  unreadOnly: boolean;
  unreadCount: number;
  latestSequence: number;
  loading: boolean;
  error: string | null;
  refreshing: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  markingRead: boolean;
  onUnreadOnlyChange: (value: boolean) => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpen: (item: DenProductTaskActivityItem) => void;
  onRead: (item: DenProductTaskActivityItem) => void;
  onReadAll: (throughSequence: number) => void;
  onOpenList?: (listId: string) => void;
}) {
  const groups = groupTaskActivity(props.items);
  if (props.loading) return <div className="flex flex-col items-center gap-3 text-dls-secondary" role="status"><LoaderCircle className="size-6 animate-spin" /><span className="text-sm">{t("tasks.activity_loading")}</span></div>;
  if (props.error) return <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert"><CircleAlert className="size-8 text-red-9" /><div><h3 className="font-medium">{t("tasks.activity_error_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{props.error}</p></div><Button variant="outline" size="sm" onClick={props.onRetry}>{t("tasks.retry")}</Button></div>;
  return <div data-testid="task-activity-view" className="mx-auto w-full max-w-4xl self-start pb-8">
    <header className="sticky top-0 z-10 -mx-1 mb-5 flex items-center justify-between gap-4 bg-background/95 px-1 pb-3 backdrop-blur"><div className="flex rounded-lg bg-dls-hover p-1"><button type="button" data-testid="task-activity-filter-all" data-state={!props.unreadOnly ? "active" : undefined} onClick={() => props.onUnreadOnlyChange(false)} className="h-8 rounded-md px-3 text-sm data-[state=active]:bg-dls-surface data-[state=active]:text-blue-10 data-[state=active]:shadow-sm">{t("tasks.activity_all")}</button><button type="button" data-testid="task-activity-filter-unread" data-state={props.unreadOnly ? "active" : undefined} onClick={() => props.onUnreadOnlyChange(true)} className="h-8 rounded-md px-3 text-sm data-[state=active]:bg-dls-surface data-[state=active]:text-blue-10 data-[state=active]:shadow-sm">{t("tasks.activity_unread_tab", { count: props.unreadCount })}</button></div><div className="flex items-center gap-3">{props.refreshing ? <LoaderCircle className="size-4 animate-spin text-dls-secondary" /> : null}{props.unreadCount > 0 ? <Button data-testid="task-activity-read-all" variant="ghost" size="sm" disabled={props.markingRead || props.latestSequence < 1} onClick={() => props.onReadAll(props.latestSequence)}>{t("tasks.activity_mark_all_read")}</Button> : null}</div></header>
    {!groups.length ? <div data-testid="task-activity-empty" className="flex flex-col items-center gap-3 py-20 text-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-dls-active text-dls-accent"><CheckCircle2 className="size-6" /></div><div><h3 className="font-medium">{props.unreadOnly ? t("tasks.activity_no_unread_title") : t("tasks.activity_empty_title")}</h3><p className="mt-1 text-sm text-dls-secondary">{props.unreadOnly ? t("tasks.activity_no_unread_description") : t("tasks.activity_empty_description")}</p></div></div> : <div className="space-y-6">{groups.map((group) => <section key={group.key} data-testid={`task-activity-group-${group.key}`}><h3 className="mb-2 px-1 text-sm font-semibold text-dls-text">{group.label}</h3><div className="overflow-hidden rounded-xl border border-dls-border shadow-sm">{group.items.map((item) => <ActivityRow key={item.event.id} item={item} pending={props.markingRead} onOpen={props.onOpen} onRead={props.onRead} onOpenList={props.onOpenList} />)}</div></section>)}</div>}
    {props.canLoadMore ? <div className="mt-6 flex justify-center"><Button variant="outline" disabled={props.loadingMore} onClick={props.onLoadMore}>{props.loadingMore ? t("tasks.loading") : t("tasks.load_more")}</Button></div> : null}
  </div>;
}

/** @jsxImportSource react */
import * as React from "react";
import { CloudOff, FileClock } from "lucide-react";

import type { DenCalendarEvent } from "@/app/lib/den";
import { t } from "@/i18n";
import type { CalendarDraftRecord } from "./calendar-cache";
import { draftForm, type CalendarOfflineView } from "./calendar-offline-runtime";

function formatRefreshedAt(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function CalendarOfflineBanner(props: { view: CalendarOfflineView; locale: string }) {
  const { view } = props;
  if (view.state === "online") return null;
  const refreshed = view.state === "loading" ? null : formatRefreshedAt(view.refreshedAt, props.locale);
  const covered = view.state === "offline-covered";
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-dls-text"
      role="status"
      aria-live="polite"
      data-testid="calendar-offline-banner"
      data-offline-state={view.state}
    >
      <CloudOff className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">
          {view.state === "loading" ? t("calendar.offline_loading") : covered ? t("calendar.offline_covered") : t("calendar.offline_uncovered")}
        </p>
        {refreshed ? <p className="text-xs text-dls-secondary" data-testid="calendar-offline-refreshed">{t("calendar.offline_refreshed_at", { time: refreshed })}</p> : null}
      </div>
    </div>
  );
}

export function CalendarDraftList(props: {
  drafts: readonly CalendarDraftRecord[];
  eventsById: ReadonlyMap<string, DenCalendarEvent>;
  activeDraftId?: string;
  onRestore: (draftId: string) => void;
  onDiscard: (draftId: string) => void;
}) {
  return (
    <section aria-labelledby="calendar-drafts-heading" className="flex flex-col gap-1.5 rounded-xl border border-dashed border-dls-border p-2" data-testid="calendar-drafts">
      <h3 id="calendar-drafts-heading" className="flex items-center gap-1.5 text-xs font-semibold text-dls-secondary">
        <FileClock className="size-3.5" aria-hidden="true" />
        {t("calendar.drafts_title")}
      </h3>
      <ul className="flex flex-col gap-1">
        {props.drafts.map((draft) => {
          const form = draftForm(draft);
          const title = form?.title.trim() ? form.title : t("calendar.draft_untitled");
          return (
            <li key={draft.id} className="flex min-w-0 items-center gap-2" data-testid={`calendar-draft-${draft.id}`}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-left text-sm text-dls-text hover:bg-dls-hover aria-[current=true]:bg-dls-active"
                aria-current={draft.id === props.activeDraftId ? "true" : undefined}
                onClick={() => props.onRestore(draft.id)}
                data-testid={`calendar-draft-restore-${draft.id}`}
              >
                {title}
              </button>
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700" data-testid={`calendar-draft-badge-${draft.id}`}>
                {t("calendar.draft_unsynced")}
              </span>
              <button
                type="button"
                className="shrink-0 text-xs text-dls-secondary underline"
                onClick={() => props.onDiscard(draft.id)}
                data-testid={`calendar-draft-discard-${draft.id}`}
              >
                {t("calendar.draft_discard")}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

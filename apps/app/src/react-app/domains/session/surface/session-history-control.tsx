import { LoaderCircle } from "lucide-react";

import { t } from "@/i18n";

type SessionHistoryControlProps = {
  hasOlder: boolean;
  isLoading: boolean;
  error: Error | null;
  showHistoryStart: boolean;
  onLoadOlder: () => void;
};

export function SessionHistoryControl(props: SessionHistoryControlProps) {
  if (props.hasOlder || props.isLoading || props.error) {
    const label = props.isLoading
      ? t("session.history_loading_earlier")
      : props.error
        ? t("session.history_retry_earlier")
        : t("session.history_load_earlier");
    return (
      <div className="flex justify-center px-3 pb-2" role={props.error ? "alert" : undefined} aria-live="polite">
        <button
          type="button"
          aria-disabled={props.isLoading}
          aria-busy={props.isLoading}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 ${props.isLoading ? "cursor-default" : ""} ${props.error ? "text-red-11 hover:bg-red-3/60" : `text-dls-secondary ${props.isLoading ? "" : "hover:bg-dls-hover hover:text-dls-text"}`}`}
          onClick={() => {
            if (!props.isLoading) props.onLoadOlder();
          }}
        >
          {props.isLoading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : null}
          {label}
        </button>
      </div>
    );
  }

  if (!props.showHistoryStart) return null;

  return (
    <div className="px-3 pb-2 text-center text-xs text-dls-secondary" role="status">
      {t("session.history_start")}
    </div>
  );
}

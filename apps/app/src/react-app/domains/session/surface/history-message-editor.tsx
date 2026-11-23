import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";

export function HistoryMessageEditor(props: {
  initialText: string;
  disabled?: boolean;
  onClose: () => void;
  onConfirm: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(props.initialText);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);

  async function confirm() {
    if (props.disabled || !text.trim() || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    try {
      if (await props.onConfirm(text)) props.onClose();
    } catch (error) {
      if (error instanceof Error) toast.error(error.message);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full rounded-[20px] bg-[var(--app-msg-sent-bg)] p-3 text-foreground">
      <textarea
        autoFocus
        rows={1}
        aria-label={t("session.edit_message_label")}
        className="block field-sizing-content max-h-[50vh] min-h-5 w-full resize-none overflow-y-auto bg-transparent p-0 text-[15px] leading-5 outline-none"
        value={text}
        disabled={submitting}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || pending.current) return;
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void confirm(); }
        }}
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button variant="outline" size="xs" className="h-7 rounded-[10px] bg-background px-2 text-[13px] dark:bg-background"
          disabled={submitting} onClick={props.onClose}>{t("common.cancel")}</Button>
        <Button size="xs" className="h-7 rounded-[10px] px-2 text-[13px]" title={t("session.edit_history_description")}
          disabled={props.disabled || submitting || !text.trim()} onClick={confirm}>{t("session.send_edited_message")}</Button>
      </div>
    </div>
  );
}

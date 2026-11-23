import { useRef, useState } from "react";

import type { DenProductTaskPriority } from "@/app/lib/den";
import { t } from "@/i18n";

const priorities = ["low", "medium", "high"] as const;
export type EditableTaskPriority = (typeof priorities)[number];

export function TaskPrioritySelect(props: {
  testId: string;
  value: DenProductTaskPriority;
  onChange: (value: EditableTaskPriority) => void | Promise<unknown>;
  disabled?: boolean;
}) {
  const saving = useRef(false);
  const [pending, setPending] = useState(false);
  const select = async (value: string) => {
    if (saving.current || props.disabled || value === props.value || (value !== "low" && value !== "medium" && value !== "high")) return;
    saving.current = true;
    setPending(true);
    try {
      await props.onChange(value);
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  return <select data-testid={props.testId} aria-label={t("tasks.field_priority")} value={props.value} disabled={pending || props.disabled} onChange={(event) => void select(event.currentTarget.value)} className="h-8 max-w-full rounded-md border border-dls-border bg-dls-surface px-2 text-sm text-dls-text disabled:cursor-default disabled:opacity-60">
    {props.value === "none" ? <option value="none" disabled hidden>{t("tasks.priority_none")}</option> : null}
    {priorities.map((value) => <option key={value} value={value}>{t(`tasks.priority_choice_${value}`)}</option>)}
  </select>;
}

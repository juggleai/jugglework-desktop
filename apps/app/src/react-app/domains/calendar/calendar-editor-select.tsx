/** @jsxImportSource react */
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { calendarEditorControl } from "./calendar-editor-date-picker";

/** Calendar-local select: 32px rows and a content-width, borderless trigger. */
export function CalendarEditorSelect(props: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  label: string;
  testId: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const menu = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button type="button" className={cn(calendarEditorControl, "-ml-2 inline-flex max-w-full items-center gap-2")} aria-label={props.label} aria-haspopup="listbox" aria-controls={id} aria-expanded={open} aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy} data-testid={props.testId} />}>
      <span className="truncate">{props.options.find(option => option.value === props.value)?.label}</span><ChevronDown className="size-4 shrink-0 text-dls-secondary" />
    </PopoverTrigger>
    {open ? <PopoverContent ref={menu} id={id} align="start" role="listbox" aria-label={props.label} className="max-h-72 w-max min-w-40 max-w-[min(320px,calc(100vw-2rem))] gap-0 overflow-y-auto rounded-md border border-dls-border bg-dls-surface p-1 text-dls-text shadow-xl" data-testid={`${props.testId}-menu`} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      const options = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const index = options.indexOf(event.target as HTMLButtonElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus(); }
      if (event.key === "Home" || event.key === "End") { event.preventDefault(); options[event.key === "Home" ? 0 : options.length - 1]?.focus(); }
    }}>
      {props.options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === props.value} disabled={option.disabled} className={cn("flex h-8 w-full shrink-0 items-center justify-between gap-6 rounded px-2 text-left text-sm outline-none hover:bg-dls-hover focus-visible:bg-dls-hover disabled:opacity-40", option.value === props.value && "bg-dls-hover font-medium")} data-testid={`${props.testId}-option-${option.value}`} onClick={() => { props.onChange(option.value); setOpen(false); }}>
        <span className="truncate">{option.label}</span>{option.value === props.value ? <Check className="size-4 shrink-0" /> : null}
      </button>)}
    </PopoverContent> : null}
  </Popover>;
}

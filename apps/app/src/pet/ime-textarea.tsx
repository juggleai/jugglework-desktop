import * as React from "react";

/** Let Chromium own marked text; never reconcile a controlled value during IME. */
export function ImeTextarea({ value, onCommit, ...props }: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const field = React.useRef<HTMLTextAreaElement>(null);
  const composing = React.useRef(false);
  React.useLayoutEffect(() => {
    const node = field.current;
    if (node && !composing.current && document.activeElement !== node && node.value !== value) node.value = value;
  }, [value]);
  return <textarea {...props} ref={field} defaultValue={value}
    onChange={(event) => {
      if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) onCommit(event.currentTarget.value);
    }}
    onCompositionStart={(event) => { composing.current = true; props.onCompositionStart?.(event); }}
    onCompositionEnd={(event) => {
      composing.current = false;
      props.onCompositionEnd?.(event);
      onCommit(event.currentTarget.value);
    }}
    onBlur={(event) => {
      // Native compositionend owns the final value; blur may precede it.
      if (!composing.current) onCommit(event.currentTarget.value);
      props.onBlur?.(event);
    }}
  />;
}

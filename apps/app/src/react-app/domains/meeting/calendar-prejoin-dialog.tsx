import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MeetingIcon } from "./meeting-icons";

export function CalendarPrejoinDialog({ title, closeLabel = "取消", className = "", busy, onClose, children }: {
  title: string;
  className?: string;
  closeLabel?: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  // Keep focus and pointer targets inside the launching popup's DOM boundary.
  // showModal puts the dialog in the top layer, even if that popup clips its children.
  useLayoutEffect(() => {
    const origin = anchor.current!;
    const doc = origin.ownerDocument;
    const layer = 'dialog, [role="dialog"], [data-slot="popover-content"], [data-radix-popper-content-wrapper]';
    setHost(doc.activeElement?.closest(layer) ?? origin.closest(layer) ?? doc.body);
  }, []);
  const dismiss = useRef(onClose);
  useLayoutEffect(() => { dismiss.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    if (!host) return;
    const node = dialog.current!;
    const doc = node.ownerDocument;
    const previous = doc.activeElement;
    // Dismissable layers can listen on document capture, before React onKeyDown.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !node.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) dismiss.current();
    };
    doc.defaultView?.addEventListener("keydown", escape, true);
    node.showModal();
    closeButton.current?.focus();
    return () => {
      doc.defaultView?.removeEventListener("keydown", escape, true);
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [host]);

  return <><span hidden ref={anchor} />{host && createPortal(
    <dialog ref={dialog} className="calendar-prejoin-layer" aria-modal="true" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <div className={`meeting-ui calendar-prejoin ${className}`} aria-busy={busy}>
        <header className="calendar-prejoin-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ghost icon-button" ref={closeButton} aria-label={closeLabel} disabled={busy} onClick={onClose}>
            <MeetingIcon name="close" />
          </button>
        </header>
        {children}
      </div>
    </dialog>, host,
  )}</>;
}

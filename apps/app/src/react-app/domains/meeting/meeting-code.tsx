import { useEffect, useRef, useState } from "react";
import { MeetingIcon } from "./meeting-icons";

export async function copyMeetingCode(code: string, ownerDocument: Document) {
  try {
    const clipboard = ownerDocument.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) { await clipboard.writeText(code); return; }
  } catch { /* File-based windows may need the focused-document fallback. */ }
  const previous = ownerDocument.activeElement as HTMLElement | null;
  const field = ownerDocument.createElement("textarea");
  field.value = code;
  field.setAttribute("aria-label", "会议号");
  field.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  ownerDocument.body.appendChild(field);
  try {
    field.focus(); field.select();
    if (!ownerDocument.execCommand("copy")) throw new Error("复制失败，请重试");
  } finally { field.remove(); previous?.focus({ preventScroll: true }); }
}

export function MeetingCode({ code }: { code: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const generation = useRef(0);
  useEffect(() => { generation.current++; setStatus("idle"); return () => { generation.current++; }; }, [code]);
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 2200);
    return () => clearTimeout(timer);
  }, [status]);
  return <span className="meeting-code-control">
    <button type="button" className="meeting-code-button" data-copied={status === "copied"}
      aria-label={status === "copied" ? `已复制会议号 ${code}` : status === "error" ? `复制失败，点击重试 ${code}` : `复制会议号 ${code}`}
      onClick={async event => {
        const run = ++generation.current;
        try { await copyMeetingCode(code, event.currentTarget.ownerDocument); if (run === generation.current) setStatus("copied"); }
        catch { if (run === generation.current) setStatus("error"); }
      }}>
      <span className="meeting-code">{code}</span><MeetingIcon name={status === "copied" ? "check" : "copy"} width={13} height={13} />
    </button>
  </span>;
}

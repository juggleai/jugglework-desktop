/** @jsxImportSource react */
// Portal this host into a stable, same-origin independent window. Hiding the
// meeting window must not unmount it: the iframe owns the live canvas stream.
// Excalidraw gets its own document for pointer and keyboard events.
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { exportMeetingWhiteboard, saveMeetingWhiteboard } from "@/app/lib/desktop";
import type { MeetingWhiteboardSession } from "./store";
import type { WhiteboardBridge } from "./whiteboard/whiteboard-page";

type WhiteboardFrame = HTMLIFrameElement & { __juggleworkWhiteboard?: WhiteboardBridge };

/** Resolved like the ZEGO loader: BASE_URL is "/" on the dev server and "./" in packaged builds. */
export function whiteboardPageUrl(baseURI: string, base: string = import.meta.env.BASE_URL ?? "./") {
  return new URL(`${base}whiteboard.html`, baseURI).href;
}

export function MeetingWhiteboardStage({ session, theme, onPublish, onFail, pageBaseURI }: {
  session: MeetingWhiteboardSession;
  theme: "light" | "dark";
  onPublish(whiteboardId: string, stream: MediaStream): void | Promise<void>;
  onFail(message: string): void;
  /** App entry base URI, not the portal window's about:blank document URI. */
  pageBaseURI?: string;
}) {
  const flush = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onPublish, onFail });
  callbacks.current = { onPublish, onFail };
  const bridge = useMemo<WhiteboardBridge>(() => ({
    context: { whiteboardId: session.whiteboardId, title: session.title, theme, scene: session.scene },
    save: (content) => saveMeetingWhiteboard({ meetingId: session.meetingId, whiteboardId: session.whiteboardId, content }),
    exportFile: (kind, data) => exportMeetingWhiteboard({ title: session.title, kind, data }),
    publish: (stream) => callbacks.current.onPublish(session.whiteboardId, stream),
    fail: (message) => callbacks.current.onFail(message),
    setFlush: (next) => { flush.current = next; },
    // A theme change must not remount the board mid-share.
  }), [session]);
  // Layout cleanup runs before React removes the iframe, so the last edit is saved.
  useLayoutEffect(() => () => { flush.current?.(); flush.current = null; }, [bridge]);
  const attach = useCallback((frame: WhiteboardFrame | null) => {
    if (!frame || frame.__juggleworkWhiteboard === bridge) return;
    // The bridge must exist before the page's scripts run, so src is set here.
    frame.__juggleworkWhiteboard = bridge;
    frame.src = whiteboardPageUrl(pageBaseURI ?? window.document.baseURI);
  }, [bridge, pageBaseURI]);
  // The independent host need not copy meeting.css to size the board correctly.
  return <iframe key={session.whiteboardId} ref={attach} className="meeting-whiteboard-frame" title="会议白板"
    style={{ display: "block", width: "100%", height: "100%", minHeight: 0, border: 0 }} />;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { closeMeetingAnnotation, openMeetingAnnotation, readMeetingAnnotationState } from "@/app/lib/desktop";

const POLL_MS = 1000;

/**
 * Annotation availability for the local share. The main process decides
 * whether the confirmed source is a whole screen; this hook only mirrors that,
 * and closes annotation when the share stops or the meeting UI unmounts.
 */
export function useMeetingAnnotation(screenShare: boolean, onError: (message: string) => void) {
  const [state, setState] = useState({ available: false, active: false });
  const desktop = typeof window !== "undefined" && !!window.__JUGGLEWORK_ELECTRON__?.invokeDesktop;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const wasSharing = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    if (!screenShare) {
      setState({ available: false, active: false });
      if (wasSharing.current) void closeMeetingAnnotation({ shareStopped: true }).catch(() => {});
      wasSharing.current = false;
      return;
    }
    wasSharing.current = true;
    let alive = true;
    // Polling also picks up exits from the toolbar, Esc or an unplugged display.
    const refresh = () => readMeetingAnnotationState().then((next) => {
      if (alive) setState((current) => current.available === next.available && current.active === next.active ? current : next);
    }, () => {});
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [desktop, screenShare]);

  useEffect(() => () => { if (wasSharing.current) void closeMeetingAnnotation({ shareStopped: true }).catch(() => {}); }, []);

  const toggle = useCallback(() => {
    const active = state.active;
    setState((current) => ({ ...current, active: !active }));
    const request = active ? closeMeetingAnnotation() : openMeetingAnnotation();
    void request.then(() => readMeetingAnnotationState()).then(setState, (error) => {
      errorRef.current(error instanceof Error ? error.message : "无法打开标注");
      void readMeetingAnnotationState().then(setState, () => {});
    });
  }, [state.active]);

  return { available: desktop && screenShare && state.available, active: state.active, toggle };
}

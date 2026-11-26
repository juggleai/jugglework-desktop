import { useCallback, useEffect, useRef, useState } from "react";
import { closeMeetingAnnotation, openMeetingAnnotation, readMeetingAnnotationState } from "@/app/lib/desktop";

const POLL_MS = 1000;

/**
 * Annotation availability for the local share. The main process decides
 * whether the confirmed source is a whole screen; this hook only mirrors that,
 * and closes annotation when the share stops or the meeting UI unmounts.
 */
export function useMeetingAnnotation(screenShare: boolean, onError: (message: string) => void) {
  const [state, setState] = useState({ available: false, active: false, preparing: false });
  const desktop = typeof window !== "undefined" && !!window.__JUGGLEWORK_ELECTRON__?.invokeDesktop;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const wasSharing = useRef(false);
  const reportedExit = useRef<string | undefined>(undefined);
  const reportExit = (next: { active: boolean; lastExitReason?: string; lastExitDetail?: string }) => {
    const reason = next.active ? undefined : next.lastExitReason;
    if (reason && reason !== reportedExit.current) {
      errorRef.current(reason === "resized" ? "共享窗口尺寸已改变，标注已停止。" :
        reason === "target-closed" ? "共享窗口已关闭，标注已停止。" :
        `无法确认标注画布与共享窗口的位置或层级，已停止标注以避免误拦截点击。${next.lastExitDetail ? `（${next.lastExitDetail}）` : ""}`);
    }
    reportedExit.current = reason;
  };

  useEffect(() => {
    if (!desktop) return;
    if (!screenShare) {
      setState({ available: false, active: false, preparing: false });
      if (wasSharing.current) void closeMeetingAnnotation({ shareStopped: true }).catch(() => {});
      wasSharing.current = false;
      return;
    }
    wasSharing.current = true;
    let alive = true;
    // Polling also picks up exits from the toolbar, Esc or an unplugged display.
    const refresh = () => readMeetingAnnotationState().then((next) => {
      if (alive) reportExit(next);
      if (alive) setState((current) => current.available === next.available && current.active === next.active && current.preparing === !!next.preparing ? current : { ...next, preparing: !!next.preparing });
    }, () => {});
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [desktop, screenShare]);

  useEffect(() => () => { if (wasSharing.current) void closeMeetingAnnotation({ shareStopped: true }).catch(() => {}); }, []);

  const toggle = useCallback(() => {
    const active = state.active;
    reportedExit.current = undefined;
    setState((current) => ({ ...current, active: !active }));
    const request = active ? closeMeetingAnnotation() : openMeetingAnnotation();
    void request.then(() => readMeetingAnnotationState()).then(next => { reportExit(next); setState({ ...next, preparing: !!next.preparing }); }, (error) => {
      errorRef.current(error instanceof Error ? error.message : "无法打开标注");
      void readMeetingAnnotationState().then(next => setState({ ...next, preparing: !!next.preparing }), () => {});
    });
  }, [state.active]);

  return { visible: desktop && screenShare, available: desktop && screenShare && state.available,
    preparing: desktop && screenShare && state.preparing, active: state.active, toggle };
}

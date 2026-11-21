import { useCallback, useEffect, useRef, useState } from "react";
import { meetingAPI, MeetingRequestError } from "./api";
import { isMeetingRequestScopeCurrent } from "./meeting-request-scope";
import type { Meeting, MeetingReadiness } from "./types";

export function useMeetingOverview({ active, scope, from, to }: { active: boolean; scope: string; from: Date; to: Date }) {
  const [items, setItems] = useState<Meeting[]>([]);
  const [readiness, setReadiness] = useState<MeetingReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const forbiddenScope = useRef<string | null>(null);
  const manualRefresh = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => manualRefresh.current?.(), []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const isCurrent = () => !controller.signal.aborted && isMeetingRequestScopeCurrent(scope);
    let inFlight = false;
    let changedWhileLoading = false;
    const load = async () => {
      if (!isCurrent() || inFlight || forbiddenScope.current === scope) return;
      inFlight = true;
      try {
        const [settings, list] = await Promise.allSettled([
          meetingAPI.settings(controller.signal),
          meetingAPI.list(from, to, controller.signal),
        ]);
        if (!isCurrent()) return;
        const failures = [settings, list].flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
        const forbidden = failures.some(error => error instanceof MeetingRequestError && error.status === 403);
        if (forbidden) forbiddenScope.current = scope;
        setReadiness(!forbidden && settings.status === "fulfilled" ? settings.value : null);
        if (forbidden) setItems([]);
        else if (list.status === "fulfilled") setItems(list.value.meetings);
        setError([...new Set(failures.map(error => error instanceof Error ? error.message : "加载失败"))].join("；"));
      } catch (error) {
        if (isCurrent()) setError(error instanceof Error ? error.message : "加载失败");
      } finally {
        inFlight = false;
        if (isCurrent()) setLoading(false);
        if (changedWhileLoading) {
          changedWhileLoading = false;
          void load();
        }
      }
    };
    const update = () => void load();
    const onMeetingChanged = () => {
      if (inFlight) changedWhileLoading = true;
      else update();
    };
    manualRefresh.current = () => {
      forbiddenScope.current = null;
      update();
    };
    window.addEventListener("meeting:changed", onMeetingChanged);
    window.addEventListener("focus", update);
    const timer = window.setInterval(update, 30_000);
    // In dev, StrictMode tears down the first effect before this runs.
    void Promise.resolve().then(update);
    return () => {
      controller.abort();
      manualRefresh.current = null;
      window.removeEventListener("meeting:changed", onMeetingChanged);
      window.removeEventListener("focus", update);
      window.clearInterval(timer);
    };
  }, [active, scope, from, to]);

  return { items, readiness, loading, error, refresh };
}

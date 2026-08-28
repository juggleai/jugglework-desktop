/** @jsxImportSource react */
import { useEffect } from "react";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications";
import { LOCAL_AUTOMATION_ENABLED } from "./automation-feature-flags";

const SCAN_INTERVAL_MS = 15_000;
const NOTIFIED_RUNS_KEY = "jugglework.automation.notified-runs.v1";

/** 监听本机自动化运行结果并发送桌面通知，不连接任何云同步接口。 */
export function AutomationRunNotificationCoordinator() {
  const store = useOptionalJuggleWorkServer();

  useEffect(() => {
    if (!LOCAL_AUTOMATION_ENABLED || !store) return;
    let disposed = false;
    let initialized = false;
    const scan = async () => {
      const local = store.getSnapshot().juggleworkServerClient;
      if (!local || disposed) return;
      const page = await local.listAutomationRuns({ limit: 50 }).catch(() => null);
      if (!page || disposed) return;
      const terminal = page.items.filter((run) => run.state === "succeeded" || run.state === "failed");
      const known = readNotifiedRuns();
      if (!initialized && !known.size) {
        terminal.forEach((run) => known.add(run.id));
        writeNotifiedRuns(known);
        initialized = true;
        return;
      }
      initialized = true;
      for (const run of terminal.reverse()) {
        if (known.has(run.id)) continue;
        const href = run.sessionId
          ? `/workspace/${encodeURIComponent(run.workspaceId)}/session/${encodeURIComponent(run.sessionId)}`
          : "/automations/runs";
        notifyDesktopEvent(run.state === "failed"
          ? { type: "automation.failed", automationName: run.automationName, errorText: run.errorMessage, href }
          : { type: "automation.succeeded", automationName: run.automationName, href });
        known.add(run.id);
      }
      writeNotifiedRuns(known);
    };
    void scan();
    const interval = window.setInterval(() => void scan(), SCAN_INTERVAL_MS);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [store]);

  return null;
}

function readNotifiedRuns(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(NOTIFIED_RUNS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function writeNotifiedRuns(ids: Set<string>): void {
  localStorage.setItem(NOTIFIED_RUNS_KEY, JSON.stringify([...ids].slice(-200)));
}

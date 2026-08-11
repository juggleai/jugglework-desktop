/** @jsxImportSource react */
import { useCallback, useEffect, useMemo } from "react";
import {
  Bell,
  CircleCheck,
  Info,
  OctagonX,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import {
  useNotificationStore,
  type AppNotification,
  type NotificationSeverity,
} from "@/react-app/kernel/notification-store";
import { useLocation, useNavigate } from "react-router-dom";
import { requestOpenModelPicker } from "./new-providers-listener";
import { useControlAction, type JuggleWorkControlAction } from "./control/control-provider";
import { openNotificationCenterEvent } from "./notifications";
import { useReloadCoordinator } from "./reload-coordinator";

const SEVERITY_ICONS: Record<NotificationSeverity, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: OctagonX,
};

const SEVERITY_CLASSES: Record<NotificationSeverity, string> = {
  info: "text-sky-11",
  success: "text-emerald-11",
  warning: "text-amber-11",
  error: "text-red-11",
};

function formatTimeAgo(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return t("notifications.just_now");
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Keeps notification automation and the global "open notification center"
 * event available even though the notification UI now lives in Settings.
 */
export function NotificationCenterController() {
  const notifications = useNotificationStore((state) => state.notifications);
  const navigate = useNavigate();
  const notificationsListAction = useMemo<JuggleWorkControlAction>(() => ({
    id: "notifications.list",
    label: "List notifications",
    description: "Return the current notification center entries.",
    kind: "query",
    effects: { data: "read", ui: "none", external: false },
    sideEffect: "none",
    execute: () => notifications.map((notification) => ({
      id: notification.id,
      kind: notification.kind,
      severity: notification.severity,
      title: notification.title,
      body: notification.body,
      count: notification.count,
      readAt: notification.readAt,
      actionType: notification.action?.type ?? null,
      actionLabel: notification.actionLabel ?? null,
    })),
  }), [notifications]);
  useControlAction(notificationsListAction);

  useEffect(() => {
    const openSettingsNotifications = () => navigate("/settings/notifications");
    window.addEventListener(openNotificationCenterEvent, openSettingsNotifications);
    return () => window.removeEventListener(openNotificationCenterEvent, openSettingsNotifications);
  }, [navigate]);

  return null;
}

/** Full notification center rendered as the first item in Global Settings. */
export function NotificationCenterView() {
  const notifications = useNotificationStore((state) => state.notifications);
  const markAllRead = useNotificationStore((state) => state.markAllRead);
  const clearAll = useNotificationStore((state) => state.clearAll);
  const reloadCoordinator = useReloadCoordinator();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const isVisible = /\/settings\/notifications\/?$/.test(location.pathname);
    if (isVisible && notifications.some((notification) => notification.readAt === null)) {
      markAllRead();
    }
  }, [location.pathname, markAllRead, notifications]);

  const runAction = useCallback(
    (notification: AppNotification) => {
      const action = notification.action;
      if (!action) return;
      markAllRead();
      if (action.type === "open-model-picker") {
        requestOpenModelPicker(action.providerIds);
      } else if (action.type === "reload-engine") {
        void reloadCoordinator.reloadWorkspaceEngine();
      } else if (action.type === "open-extensions-marketplace") {
        navigate("/settings/extensions");
      } else if (action.type === "install-marketplace-plugin") {
        navigate("/settings/extensions");
      }
    },
    [markAllRead, navigate, reloadCoordinator],
  );

  return (
    <section className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
      <div className="flex min-h-12 items-center justify-between border-b border-dls-border px-4 py-2.5">
        <p className="text-sm font-semibold">{t("notifications.title")}</p>
        {notifications.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={clearAll}
          >
            {t("notifications.clear_all")}
          </Button>
        ) : null}
      </div>
      {notifications.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-6 py-16 text-center">
          <Bell className="mb-2 size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">{t("notifications.empty")}</p>
          <p className="text-xs text-muted-foreground">{t("notifications.empty_hint")}</p>
        </div>
      ) : (
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto py-1">
          {notifications.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onAction={runAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NotificationRow({
  notification,
  onAction,
}: {
  notification: AppNotification;
  onAction: (notification: AppNotification) => void;
}) {
  const Icon = SEVERITY_ICONS[notification.severity];
  const unread = notification.readAt === null;
  const showCount =
    notification.count > 1 &&
    (notification.severity === "warning" || notification.severity === "error");

  return (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-dls-border px-4 py-3 last:border-b-0",
        unread ? "bg-primary/5" : "opacity-80",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", SEVERITY_CLASSES[notification.severity])} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 break-words text-sm font-medium">
            {notification.title}
            {showCount ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                ×{notification.count}
              </span>
            ) : null}
          </p>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {formatTimeAgo(notification.updatedAt)}
            {unread ? <span className="size-1.5 rounded-full bg-primary" /> : null}
          </span>
        </div>
        {notification.body ? (
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{notification.body}</p>
        ) : null}
        {notification.action && notification.actionLabel ? (
          <div className="mt-1.5">
            <Button variant="outline" size="sm" onClick={() => onAction(notification)}>
              {notification.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

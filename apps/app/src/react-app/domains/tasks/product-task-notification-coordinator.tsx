/** @jsxImportSource react */
import { useEffect } from "react";

import { t } from "@/i18n";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { productTaskNotificationScopeKey, useNotificationStore } from "@/react-app/kernel/notification-store";
import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications";
import { notifyEvent } from "@/react-app/shell/notifications";

const TASK_NOTIFICATION_INTERVAL_MS = 15_000;

export function ProductTaskNotificationCoordinator() {
  const cloud = useCloudSession();
  const organizationId = cloud.activeOrganization?.id ?? "";
  const userId = cloud.user?.id ?? "";

  useEffect(() => {
    if (!cloud.isSignedIn || !organizationId || !userId) return;
    const sourceKey = productTaskNotificationScopeKey(cloud.baseUrl, userId, organizationId);
    let disposed = false;
    let pending = false;

    const scan = async () => {
      if (disposed || pending) return;
      pending = true;
      try {
        let afterSequence = useNotificationStore.getState().sourceVersions[sourceKey]?.version;
        let page = await cloud.client.listProductTaskNotificationEvents(organizationId, { afterSequence, limit: 100 });
        if (disposed) return;
        if (afterSequence === undefined) {
          useNotificationStore.getState().advanceSource(sourceKey, page.nextSequence);
          return;
        }
        for (;;) {
          for (const event of [...page.items].sort((left, right) => left.sequence - right.sequence)) {
            if (disposed) return;
            if ((useNotificationStore.getState().sourceVersions[sourceKey]?.version ?? 0) >= event.sequence) continue;
            notifyEvent({
              kind: "tasks",
              title: t("notifications.task_reminder_title"),
              body: event.task.title || t("notifications.task_reminder_body"),
              dedupeKey: `product-task-event:${event.id}`,
              source: { key: sourceKey, version: event.sequence },
              action: { type: "open-product-task", taskId: event.task.id },
              actionLabel: t("notifications.view_task"),
              scopeKey: sourceKey,
            });
            notifyDesktopEvent({ type: "product-task.reminder", taskTitle: event.task.title, href: `/tasks/${encodeURIComponent(event.task.id)}` });
            afterSequence = event.sequence;
          }
          if (!page.hasMore || disposed) break;
          page = await cloud.client.listProductTaskNotificationEvents(organizationId, { afterSequence, limit: 100 });
        }
      } catch {
        // Offline and transient control-plane failures retry on the next scan.
      } finally {
        pending = false;
      }
    };

    const retryNow = () => void scan();
    void scan();
    const interval = window.setInterval(retryNow, TASK_NOTIFICATION_INTERVAL_MS);
    window.addEventListener("online", retryNow);
    window.addEventListener("focus", retryNow);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("online", retryNow);
      window.removeEventListener("focus", retryNow);
    };
  }, [cloud.baseUrl, cloud.client, cloud.isSignedIn, organizationId, userId]);

  return null;
}

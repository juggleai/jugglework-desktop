/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

import {
  createDenClient,
  denCredentialFingerprint,
  readDenSettings,
  readDenUserId,
} from "@/app/lib/den";
import { t } from "@/i18n";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  openDocsSource,
  type DocsAccountScope,
} from "@/react-app/domains/cloud-docs/docs-card-navigation";

import { parseDocsNotificationAction } from "./docs-notification-action";

function readAccount(): DocsAccountScope | null {
  const settings = readDenSettings();
  const userId = readDenUserId();
  if (!settings.authToken || !settings.activeOrgId || !userId) return null;
  try {
    return {
      server: new URL(settings.baseUrl).href.replace(/\/+$/, ""),
      userId,
      tenantId: settings.activeOrgId,
      authFingerprint: denCredentialFingerprint(settings.authToken),
    };
  } catch {
    return null;
  }
}

/** 处理系统通知点击，始终重新核对账号、组织、持久事件和 Docs 权限。 */
export function DocsDesktopNotificationCoordinator() {
  const auth = useDenAuth();
  const navigate = useNavigate();
  const running = useRef(new Set<string>());

  useEffect(() => {
    const subscribe = window.__JUGGLEWORK_ELECTRON__?.desktopNotifications?.onAction;
    if (!subscribe) return;
    return subscribe((raw) => {
      const action = parseDocsNotificationAction(raw);
      if (!action) return;
      const key = `${action.source.server}\0${action.source.userId}\0${action.source.tenantId}\0${action.payload.eventId}`;
      if (running.current.has(key)) return;
      running.current.add(key);
      void openDocsSource(
        action.source,
        action.payload,
        action.conversationId,
        {
          readAccount,
          organizations: auth.organizations,
          confirmSwitch: (name) =>
            window.confirm(
              t("cloud_docs.switch_to_open").replace("{name}", name),
            ),
          switchOrganization: auth.switchOrganization,
          validate: (payload) => {
            const settings = readDenSettings();
            return createDenClient({
              baseUrl: settings.baseUrl,
              token: settings.authToken,
            }).validateDocsCard(payload);
          },
          navigate,
        },
      )
        .then((result) => {
          if (result === "source-changed")
            toast.error(t("cloud_docs.source_changed"));
          if (result === "unavailable")
            toast.error(t("cloud_docs.card_unavailable"));
        })
        .catch(() => toast.error(t("cloud_docs.connection_failed")))
        .finally(() => running.current.delete(key));
    });
  }, [auth.organizations, auth.switchOrganization, navigate]);

  return null;
}

/** @jsxImportSource react */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/i18n";
import {
  createDenClient,
  denCredentialFingerprint,
  readDenSettings,
  readDenUserId,
} from "@/app/lib/den";
import { useDenAuth } from "../cloud/den-auth-provider";
import {
  openDocsCard,
  type DocsAccountScope,
} from "../cloud-docs/docs-card-navigation";
import { docsMessageSource } from "./docs-message";
import type { ChatMessage } from "./types";

/** 目标组织没有 IM 时仍可申请源账号的 Docs 交接。 */
function readAccount(): DocsAccountScope | null {
  const settings = readDenSettings(),
    userId = readDenUserId();
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

/** 固定模板；来源未知、转发或不支持的版本只显示通用提示。 */
export function DocsNotificationBubble({ message }: { message: ChatMessage }) {
  const auth = useDenAuth(),
    navigate = useNavigate();
  const source = docsMessageSource(message);
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const open = async () => {
    if (running.current || !source) return;
    running.current = true;
    setPending(true);
    try {
      const result = await openDocsCard(message, {
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
      });
      if (result === "source-changed")
        toast.error(t("cloud_docs.source_changed"));
      if (result === "unavailable")
        toast.error(t("cloud_docs.card_unavailable"));
    } catch {
      toast.error(t("cloud_docs.connection_failed"));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  const copy = !source
    ? t("cloud_docs.card_fallback")
    : source.payload.part === "group"
      ? t("cloud_docs.card_group")
      : source.payload.kind.endsWith("user_mention")
        ? t("cloud_docs.card_mention")
        : source.payload.kind === "comment.resolved"
          ? t("cloud_docs.card_resolved")
          : t("cloud_docs.card_comment");
  return (
    <div className="tyn-reply-bubble">
      <div className="tyn-reply-text jw-docs-card">
        <div className="jw-docs-card-heading">
          <FileText size={18} />
          <strong>{t("cloud_docs.card_title")}</strong>
        </div>
        <p>{copy}</p>
        {source && auth.activeOrganization?.id === source.payload.tenantId && (
          <small>{auth.activeOrganization.name}</small>
        )}
        {source && (
          <button
            type="button"
            className="jw-docs-card-open"
            disabled={pending}
            onClick={() => void open()}
          >
            {pending ? t("cloud_docs.loading") : t("cloud_docs.open_document")}
          </button>
        )}
      </div>
    </div>
  );
}

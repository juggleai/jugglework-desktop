/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { HelpCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

/**
 * 分区标题后的问号提示
 * @param text 悬浮时展示的说明文案
 */
function SectionHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            aria-label={text}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HelpCircle className="size-4" aria-hidden="true" />
          </button>
        )}
      />
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  );
}

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
  connected?: boolean;
};

export type AiSettingsViewProps = {
  busy: boolean;
  providerAuthBusy: boolean;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  onDeleteProvider: (providerId: string) => boolean | Promise<boolean>;
  /** 点击本地模型组并打开编辑表单。 */
  onEditLocalProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  canDeleteProvider: (provider: ConnectedProvider) => boolean;
  deletingProviderId: string | null;
  /**
   * Provider IDs parked in `disabled_providers`. They stay declared in the
   * user's OpenCode config, so Disconnect must be undoable from here.
   */
  reconnectingProviderId?: string | null;
  onReconnectProvider?: (providerId: string) => void | Promise<void>;
  /**
   * 组织托管模型组的 provider ID 集合。命中的条目归入组织托管分区，且为只读：
   * 它们由组织统一下发，本地无法断开或删除。
   */
  cloudProviderIds?: Set<string>;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

/** 单个模型组条目的展示信息，与来源无关。 */
function ProviderRowIdentity(props: {
  provider: ConnectedProvider;
  isOrgManaged: boolean;
  isLocalProvider: boolean;
  isConnected: boolean;
  onOpenDetails?: () => void;
}) {
  const { provider, isOrgManaged, isLocalProvider, isConnected } = props;
  return (
    <button
      type="button"
      className={`flex min-w-0 items-center gap-3 rounded-lg text-left ${
        props.onOpenDetails ? "cursor-pointer hover:opacity-80" : "cursor-default"
      }`}
      onClick={() => props.onOpenDetails?.()}
      disabled={!props.onOpenDetails}
    >
      <ProviderIcon
        providerId={provider.id}
        size={20}
        className={isConnected ? "text-dls-text" : "text-muted-foreground"}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-dls-text">{provider.name}</span>
          {isOrgManaged ? (
            <span className="shrink-0 rounded-full border border-blue-6 bg-blue-2 px-2 py-0.5 text-[10px] font-medium text-blue-11">
              {t("settings.provider_org_managed_hint")}
            </span>
          ) : null}
          {isLocalProvider ? (
            <span className="shrink-0 rounded-full border border-gray-6 bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
              {t("settings.provider_source_local")}
            </span>
          ) : null}
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              isConnected
                ? "border-green-6 bg-green-2 text-green-11"
                : "border-gray-6 bg-gray-3 text-gray-11"
            }`}
          >
            {t(isConnected
              ? "settings.provider_status_connected"
              : "settings.provider_status_disconnected")}
          </span>
          {provider.source === "env" ? (
            <span className="shrink-0 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11">
              {providerSourceLabel("env")}
            </span>
          ) : null}
        </div>
        {!provider.id.startsWith("lpr_") ? (
          <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
        ) : null}
      </div>
    </button>
  );
}

export function AiSettingsView(props: AiSettingsViewProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<ConnectedProvider | null>(null);

  // TIPS: 两类模型组的所有权不同——本地模型组由用户在本机声明，组织托管模型组由
  // 组织下发。可操作范围也随之不同，混排会让「这一行能做什么」无法预测，因此按来源
  // 分区渲染。
  const orgProviders = props.connectedProviders.filter(
    (provider) => props.cloudProviderIds?.has(provider.id) === true,
  );
  const localProviders = props.connectedProviders.filter(
    (provider) => props.cloudProviderIds?.has(provider.id) !== true,
  );

  const renderLocalProvider = (provider: ConnectedProvider) => {
    const isLocalProvider = provider.source === "config";
    const isConnected = provider.connected !== false;
    // 每一行只被自己进行中的操作禁用，其余条目保持可用。
    const rowDisconnecting = props.disconnectingProviderId === provider.id;
    const rowReconnecting = props.reconnectingProviderId === provider.id;
    const rowDeleting = props.deletingProviderId === provider.id;
    const rowBusy = rowDisconnecting || rowReconnecting || rowDeleting;
    const baseDisabled = props.busy || props.providerAuthBusy || rowBusy;
    return (
      <LayoutSectionItem
        key={provider.id}
        className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
      >
        <ProviderRowIdentity
          provider={provider}
          isOrgManaged={false}
          isLocalProvider={isLocalProvider}
          isConnected={isConnected}
          onOpenDetails={
            isLocalProvider ? () => void props.onEditLocalProvider(provider.id) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-2">
          {isLocalProvider ? (
            <Button
              variant="outline"
              onClick={() => void props.onEditLocalProvider(provider.id)}
              disabled={props.busy || props.providerAuthBusy}
            >
              {t("settings.provider_view_details")}
            </Button>
          ) : null}
          {isConnected ? (
            <Button
              variant="outline"
              onClick={() => void props.onDisconnectProvider(provider.id)}
              disabled={baseDisabled || !props.canDisconnectProvider(provider)}
            >
              {rowDisconnecting
                ? t("settings.disconnecting")
                : props.canDisconnectProvider(provider)
                  ? t("settings.disconnect")
                  : t("settings.managed_by_env")}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => void props.onReconnectProvider?.(provider.id)}
              disabled={baseDisabled}
            >
              {rowReconnecting
                ? t("settings.reconnecting_provider")
                : t("settings.reconnect_provider")}
            </Button>
          )}
          {props.canDeleteProvider(provider) ? (
            <Button
              variant="destructive"
              onClick={() => setDeleteCandidate(provider)}
              disabled={baseDisabled}
            >
              {rowDeleting ? t("providers.deleting") : t("providers.delete_permanently")}
            </Button>
          ) : null}
        </div>
      </LayoutSectionItem>
    );
  };

  const renderOrgProvider = (provider: ConnectedProvider) => (
    // 组织托管模型组只读：本地「断开」既不影响组织侧配置，又会造成本地与组织状态
    // 不一致，因此不提供断开与删除入口。
    <LayoutSectionItem
      key={provider.id}
      className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
    >
      <ProviderRowIdentity
        provider={provider}
        isOrgManaged
        isLocalProvider={false}
        isConnected={provider.connected !== false}
      />
    </LayoutSectionItem>
  );

  return (
    <>
      <LayoutStack>
      {/* ---- Local model groups ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <LayoutSectionTitle>
                {t("settings.providers_group_local")}
                <SectionHint text={t("settings.providers_group_local_desc")} />
              </LayoutSectionTitle>
            </div>
            <Button
              onClick={() => void props.onOpenProviderAuth()}
              disabled={props.busy || props.providerAuthBusy}
            >
              {props.providerAuthBusy
                ? t("settings.loading_providers")
                : t("settings.connect_provider")}
            </Button>
          </div>
        </LayoutSectionHeader>

        {localProviders.length > 0 ? (
          <div className="space-y-2">{localProviders.map(renderLocalProvider)}</div>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}
      </LayoutSection>

      {/* ---- Organization-managed model groups ---- */}
      {orgProviders.length > 0 ? (
        <LayoutSection>
          <LayoutSectionHeader>
            <div className="min-w-0">
              <LayoutSectionTitle>
                {t("settings.providers_group_org")}
                <SectionHint text={t("settings.providers_group_org_desc")} />
              </LayoutSectionTitle>
            </div>
          </LayoutSectionHeader>
          <div className="space-y-2">{orgProviders.map(renderOrgProvider)}</div>
        </LayoutSection>
      ) : null}

      </LayoutStack>

      <AlertDialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !props.deletingProviderId) setDeleteCandidate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("providers.delete_dialog_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("providers.delete_dialog_desc", {
                provider: deleteCandidate?.name ?? deleteCandidate?.id ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-xl border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">
            {t("providers.delete_dialog_warning")}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(props.deletingProviderId)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteCandidate || Boolean(props.deletingProviderId)}
              onClick={async () => {
                if (!deleteCandidate) return;
                const deleted = await props.onDeleteProvider(deleteCandidate.id);
                if (deleted) setDeleteCandidate(null);
              }}
            >
              {props.deletingProviderId
                ? t("providers.deleting")
                : t("providers.delete_confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

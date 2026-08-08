/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import { useState } from "react";
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

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
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
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  canDeleteProvider: (provider: ConnectedProvider) => boolean;
  deletingProviderId: string | null;
  /**
   * Provider IDs parked in `disabled_providers`. They stay declared in the
   * user's OpenCode config, so Disconnect must be undoable from here.
   */
  disabledProviderIds?: string[];
  reconnectingProviderId?: string | null;
  onReconnectProvider?: (providerId: string) => void | Promise<void>;
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
  cloudProviderImportIds?: Record<string, string>;
  onRemoveCloudProvider?: (providerId: string, cloudProviderId: string) => void | Promise<void>;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

export function AiSettingsView(props: AiSettingsViewProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<ConnectedProvider | null>(null);

  return (
    <>
      <LayoutStack>
      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
              <LayoutSectionDescription className="mt-1">
                {t("settings.providers_desc")}
              </LayoutSectionDescription>
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

        {props.connectedProviders.length > 0 ? (
          <div className="space-y-2">
            {props.connectedProviders.map((provider) => (
              <LayoutSectionItem
                key={provider.id}
                className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-dls-text">{provider.name}</span>
                      {props.cloudProviderIds?.has(provider.id) ? (
                        <span className="shrink-0 rounded-full border border-blue-6 bg-blue-2 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                          {t("settings.provider_source_cloud")}
                        </span>
                      ) : null}
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
                </div>
                {props.cloudProviderIds?.has(provider.id) ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      const cloudProviderId = props.cloudProviderImportIds?.[provider.id];
                      if (cloudProviderId) void props.onRemoveCloudProvider?.(provider.id, cloudProviderId);
                    }}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null ||
                      !props.cloudProviderImportIds?.[provider.id]
                    }
                  >
                    {props.disconnectingProviderId === provider.id
                      ? t("settings.disconnecting")
                      : t("settings.disconnect")}
                  </Button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void props.onDisconnectProvider(provider.id)}
                      disabled={
                        props.busy ||
                        props.providerAuthBusy ||
                        props.disconnectingProviderId !== null ||
                        props.deletingProviderId !== null ||
                        !props.canDisconnectProvider(provider)
                      }
                    >
                      {props.disconnectingProviderId === provider.id
                        ? t("settings.disconnecting")
                        : props.canDisconnectProvider(provider)
                          ? t("settings.disconnect")
                          : t("settings.managed_by_env")}
                    </Button>
                    {props.canDeleteProvider(provider) ? (
                      <Button
                        variant="destructive"
                        onClick={() => setDeleteCandidate(provider)}
                        disabled={
                          props.busy ||
                          props.providerAuthBusy ||
                          props.disconnectingProviderId !== null ||
                          props.deletingProviderId !== null
                        }
                      >
                        {props.deletingProviderId === provider.id
                          ? t("providers.deleting")
                          : t("providers.delete_permanently")}
                      </Button>
                    ) : null}
                  </div>
                )}
              </LayoutSectionItem>
            ))}
          </div>
        ) : null}

        {props.disabledProviderIds && props.disabledProviderIds.length > 0 ? (
          <LayoutSectionItem className="gap-2 rounded-2xl border border-dashed border-dls-border px-4 py-3">
            <div>
              <div className="text-sm font-medium text-dls-text">
                {t("settings.disabled_providers_title")}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t("settings.disabled_providers_desc")}
              </div>
            </div>
            <div className="space-y-2">
              {props.disabledProviderIds.map((providerId) => (
                <div key={providerId} className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderIcon providerId={providerId} size={20} className="text-muted-foreground" />
                    <span className="truncate font-mono text-xs text-muted-foreground">{providerId}</span>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => void props.onReconnectProvider?.(providerId)}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      Boolean(props.reconnectingProviderId)
                    }
                  >
                    {props.reconnectingProviderId === providerId
                      ? t("settings.reconnecting_provider")
                      : t("settings.reconnect_provider")}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => setDeleteCandidate({ id: providerId, name: providerId, source: "config" })}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null ||
                      props.deletingProviderId !== null
                    }
                  >
                    {props.deletingProviderId === providerId
                      ? t("providers.deleting")
                      : t("providers.delete_permanently")}
                  </Button>
                </div>
              ))}
            </div>
          </LayoutSectionItem>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}
      </LayoutSection>

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

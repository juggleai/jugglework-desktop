/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2, KeyRound, RefreshCw, X } from "lucide-react";

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
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
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (provider: ConnectedProvider) => boolean;
  /**
   * Provider IDs parked in `disabled_providers`. They stay declared in the
   * user's OpenCode config, so Disconnect must be undoable from here.
   */
  disabledProviderIds?: string[];
  reconnectingProviderId?: string | null;
  onReconnectProvider?: (providerId: string) => void | Promise<void>;
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
  showJuggleWorkModelsSubscribe?: boolean;
  /** Subtle fallback row when JuggleWork Models is not connected and the banner was dismissed. */
  showJuggleWorkModelsConnect?: boolean;
  /** Den entitlement is present but local engine has no selectable jugglework models yet. */
  showJuggleWorkModelsSyncing?: boolean;
  onSubscribeJuggleWorkModels?: () => void | Promise<void>;
  onRefreshJuggleWorkModels?: () => void | Promise<void>;
  onDismissJuggleWorkModels?: () => void | Promise<void>;
  cloudProvidersView?: ReactNode;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

function providerStatusTone(label: string): "ready" | "warning" | "neutral" {
  if (label.toLowerCase().includes("connected")) return "ready";
  if (label.toLowerCase().includes("error") || label.toLowerCase().includes("fail")) return "warning";
  return "neutral";
}

export function AiSettingsView(props: AiSettingsViewProps) {
  return (
    <LayoutStack>
      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              {props.providerSummary}
              <SettingsStatusBadge
                tone={providerStatusTone(props.providerStatusLabel)}
                label={props.providerStatusLabel}
              />
            </LayoutSectionItemTitle>
            <LayoutSectionItemHeaderActions>
              <Button
                onClick={() => void props.onOpenProviderAuth()}
                disabled={props.busy || props.providerAuthBusy}
              >
                {props.providerAuthBusy
                  ? t("settings.loading_providers")
                  : t("settings.connect_provider")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {props.showJuggleWorkModelsSubscribe ? (
          <LayoutSectionItem className="relative overflow-hidden rounded-2xl border border-blue-6 bg-blue-2/30 px-4 py-4">
            <button
              type="button"
              className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full text-blue-11 transition-colors hover:bg-blue-3/70"
              onClick={() => void props.onDismissJuggleWorkModels?.()}
              aria-label={t("ai.dismiss_banner")}
            >
              <X className="size-3.5" />
            </button>
            <div className="flex flex-col gap-4 pr-8 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                <ProviderIcon providerId="jugglework" size={22} className="mt-0.5 shrink-0 text-blue-11" />
                <div className="min-w-0 space-y-2">
                  <div>
                    <div className="text-sm font-medium text-dls-text">JuggleWork Models</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t("ai.jugglework_models_banner_desc")}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px] text-blue-11">
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5">
                      <CheckCircle2 className="size-3" /> Managed by JuggleWork Cloud
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-6 bg-blue-3 px-2 py-0.5">
                      <KeyRound className="size-3" /> No API key setup
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("ai.jugglework_models_pricing")}
                  </p>
                </div>
              </div>
              <Button
                className="shrink-0"
                onClick={() => void props.onSubscribeJuggleWorkModels?.()}
                disabled={props.busy || props.providerAuthBusy}
              >
                Subscribe
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
            </div>
          </LayoutSectionItem>
        ) : null}

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
                          Cloud
                        </span>
                      ) : null}
                      {provider.source === "env" ? (
                        <span className="shrink-0 rounded-full border border-amber-6 bg-amber-2 px-2 py-0.5 text-[10px] font-medium text-amber-11">
                          {providerSourceLabel("env")}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{provider.id}</div>
                  </div>
                </div>
                {!props.cloudProviderIds?.has(provider.id) ? (
                  <Button
                    variant="destructive"
                    onClick={() => void props.onDisconnectProvider(provider.id)}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null ||
                      !props.canDisconnectProvider(provider)
                    }
                  >
                    {props.disconnectingProviderId === provider.id
                      ? t("settings.disconnecting")
                      : props.canDisconnectProvider(provider)
                        ? t("settings.disconnect")
                        : t("settings.managed_by_env")}
                  </Button>
                ) : null}
              </LayoutSectionItem>
            ))}
          </div>
        ) : null}

        {props.showJuggleWorkModelsConnect ? (
          <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-dls-border px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon providerId="jugglework" size={20} className="text-muted-foreground" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-dls-text">JuggleWork Models</span>
                  <span className="shrink-0 rounded-full border border-dls-border bg-dls-sidebar/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {t("ai.not_connected")}
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t("ai.jugglework_models_short_desc")}
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => void props.onSubscribeJuggleWorkModels?.()}
              disabled={props.busy || props.providerAuthBusy}
            >
              Connect
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          </LayoutSectionItem>
        ) : null}

        {props.showJuggleWorkModelsSyncing ? (
          <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-6/50 bg-amber-2/20 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <ProviderIcon providerId="jugglework" size={20} className="text-amber-11" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-dls-text">JuggleWork Models</span>
                  <span className="shrink-0 rounded-full border border-amber-6 bg-amber-3 px-2 py-0.5 text-[10px] font-medium text-amber-11">
                    Included — finish syncing
                  </span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {t("ai.jugglework_models_not_ready")}
                </div>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => void props.onRefreshJuggleWorkModels?.()}
              disabled={props.busy || props.providerAuthBusy}
            >
              <RefreshCw className="mr-1.5 size-3.5" />
              {t("ai.refresh_models")}
            </Button>
          </LayoutSectionItem>
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
                </div>
              ))}
            </div>
          </LayoutSectionItem>
        ) : null}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectStatus ? (
          <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}

        <LayoutSectionItemFootnote>{t("settings.api_keys_info")}</LayoutSectionItemFootnote>
      </LayoutSection>

      {props.cloudProvidersView}

    </LayoutStack>
  );
}

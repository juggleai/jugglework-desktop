/** @jsxImportSource react */
import {
  ArrowUpRight,
  Cloud,
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  Globe,
  Plug,
  Sheet,
  Users,
  Share2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { PaperGrainGradient } from "@jugglework/ui/react";

import { t } from "../../../i18n";
import { DEFAULT_DEN_BASE_URL } from "../../../app/lib/den";
import { Button } from "@/components/ui/button";
import { resolveExtensionIconSrc } from "../../design-system/extension-icon-src";
import { TextInput } from "../../design-system/text-input";
import { OrganizationServerAffordance } from "../settings/cloud/organization-server-affordance";
import { SignInFallbackNotice } from "./signin-fallback-notice";

export type DenSignInSurfaceVariant = "panel" | "fullscreen";

export type DenSignInSurfaceProps = {
  variant?: DenSignInSurfaceVariant;
  appName?: string;
  logoUrl?: string | null;
  developerMode: boolean;
  baseUrl: string;
  baseUrlDraft: string;
  baseUrlError: string | null;
  statusMessage: string | null;
  signinFallbackUrl?: string | null;
  authError: string | null;
  authBusy: boolean;
  baseUrlBusy: boolean;
  sessionBusy: boolean;
  manualAuthOpen: boolean;
  manualAuthInput: string;
  organizationServerBusy?: boolean;
  organizationServerError?: string | null;
  organizationServerUrl?: string;
  onBaseUrlDraftInput: (value: string) => void;
  onOrganizationServerSave?: (url: string) => Promise<boolean>;
  onResetBaseUrl: () => void;
  onApplyBaseUrl: () => void;
  onOpenControlPlane: () => void;
  onOpenBrowserAuth: (mode: "sign-in" | "sign-up") => void;
  onToggleManualAuth: () => void;
  onManualAuthInput: (value: string) => void;
  onSubmitManualAuth: () => void;
};

const settingsPanelClass = "ow-soft-card rounded-[28px] p-5 md:p-6";
const settingsPanelSoftClass = "ow-soft-card-quiet rounded-2xl p-4";
const headerBadgeClass =
  "inline-flex min-h-8 items-center gap-2 rounded-xl border border-dls-border bg-dls-hover px-3 text-[13px] font-medium text-dls-text shadow-sm";
const softNoticeClass =
  "rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-dls-secondary";
const errorBannerClass =
  "rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11";

/** 未配置组织 Logo 时使用随包交付的应用标识，避免首次启动页面没有任何品牌标识。 */
const DEFAULT_SIGNIN_LOGO_SRC = resolveExtensionIconSrc("/jugglework-logo.png");

/* ------------------------------------------------------------------ */
/*  Right-side showcase: capabilities + team features                  */
/* ------------------------------------------------------------------ */

// TIPS: 图标使用本地 lucide 组件，不依赖外部 CDN，离线首次启动也能完整显示。
const capabilities: Array<{ key: string; icon: LucideIcon }> = [
  { key: "spreadsheets", icon: Sheet },
  { key: "browser", icon: Globe },
  { key: "files", icon: FolderOpen },
  { key: "automation", icon: Workflow },
  { key: "content", icon: FileText },
  { key: "integrations", icon: Plug },
];

const teamFeatures: Array<{ key: string; icon: LucideIcon }> = [
  { key: "shared_extensions", icon: Share2 },
  { key: "team", icon: Users },
];

function ShowcasePanel({ appName }: { appName: string }) {
  return (
    <div className="flex flex-col gap-5">
      {/* Hero */}
      <div className="space-y-1.5">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-dls-text">
          {t("den.showcase_title", { appName })}
        </h2>
        <p className="text-[13px] leading-relaxed text-dls-secondary">
          {t("den.showcase_subtitle")}
        </p>
      </div>

      {/* Capabilities */}
      <div className="grid grid-cols-3 gap-2">
        {capabilities.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex flex-col gap-1.5 rounded-xl border border-dls-border bg-dls-surface p-3"
          >
            <Icon size={18} className="text-dls-accent" strokeWidth={1.75} />
            <div className="text-[12px] font-medium leading-tight text-dls-text">
              {t(`den.showcase_${key}_title`)}
            </div>
            <div className="text-[11px] leading-snug text-dls-secondary">
              {t(`den.showcase_${key}_desc`)}
            </div>
          </div>
        ))}
      </div>

      {/* Team features */}
      <div className="grid grid-cols-2 gap-2">
        {teamFeatures.map(({ key, icon: Icon }) => (
          <div
            key={key}
            className="flex items-start gap-2.5 rounded-xl border border-dls-border bg-dls-surface p-3"
          >
            <Icon size={16} className="mt-0.5 shrink-0 text-dls-secondary" strokeWidth={1.5} />
            <div>
              <div className="text-[12px] font-medium text-dls-text">
                {t(`den.showcase_${key}_title`)}
              </div>
              <div className="mt-0.5 text-[11px] leading-snug text-dls-secondary">
                {t(`den.showcase_${key}_desc`)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main surface                                                      */
/* ------------------------------------------------------------------ */

/**
 * React port of the Solid `DenSignInSurface`
 * (`apps/app/src/app/cloud/den-signin-surface.tsx` on dev).
 *
 * Stateless presentation: all state + actions are driven by the parent
 * (ForcedSigninPage for the full-screen gate, or the Den settings panel
 * for the embedded "panel" variant). Matches the Solid contract 1:1 so
 * feature parity is obvious.
 */
export function DenSignInSurface(props: DenSignInSurfaceProps) {
  const variant: DenSignInSurfaceVariant = props.variant ?? "panel";
  const appName = props.appName?.trim() || "北数Work";

  /* -- Panel content (reused by both variants) -- */
  const panelContent = (
    <div className={`${settingsPanelClass} space-y-4`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className={headerBadgeClass}>
            <Cloud size={13} className="text-dls-secondary" />
            {t("den.cloud_section_title")}
          </div>
          <div>
            <div className="text-sm font-medium text-dls-text">
              {t("den.signin_title")}
            </div>
          </div>
        </div>
      </div>

      {props.developerMode ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <TextInput
            label={t("den.cloud_control_plane_url_label")}
            value={props.baseUrlDraft}
            onChange={(event) =>
              props.onBaseUrlDraftInput(event.currentTarget.value)
            }
            placeholder={DEFAULT_DEN_BASE_URL}
            hint={t("den.cloud_control_plane_url_hint")}
            disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onResetBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {t("den.cloud_control_plane_reset")}
            </Button>
            <Button
              size="sm"
              onClick={props.onApplyBaseUrl}
              disabled={props.authBusy || props.baseUrlBusy || props.sessionBusy}
            >
              {t("den.cloud_control_plane_save")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={props.onOpenControlPlane}
            >
              {t("den.cloud_control_plane_open")}
              <ArrowUpRight size={13} />
            </Button>
          </div>
        </div>
      ) : null}

      {props.baseUrlError ? (
        <div className={errorBannerClass}>{props.baseUrlError}</div>
      ) : null}

      {props.statusMessage && !props.authError ? (
        <div className={softNoticeClass}>{props.statusMessage}</div>
      ) : null}

      <div className="space-y-2">
        <div className="max-w-[54ch] text-sm text-dls-secondary">
          {t("den.auto_reconnect_hint")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => props.onOpenBrowserAuth("sign-in")}>
          {t("den.signin_button")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onOpenBrowserAuth("sign-up")}
        >
          {t("den.create_account")}
          <ArrowUpRight size={13} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={props.onToggleManualAuth}
          disabled={props.authBusy || props.sessionBusy}
        >
          {props.manualAuthOpen
            ? t("den.hide_signin_code")
            : t("den.paste_signin_code")}
        </Button>
      </div>

      {props.signinFallbackUrl ? (
        <SignInFallbackNotice url={props.signinFallbackUrl} />
      ) : null}

      {props.manualAuthOpen ? (
        <div className={`${settingsPanelSoftClass} space-y-3`}>
          <TextInput
            label={t("den.signin_link_label")}
            value={props.manualAuthInput}
            onChange={(event) =>
              props.onManualAuthInput(event.currentTarget.value)
            }
            placeholder={t("den.signin_link_placeholder")}
            disabled={props.authBusy || props.sessionBusy}
            hint={t("den.signin_link_hint")}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={props.onSubmitManualAuth}
              disabled={
                props.authBusy ||
                props.sessionBusy ||
                !props.manualAuthInput.trim()
              }
            >
              {props.authBusy ? t("den.finishing") : t("den.finish_signin")}
            </Button>
            <div className="text-[11px] text-dls-secondary">
              {t("den.signin_code_note")}
            </div>
          </div>
        </div>
      ) : null}

      {props.authError ? (
        <div className={errorBannerClass}>{props.authError}</div>
      ) : null}
    </div>
  );

  /* ---------------------------------------------------------------- */
  /*  Fullscreen: two-column split layout                             */
  /* ---------------------------------------------------------------- */

  if (variant === "fullscreen") {
    return (
      <div className="relative min-h-screen bg-dls-background text-dls-text">
        {/* Subtle background texture */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute -left-[20%] -top-[30%] h-[70%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(14,51,217,0.06),transparent_70%)] blur-3xl" />
          <div className="absolute -bottom-[20%] -right-[10%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(255,126,46,0.05),transparent_70%)] blur-3xl" />
          <div className="absolute left-[30%] top-[60%] h-[40%] w-[40%] rounded-full bg-[radial-gradient(ellipse,rgba(255,227,64,0.04),transparent_70%)] blur-3xl" />
        </div>

        {/* Titlebar drag region */}
        <div className="absolute inset-x-0 top-0 z-20 h-10 mac:titlebar-drag" />

        <div className="relative z-10 flex min-h-screen">
          {/* ---- Left: sign-in (transparent on page bg) ---- */}
          <div className="flex w-full flex-col items-center justify-center px-8 py-16 lg:w-[45%] lg:px-12">
            <div className="w-full max-w-md space-y-8">
              <div className="space-y-2">
                {props.logoUrl ? (
                  <img src={props.logoUrl} alt={t("den.signin_logo_alt", { appName })} className="mb-6 max-h-16 max-w-64 object-contain object-left" />
                ) : (
                  <img
                    src={DEFAULT_SIGNIN_LOGO_SRC}
                    alt={t("den.signin_logo_alt", { appName })}
                    width={56}
                    height={56}
                    className="mb-6 size-14 rounded-2xl object-contain"
                  />
                )}
                <h1 className="text-2xl font-semibold tracking-tight text-dls-text">
                  {t("den.signin_welcome_title", { appName })}
                </h1>
                <p className="text-sm text-dls-secondary">
                  {t("den.signin_welcome_subtitle")}
                </p>
              </div>

              <button
                type="button"
                className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-dls-accent text-sm font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                // Opens on the sign-up tab (label stays "Sign in"): most
                // people hitting this are new, and the web page's tabs let
                // returning users switch to sign-in in one tap.
                onClick={() => props.onOpenBrowserAuth("sign-up")}
                disabled={props.authBusy || props.sessionBusy}
              >
                {t("den.signin_cta", { appName })}
                <ArrowUpRight size={15} />
              </button>

              {props.signinFallbackUrl ? (
                <SignInFallbackNotice url={props.signinFallbackUrl} />
              ) : null}

              {props.onOrganizationServerSave ? (
                <OrganizationServerAffordance
                  busy={props.organizationServerBusy === true}
                  error={props.organizationServerError ?? null}
                  onSave={props.onOrganizationServerSave}
                  url={props.organizationServerUrl ?? props.baseUrl}
                />
              ) : null}

              {props.statusMessage && !props.authError ? (
                <div className={softNoticeClass}>{props.statusMessage}</div>
              ) : null}

              {props.authError ? (
                <div className={errorBannerClass}>{props.authError}</div>
              ) : null}

              {/* Paste code disclosure */}
              <div className="space-y-3">
                <button
                  type="button"
                   className="flex w-full items-center gap-2 rounded-xl border border-dls-border bg-dls-surface/60 px-4 py-2.5 text-left text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-surface"
                  onClick={props.onToggleManualAuth}
                  disabled={props.authBusy || props.sessionBusy}
                >
                  {props.manualAuthOpen ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                  {props.manualAuthOpen
                    ? t("den.hide_signin_code")
                    : t("den.paste_signin_code")}
                </button>

                {props.manualAuthOpen ? (
                  <div className="space-y-3 rounded-xl border border-dls-border bg-dls-surface p-4">
                    <TextInput
                      label={t("den.signin_link_label")}
                      value={props.manualAuthInput}
                      onChange={(event) =>
                        props.onManualAuthInput(event.currentTarget.value)
                      }
                      placeholder={t("den.signin_link_placeholder")}
                      disabled={props.authBusy || props.sessionBusy}
                      hint={t("den.signin_link_hint")}
                    />
                    <button
                      type="button"
                      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-full bg-dls-accent px-4 text-xs font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onSubmitManualAuth}
                      disabled={
                        props.authBusy ||
                        props.sessionBusy ||
                        !props.manualAuthInput.trim()
                      }
                    >
                      {props.authBusy
                        ? t("den.finishing")
                        : t("den.finish_signin")}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Developer mode */}
              {props.developerMode ? (
                <div className="space-y-3 rounded-xl border border-dls-border bg-dls-surface p-4">
                  <TextInput
                    label={t("den.cloud_control_plane_url_label")}
                    value={props.baseUrlDraft}
                    onChange={(event) =>
                      props.onBaseUrlDraftInput(event.currentTarget.value)
                    }
                    placeholder={DEFAULT_DEN_BASE_URL}
                    hint={t("den.cloud_control_plane_url_hint")}
                    disabled={
                      props.authBusy || props.baseUrlBusy || props.sessionBusy
                    }
                  />
                  {props.baseUrlError ? (
                    <div className={errorBannerClass}>{props.baseUrlError}</div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-dls-border bg-dls-surface px-3.5 text-xs font-medium text-dls-text transition-colors hover:bg-dls-hover hover:border-dls-border disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onResetBaseUrl}
                      disabled={
                        props.authBusy || props.baseUrlBusy || props.sessionBusy
                      }
                    >
                      {t("den.cloud_control_plane_reset")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-dls-accent px-3.5 text-xs font-semibold text-[var(--dls-accent-fg)] transition-all hover:bg-[var(--dls-accent-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
                      onClick={props.onApplyBaseUrl}
                      disabled={
                        props.authBusy || props.baseUrlBusy || props.sessionBusy
                      }
                    >
                      {t("den.cloud_control_plane_save")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* ---- Right: shader outer card > white inner card ---- */}
          <div className="hidden lg:flex lg:w-[55%] lg:items-center lg:justify-center lg:p-6">
            {/* Outer: shader card */}
            <div className="relative w-full max-w-xl overflow-hidden rounded-3xl">
              {/* Shader background */}
              <div className="absolute inset-0 z-0">
                <PaperGrainGradient
                  speed={0}
                  scale={1}
                  rotation={0}
                  offsetX={0}
                  offsetY={0}
                  softness={0.5}
                  intensity={0.5}
                  noise={0.25}
                  shape="corners"
                  frame={37706.748}
                  colors={["#0E33D9", "#FF7E2E", "#FFE340", "#000000"]}
                  colorBack="#00000000"
                  style={{ backgroundColor: "#FFFFFF", width: "100%", height: "100%" }}
                />
              </div>

              {/* Inner: card with capabilities */}
              <div className="relative z-10 m-3 rounded-2xl bg-dls-surface p-7">
                <ShowcasePanel appName={appName} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Panel variant (settings embed): unchanged                       */
  /* ---------------------------------------------------------------- */

  return panelContent;
}

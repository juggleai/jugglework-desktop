import type { DenBootstrapConfig, DenDesktopConfig } from "../../../app/lib/den";

const BRANDING_KEYS = [
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
  "brandAccentColor",
] as const satisfies readonly (keyof DenDesktopConfig)[];

const BOOTSTRAP_BRANDING_KEYS = [
  "brandAppName",
  "brandLogoUrl",
  "brandIconUrl",
] as const satisfies readonly (keyof DenDesktopConfig)[];

export function hasWorkspaceBranding(config: DenDesktopConfig): boolean {
  return BRANDING_KEYS.some((key) => {
    const value = config[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function workspaceBrandingFingerprint(
  orgId: string,
  config: DenDesktopConfig,
): string {
  return JSON.stringify([
    orgId,
    config.brandAppName ?? null,
    config.brandLogoUrl ?? null,
    config.brandIconUrl ?? null,
    config.brandAccentColor ?? null,
  ]);
}

export type DesktopHostPlatform = "darwin" | "linux" | "windows";

/**
 * Branding the running process cannot finish applying by itself.
 *
 * - `app-name`: the runtime `__applyBrandAppName` path retitles the menu bar,
 *   the window and the process, but only calls `app.setName()` on macOS. On
 *   Windows and Linux the Electron-level name is bound during startup, so
 *   anything derived from `app.getName()` keeps the stock name until relaunch.
 * - `app-icon`: the live icon apply failed. Only the startup path, which
 *   re-applies from the bootstrap config and the cached icon file, can still
 *   land it.
 *
 * Everything else — the in-app wordmark and the accent color — is renderer
 * state, and a branded icon that applied cleanly is already on the dock,
 * taskbar or window. None of those justify interrupting onboarding.
 */
export type BrandingRestartReason = "app-name" | "app-icon";

export type BrandingApplyOutcome = {
  iconApplied: boolean;
};

function brandingValue(config: DenDesktopConfig, key: keyof DenDesktopConfig): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

export function brandingRestartReasons(
  config: DenDesktopConfig,
  platform: DesktopHostPlatform | null,
  outcome: BrandingApplyOutcome,
): BrandingRestartReason[] {
  const reasons: BrandingRestartReason[] = [];
  // An unknown host is treated like macOS rather than prompting blindly: the
  // renderer only fails to read the platform when the Electron bridge is
  // absent, and then there is nothing to restart anyway.
  if (brandingValue(config, "brandAppName") && platform !== null && platform !== "darwin") {
    reasons.push("app-name");
  }
  if (brandingValue(config, "brandIconUrl") && !outcome.iconApplied) {
    reasons.push("app-icon");
  }
  return reasons;
}

export function brandingRestartSummary(
  reasons: readonly BrandingRestartReason[],
  workspaceName: string,
): { title: string; description: string; detail: string } {
  const workspace = workspaceName.trim() || "your workspace";
  const name = reasons.includes("app-name");
  const icon = reasons.includes("app-icon");

  if (name && icon) {
    return {
      title: "Workspace identity is ready",
      description: `Restart JuggleWork once to finish applying ${workspace}'s name and app icon everywhere.`,
      detail: "Restarting sets the application name your operating system reads and retries the workspace app icon.",
    };
  }
  if (name) {
    return {
      title: "Workspace name is ready",
      description: `Restart JuggleWork once to finish applying ${workspace}'s name everywhere.`,
      detail: "The menu bar and window title already use the workspace name. Restarting applies it to the application name your operating system reads.",
    };
  }
  if (icon) {
    return {
      title: "Workspace icon needs a restart",
      description: `Restart JuggleWork to finish applying ${workspace}'s app icon.`,
      detail: "The icon is downloaded and saved. Restarting re-applies it during startup, which usually succeeds when applying it live did not.",
    };
  }
  return {
    title: "Workspace identity is ready",
    description: `Restart JuggleWork once to finish applying ${workspace}'s branding.`,
    detail: "Restarting re-applies the workspace branding from a clean startup.",
  };
}

export type BootstrapBrandingFields = {
  brandAppName: string | null;
  brandLogoUrl: string | null;
  brandIconUrl: string | null;
};

export function bootstrapBrandingFromDesktopConfig(
  config: DenDesktopConfig,
): BootstrapBrandingFields {
  return {
    brandAppName: typeof config.brandAppName === "string" ? config.brandAppName : null,
    brandLogoUrl: typeof config.brandLogoUrl === "string" ? config.brandLogoUrl : null,
    brandIconUrl: typeof config.brandIconUrl === "string" ? config.brandIconUrl : null,
  };
}

export function bootstrapBrandingNeedsSync(
  bootstrap: Pick<DenBootstrapConfig, "brandAppName" | "brandLogoUrl" | "brandIconUrl">,
  config: DenDesktopConfig,
): boolean {
  const next = bootstrapBrandingFromDesktopConfig(config);
  return BOOTSTRAP_BRANDING_KEYS.some((key) => (bootstrap[key] ?? null) !== next[key]);
}

declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
  toEqual: (expected: unknown) => void;
  not: { toBe: (expected: unknown) => void };
};

import {
  bootstrapBrandingFromDesktopConfig,
  bootstrapBrandingNeedsSync,
  brandingRestartReasons,
  brandingRestartSummary,
  hasWorkspaceBranding,
  workspaceBrandingFingerprint,
} from "./workspace-branding-restart";

const applied = { iconApplied: true };

describe("workspace branding restart", () => {
  test("detects every supported branding field", () => {
    expect(hasWorkspaceBranding({ brandAppName: "Acme" })).toBe(true);
    expect(hasWorkspaceBranding({ brandLogoUrl: "https://example.com/logo.png" })).toBe(true);
    expect(hasWorkspaceBranding({ brandIconUrl: "https://example.com/icon.png" })).toBe(true);
    expect(hasWorkspaceBranding({ brandAccentColor: "blue" })).toBe(true);
    expect(hasWorkspaceBranding({})).toBe(false);
  });

  test("fingerprints the organization and all branding fields", () => {
    const first = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/one.png" });
    const repeated = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/one.png" });
    const changed = workspaceBrandingFingerprint("org-1", { brandIconUrl: "https://example.com/two.png" });

    expect(first).toBe(repeated);
    expect(first).not.toBe(changed);
  });

  test("maps cleared desktop branding to null bootstrap fields", () => {
    expect(bootstrapBrandingFromDesktopConfig({
      brandAppName: "Acme",
      brandLogoUrl: "https://example.com/logo.png",
      brandIconUrl: "https://example.com/icon.png",
    })).toEqual({
      brandAppName: "Acme",
      brandLogoUrl: "https://example.com/logo.png",
      brandIconUrl: "https://example.com/icon.png",
    });
    expect(bootstrapBrandingFromDesktopConfig({})).toEqual({
      brandAppName: null,
      brandLogoUrl: null,
      brandIconUrl: null,
    });
  });

  test("does not ask for a restart when branding applied live", () => {
    // macOS applies the branded name in-process, so nothing is left over.
    expect(brandingRestartReasons({ brandAppName: "Acme" }, "darwin", applied)).toEqual([]);
    // The wordmark and accent color are renderer-only on every platform.
    expect(brandingRestartReasons(
      { brandLogoUrl: "https://example.com/logo.png", brandAccentColor: "blue" },
      "windows",
      applied,
    )).toEqual([]);
    // An icon that landed is already on the dock, taskbar or window.
    expect(brandingRestartReasons(
      { brandIconUrl: "https://example.com/icon.png" },
      "windows",
      applied,
    )).toEqual([]);
    // Blank values are not branding.
    expect(brandingRestartReasons({ brandAppName: "   " }, "linux", applied)).toEqual([]);
    // No Electron bridge means there is nothing to restart.
    expect(brandingRestartReasons({ brandAppName: "Acme" }, null, applied)).toEqual([]);
  });

  test("asks for a restart only for branding the startup path owns", () => {
    // Off macOS the runtime path skips app.setName, so the Electron-level
    // name stays stock until the next launch.
    expect(brandingRestartReasons({ brandAppName: "Acme" }, "windows", applied)).toEqual(["app-name"]);
    expect(brandingRestartReasons({ brandAppName: "Acme" }, "linux", applied)).toEqual(["app-name"]);
    // A failed icon apply can still be retried during startup.
    expect(brandingRestartReasons(
      { brandIconUrl: "https://example.com/icon.png" },
      "darwin",
      { iconApplied: false },
    )).toEqual(["app-icon"]);
    expect(brandingRestartReasons(
      { brandAppName: "Acme", brandIconUrl: "https://example.com/icon.png" },
      "windows",
      { iconApplied: false },
    )).toEqual(["app-name", "app-icon"]);
    // A missing icon URL cannot fail to apply.
    expect(brandingRestartReasons({ brandLogoUrl: "https://example.com/logo.png" }, "darwin", {
      iconApplied: false,
    })).toEqual([]);
  });

  test("describes each restart reason with the workspace name", () => {
    expect(brandingRestartSummary(["app-name"], "Acme").description).toBe(
      "Restart JuggleWork once to finish applying Acme's name everywhere.",
    );
    expect(brandingRestartSummary(["app-icon"], "Acme").description).toBe(
      "Restart JuggleWork to finish applying Acme's app icon.",
    );
    expect(brandingRestartSummary(["app-name", "app-icon"], "Acme").description).toBe(
      "Restart JuggleWork once to finish applying Acme's name and app icon everywhere.",
    );
    // The unknown-failure fallback still reads as a sentence without an org name.
    expect(brandingRestartSummary([], "  ").description).toBe(
      "Restart JuggleWork once to finish applying your workspace's branding.",
    );
  });

  test("detects when bootstrap still holds a cleared brand icon or wordmark", () => {
    expect(bootstrapBrandingNeedsSync(
      { brandIconUrl: "https://example.com/icon.png", brandLogoUrl: "https://example.com/logo.png" },
      {},
    )).toBe(true);
    expect(bootstrapBrandingNeedsSync(
      { brandIconUrl: "https://example.com/icon.png" },
      { brandIconUrl: "https://example.com/icon.png" },
    )).toBe(false);
    expect(bootstrapBrandingNeedsSync(
      {},
      { brandLogoUrl: "https://example.com/logo.png" },
    )).toBe(true);
  });
});

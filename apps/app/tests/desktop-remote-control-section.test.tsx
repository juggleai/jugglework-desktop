import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TestRenderer, { act } from "react-test-renderer";

import type { DesktopRemoteControlAgentStatus } from "@jugglework/types/desktop-ipc";
import { setLocale } from "../src/i18n";
import { RemoteControlActivityIndicator, requestRemoteControlReregistration, shouldShowRemoteControlReregister, statusPresentation } from "../src/react-app/domains/settings/cloud/desktop-remote-control-section";
import { CloudSessionProvider, useCloudSession } from "../src/react-app/domains/settings/cloud/cloud-session-provider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function status(overrides: Partial<DesktopRemoteControlAgentStatus> = {}): DesktopRemoteControlAgentStatus {
  return {
    schemaVersion: 1,
    state: "connected",
    started: true,
    connected: true,
    enrolled: true,
    revoked: false,
    revocationPending: false,
    locallyDisabled: false,
    localControlEnabled: true,
    activeControlSessionCount: 0,
    controllerDisplayNames: [],
    lifecycleGeneration: 1,
    connectionGeneration: 7,
    lastErrorCode: null,
    enrollmentAuthorized: true,
    replacementPending: false,
    replacementStatus: "idle",
    replacementErrorCode: null,
    ...overrides,
  };
}

describe("Desktop remote-control status presentation", () => {
  test("distinguishes connected transport from active remote control", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(
      <RemoteControlActivityIndicator status={status()} busy={false} onStopAll={() => {}} />,
    );
    expect(html).toContain('data-testid="remote-control-transport-connected"');
    expect(html).toContain("传输已连接，当前没有活跃远程控制");
    expect(html).not.toContain("远程控制活跃中");
  });

  test("distinguishes pending verification from confirmed revocation in Chinese and English", () => {
    for (const [locale, pending, revoked] of [
      ["zh", "正在核验撤销状态", "已撤销"],
      ["en", "Verifying revocation status", "Revoked"],
    ] as const) {
      setLocale(locale);
      expect(statusPresentation(status({ connected: false, state: "verifying_revocation", revocationPending: true }))).toEqual({
        label: pending,
        tone: "warning",
      });
      expect(statusPresentation(status({ connected: false, state: "revoked", revoked: true }))).toEqual({
        label: revoked,
        tone: "error",
      });
    }
  });

  test("shows controller names and a direct Stop All action only for active control", () => {
    setLocale("zh");
    const html = renderToStaticMarkup(
      <RemoteControlActivityIndicator
        status={status({ activeControlSessionCount: 3, controllerDisplayNames: ["Alice", "Bob"] })}
        busy={false}
        onStopAll={() => {}}
      />,
    );
    expect(html).toContain('data-testid="remote-control-active-indicator"');
    expect(html).toContain("远程控制活跃中");
    expect(html).toContain("3 个控制会话");
    expect(html).toContain("控制者：Alice、Bob");
    expect(html).toContain("全部停止远程控制");
    expect(html).not.toContain("当前没有活跃远程控制");
  });

  test("shows re-registration only for freshly authorized local-disabled idle state", () => {
    const disabled = { schemaVersion: 1 as const, enabled: false, preventSleepWhileWaiting: false, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
    const input = { signedIn: true, policyAllowsRemote: true, settings: disabled, status: status({ connected: false, state: "disabled", locallyDisabled: true, localControlEnabled: false }) };
    expect(shouldShowRemoteControlReregister(input)).toBe(true);
    expect(shouldShowRemoteControlReregister({ ...input, signedIn: false })).toBe(false);
    expect(shouldShowRemoteControlReregister({ ...input, policyAllowsRemote: false })).toBe(false);
    expect(shouldShowRemoteControlReregister({ ...input, status: status({ state: "disabled", replacementPending: true }) })).toBe(false);
    expect(shouldShowRemoteControlReregister({ ...input, status: status({ state: "disabled", enrollmentAuthorized: false }) })).toBe(false);
    expect(shouldShowRemoteControlReregister({
      ...input,
      status: status({ connected: false, state: "disabled", locallyDisabled: true, localControlEnabled: false, lastErrorCode: "device_reregistration_required" }),
    })).toBe(true);
  });

  test("excludes ordinary offline, backoff, and cloud-disabled transport while locally enabled", () => {
    const enabled = { schemaVersion: 1 as const, enabled: true, preventSleepWhileWaiting: true, backgroundMode: false, launchAtLogin: false, allowBusySessionSteer: false, allowBusySessionEnqueue: false };
    for (const candidate of [
      status({ connected: false, state: "connecting" }),
      status({ connected: false, state: "backoff" }),
      status({ connected: false, state: "backoff", lastErrorCode: "device_disabled" }),
    ]) {
      expect(shouldShowRemoteControlReregister({ signedIn: true, policyAllowsRemote: true, settings: enabled, status: candidate })).toBe(false);
    }
  });

  test("awaits fresh policy before the grant and invokes only the compound bridge command", async () => {
    const calls: string[] = [];
    const result = await requestRemoteControlReregistration({
      refreshFresh: async () => {
        calls.push("fresh-context-synced");
        return {
          config: { desktopRemoteFeatureGates: { schemaVersion: 1, enrollment: true, readOnlyControl: true } },
          scope: { controlPlaneBaseUrl: "https://cloud.example.test", userId: "user-1", organizationId: "org-1" },
        };
      },
      currentScope: () => ({ controlPlaneBaseUrl: "https://cloud.example.test", userId: "user-1", organizationId: "org-1" }),
      createEnrollmentGrant: async () => {
        calls.push("grant-created");
        return { grant: "one-time-grant" };
      },
      reregisterAndEnable: async (input) => {
        calls.push(`compound:${input.grant}:${input.scope.organizationId}`);
        return { ok: true, status: status(), error: null };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["fresh-context-synced", "grant-created", "compound:one-time-grant:org-1"]);
  });

  test("does not mint a grant or invoke replacement after account, org, or base URL changes", async () => {
    const original = { controlPlaneBaseUrl: "https://cloud-a.example.test", userId: "user-a", organizationId: "org-a" };
    for (const current of [
      { ...original, controlPlaneBaseUrl: "https://cloud-b.example.test" },
      { ...original, userId: "user-b" },
      { ...original, organizationId: "org-b" },
    ]) {
      let grantCalls = 0;
      let replacementCalls = 0;
      await expect(requestRemoteControlReregistration({
        refreshFresh: async () => ({
          config: { desktopRemoteFeatureGates: { schemaVersion: 1, enrollment: true, readOnlyControl: true } },
          scope: original,
        }),
        currentScope: () => current,
        createEnrollmentGrant: async () => { grantCalls += 1; return { grant: "mixed-scope-grant" }; },
        reregisterAndEnable: async () => { replacementCalls += 1; return { ok: true, status: status(), error: null }; },
      })).rejects.toThrow("account or organization changed");
      expect(grantCalls).toBe(0);
      expect(replacementCalls).toBe(0);
    }
  });

  test("does not sync onward, mint a grant, or replace after a deferred policy fetch resolves under a switched scope", async () => {
    const original = { controlPlaneBaseUrl: "https://cloud-a.example.test", userId: "user-a", organizationId: "org-a" };
    let current = original;
    let releaseFetch = () => {};
    let fetchStarted = () => {};
    const started = new Promise<void>((resolve) => { fetchStarted = () => resolve(); });
    const gate = new Promise<void>((resolve) => { releaseFetch = () => resolve(); });
    let grantCalls = 0;
    let replacementCalls = 0;
    const request = requestRemoteControlReregistration({
      refreshFresh: async () => {
        fetchStarted();
        await gate;
        return {
          config: { desktopRemoteFeatureGates: { schemaVersion: 1, enrollment: true, readOnlyControl: true } },
          scope: original,
        };
      },
      currentScope: () => current,
      createEnrollmentGrant: async () => { grantCalls += 1; return { grant: "mixed-scope-grant" }; },
      reregisterAndEnable: async () => { replacementCalls += 1; return { ok: true, status: status(), error: null }; },
    });
    await started;
    current = { controlPlaneBaseUrl: "https://cloud-b.example.test", userId: "user-b", organizationId: "org-b" };
    releaseFetch();
    await expect(request).rejects.toThrow("account or organization changed");
    expect(grantCalls).toBe(0);
    expect(replacementCalls).toBe(0);
  });

  test("does not invoke destructive replacement when scope changes while grant creation is deferred", async () => {
    const original = { controlPlaneBaseUrl: "https://cloud-a.example.test", userId: "user-a", organizationId: "org-a" };
    let current = original;
    let releaseGrant = () => {};
    let grantStarted = () => {};
    const started = new Promise<void>((resolve) => { grantStarted = () => resolve(); });
    const gate = new Promise<void>((resolve) => { releaseGrant = () => resolve(); });
    let replacementCalls = 0;
    const request = requestRemoteControlReregistration({
      refreshFresh: async () => ({
        config: { desktopRemoteFeatureGates: { schemaVersion: 1, enrollment: true, readOnlyControl: true } },
        scope: original,
      }),
      currentScope: () => current,
      createEnrollmentGrant: async () => { grantStarted(); await gate; return { grant: "scope-a-grant" }; },
      reregisterAndEnable: async () => { replacementCalls += 1; return { ok: true, status: status(), error: null }; },
    });
    await started;
    current = { ...original, organizationId: "org-b" };
    releaseGrant();
    await expect(request).rejects.toThrow("account or organization changed");
    expect(replacementCalls).toBe(0);
  });

  test("a mounted CloudSession scope switch is visible through the stable getter during a deferred grant", async () => {
    const original = { controlPlaneBaseUrl: "https://cloud-a.example.test", userId: "user-a", organizationId: "org-a" };
    let cloud: ReturnType<typeof useCloudSession> | null = null;
    function Probe() {
      cloud = useCloudSession();
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<CloudSessionProvider><Probe /></CloudSessionProvider>);
    });
    await act(async () => {
      cloud!.setBaseUrl(original.controlPlaneBaseUrl);
      cloud!.setIsSignedIn(true);
      cloud!.setUser({ id: original.userId } as never);
      cloud!.setActiveOrganization({ id: original.organizationId, name: "Org A", role: "member", slug: "org-a" });
    });
    const getCurrentScope = cloud!.getCurrentScope;
    expect(getCurrentScope()).toEqual(original);

    let grantStarted = () => {};
    let releaseGrant = () => {};
    const started = new Promise<void>((resolve) => { grantStarted = () => resolve(); });
    const gate = new Promise<void>((resolve) => { releaseGrant = () => resolve(); });
    let replacementCalls = 0;
    const request = requestRemoteControlReregistration({
      refreshFresh: async () => ({
        config: { desktopRemoteFeatureGates: { schemaVersion: 1, enrollment: true, readOnlyControl: true } },
        scope: original,
      }),
      currentScope: getCurrentScope,
      createEnrollmentGrant: async () => { grantStarted(); await gate; return { grant: "scope-a-grant" }; },
      reregisterAndEnable: async () => { replacementCalls += 1; return { ok: true, status: status(), error: null }; },
    });
    await started;
    await act(async () => {
      cloud!.setBaseUrl("https://cloud-b.example.test");
      cloud!.setUser({ id: "user-b" } as never);
      cloud!.setActiveOrganization({ id: "org-b", name: "Org B", role: "member", slug: "org-b" });
    });
    expect(getCurrentScope()).toEqual({
      controlPlaneBaseUrl: "https://cloud-b.example.test",
      userId: "user-b",
      organizationId: "org-b",
    });
    releaseGrant();
    await expect(request).rejects.toThrow("account or organization changed");
    expect(replacementCalls).toBe(0);
    await act(async () => renderer!.unmount());
  });
});

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setLocale } from "../src/i18n";
import { PermissionApprovalPanel, reusableGrantScope } from "../src/react-app/domains/session/chat/permission-approval-modal";
import { mergeSessionPermissionGrantReply } from "../src/react-app/domains/session/sync/use-session-interactions";
import {
  ACTIVE_PERMISSION_MODE_REFETCH_MS,
  sessionPermissionModeRefetchInterval,
} from "../src/react-app/domains/session/sync/use-session-permission-mode";
import { PermissionModeSelect } from "../src/react-app/domains/session/surface/composer/permission-mode-select";
import type { PendingPermission } from "../src/app/types";
import type { SessionPermissionGrantRecord } from "@jugglework/types/session-permission-modes";

function legacyPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "req-1",
    sessionID: "ses_root",
    permission: "bash",
    patterns: ["git push origin main"],
    always: [],
    receivedAt: 1,
    interactionRevision: 1,
    protocol: "legacy",
    targetSessionId: "ses_root",
    parentSessionId: null,
    rootSessionId: "ses_root",
    ancestryPath: ["ses_root"],
    ...overrides,
  } as PendingPermission;
}

function v2Permission(overrides: Record<string, unknown> = {}): PendingPermission {
  return {
    id: "req-2",
    sessionID: "ses_child",
    permission: "edit",
    patterns: ["/repo/src/a.ts"],
    metadata: { action: "file.edit" },
    always: [],
    receivedAt: 1,
    interactionRevision: 1,
    protocol: "v2",
    v2: { action: "file.edit", resources: ["/repo/src/a.ts"], save: ["/repo/**"] },
    targetSessionId: "ses_child",
    parentSessionId: "ses_root",
    rootSessionId: "ses_root",
    ancestryPath: ["ses_root", "ses_child"],
    ...overrides,
  } as PendingPermission;
}

describe("reusableGrantScope", () => {
  test("legacy requests expose `always` patterns as the reusable scope", () => {
    expect(reusableGrantScope(legacyPermission({ always: ["git push *"] }))).toEqual(["git push *"]);
    expect(reusableGrantScope(legacyPermission({ always: [] }))).toEqual([]);
    expect(reusableGrantScope(legacyPermission())).toEqual([]);
  });

  test("v2 requests expose `save` resources as the reusable scope", () => {
    expect(reusableGrantScope(v2Permission())).toEqual(["/repo/**"]);
    const withoutNested = v2Permission({ v2: { action: "file.edit", resources: ["/repo/a.ts"] } });
    expect(reusableGrantScope(withoutNested)).toEqual([]);
  });
});

describe("session permission grant cache", () => {
  test("makes a newly activated grant available before the background refetch", () => {
    const oldGrant = { id: "grant-old" } as SessionPermissionGrantRecord;
    const activatedGrant = {
      id: "grant-new",
      state: "active",
      profileVersion: 1,
    } as SessionPermissionGrantRecord;
    const current = {
      state: null,
      grants: [oldGrant],
      supported: true,
      profileVersion: 1,
    };
    const merged = mergeSessionPermissionGrantReply(current, {
      state: null,
      grant: activatedGrant,
    });
    expect(merged?.grants).toEqual([activatedGrant, oldGrant]);
    expect(mergeSessionPermissionGrantReply(undefined, {
      state: null,
      grant: activatedGrant,
    })).toEqual({
      state: null,
      grants: [activatedGrant],
      supported: true,
      profileVersion: activatedGrant.profileVersion,
    });
  });
});

describe("session permission authority refresh", () => {
  test("polls while full access or an active reusable grant is configured", () => {
    expect(sessionPermissionModeRefetchInterval({
      state: { requestedMode: "full-access" },
      grants: [],
    })).toBe(ACTIVE_PERMISSION_MODE_REFETCH_MS);
    expect(sessionPermissionModeRefetchInterval({
      state: { requestedMode: "request-approval" },
      grants: [{ state: "active" }],
    })).toBe(ACTIVE_PERMISSION_MODE_REFETCH_MS);
  });

  test("does not poll sessions without automatic authority", () => {
    expect(sessionPermissionModeRefetchInterval({
      state: { requestedMode: "request-approval" },
      grants: [],
    })).toBe(false);
    expect(sessionPermissionModeRefetchInterval(null)).toBe(false);
  });
});

describe("PermissionApprovalPanel session grant action", () => {
  test("shows the session-grant action only when a reusable scope exists", () => {
    setLocale("en");
    const withScope = renderToStaticMarkup(
      <PermissionApprovalPanel
        permission={legacyPermission({ always: ["git push *"] })}
        respondPermission={() => {}}
        respondPermissionGrant={() => Promise.resolve(true)}
      />,
    );
    expect(withScope).toContain("Always allow in this session");
    expect(withScope).toContain("Future requests covered");
    expect(withScope).toContain("git push *");

    const withoutScope = renderToStaticMarkup(
      <PermissionApprovalPanel
        permission={legacyPermission()}
        respondPermission={() => {}}
        respondPermissionGrant={() => Promise.resolve(true)}
      />,
    );
    expect(withoutScope).not.toContain("Always allow in this session");
    expect(withoutScope).not.toContain("Future requests covered");
    // One-time and deny remain available either way.
    expect(withoutScope).toContain("Allow once");
    expect(withoutScope).toContain("Deny");
  });
});

describe("PermissionModeSelect trigger", () => {
  test("shows the effective mode including fail-closed states", () => {
    setLocale("en");
    const request = renderToStaticMarkup(
      <PermissionModeSelect
        requestedMode="request-approval"
        effectiveMode="request-approval"
        grants={[]}
        disabledReason={null}
        busy={false}
        running={false}
        desktopConfig={null}
        onSelectRequestApproval={() => {}}
        onSelectFullAccess={() => {}}
      />,
    );
    expect(request).toContain("Request approval");

    const full = renderToStaticMarkup(
      <PermissionModeSelect
        requestedMode="full-access"
        effectiveMode="full-access"
        grants={[]}
        disabledReason={null}
        busy={false}
        running={false}
        desktopConfig={null}
        onSelectRequestApproval={() => {}}
        onSelectFullAccess={() => {}}
      />,
    );
    expect(full).toContain("Full access");

    const paused = renderToStaticMarkup(
      <PermissionModeSelect
        requestedMode="full-access"
        effectiveMode="full-access-paused"
        grants={[]}
        disabledReason={null}
        busy={false}
        running={false}
        desktopConfig={null}
        onSelectRequestApproval={() => {}}
        onSelectFullAccess={() => {}}
      />,
    );
    expect(paused).toContain("Full access paused");

    const suspended = renderToStaticMarkup(
      <PermissionModeSelect
        requestedMode="full-access"
        effectiveMode="full-access-suspended"
        grants={[]}
        disabledReason={null}
        busy={false}
        running={false}
        desktopConfig={null}
        onSelectRequestApproval={() => {}}
        onSelectFullAccess={() => {}}
      />,
    );
    expect(suspended).toContain("Full access suspended");
  });

  test("unsupported server disables the selector", () => {
    setLocale("en");
    const html = renderToStaticMarkup(
      <PermissionModeSelect
        requestedMode={null}
        effectiveMode={null}
        grants={[]}
        disabledReason="Permission mode is not supported by this server."
        busy={false}
        running={false}
        desktopConfig={null}
        onSelectRequestApproval={() => {}}
        onSelectFullAccess={() => {}}
      />,
    );
    expect(html).toContain("disabled");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { createDenCredentialAuthorityChange } from "../src/app/lib/den-session-events";
import { createToonFactoryDenSessionCloser } from "../src/app/lib/toon-factory-auth-lifecycle";

const appRootSource = readFileSync(new URL("../src/react-app/shell/app-root.tsx", import.meta.url), "utf8");
const authProviderSource = readFileSync(new URL("../src/react-app/domains/cloud/den-auth-provider.tsx", import.meta.url), "utf8");
const handoffSource = readFileSync(new URL("../src/app/lib/den-handoff.ts", import.meta.url), "utf8");
const toonFactoryLifecycleSource = readFileSync(new URL("../src/app/lib/toon-factory-auth-lifecycle.ts", import.meta.url), "utf8");

describe("Toon Factory permission cleanup", () => {
  test("closes for sign-out, account switch, and organization switch without clearing same-account session restore", async () => {
    let closes = 0;
    const close = createToonFactoryDenSessionCloser({
      isDesktop: () => true,
      close: async () => { closes += 1; },
    });

    await close({ status: "signed_out", ...createDenCredentialAuthorityChange("signed_out") });
    await close({ status: "success", ...createDenCredentialAuthorityChange("session_established") });
    await close({ status: "success", ...createDenCredentialAuthorityChange("account_switched") });
    await close({ status: "authority_changed", ...createDenCredentialAuthorityChange("organization_switched") });

    expect(closes).toBe(3);
  });

  test("does not close for a routine refresh and deduplicates the same auth epoch", async () => {
    let closes = 0;
    const close = createToonFactoryDenSessionCloser({
      isDesktop: () => true,
      close: async () => { closes += 1; },
    });
    const handoff = {
      status: "success" as const,
      ...createDenCredentialAuthorityChange("account_switched"),
    };

    await close({ status: "success" });
    await close(handoff);
    await close(handoff);

    expect(closes).toBe(1);
  });

  test("is desktop-only and treats close failures as best effort", async () => {
    let closes = 0;
    const webClose = createToonFactoryDenSessionCloser({
      isDesktop: () => false,
      close: async () => { closes += 1; },
    });
    const failingClose = createToonFactoryDenSessionCloser({
      isDesktop: () => true,
      close: async () => { throw new Error("close failed"); },
    });

    await webClose({ status: "signed_out", ...createDenCredentialAuthorityChange("signed_out") });
    await failingClose({ status: "success", ...createDenCredentialAuthorityChange("session_established") });

    expect(closes).toBe(0);
  });

  test("bounds the awaited close when desktop IPC does not settle", async () => {
    const close = createToonFactoryDenSessionCloser({
      isDesktop: () => true,
      close: () => new Promise(() => {}),
      closeTimeoutMs: 0,
    });

    await close({ status: "success", ...createDenCredentialAuthorityChange("session_established") });
  });

  test("keeps the global listener non-blocking while switch paths await cleanup", () => {
    expect(appRootSource).toContain("void closeToonFactoryForDenSession(event.detail);");
    expect(appRootSource).toContain("window.addEventListener(denSessionUpdatedEvent, closeOnCredentialAuthorityChange)");

    const handoffClose = handoffSource.indexOf("await closeToonFactoryForDenSession(authorityChange)");
    expect(handoffClose).toBeGreaterThan(-1);
    expect(handoffClose).toBeLessThan(handoffSource.indexOf("writeDenSettings({", handoffClose));

    const reconcile = authProviderSource.indexOf("reconcileDenAccountIdentity(nextUser?.id)");
    const reconcileClose = authProviderSource.lastIndexOf("await closeToonFactoryForDenSession(", reconcile);
    expect(reconcileClose).toBeGreaterThan(-1);
    expect(reconcileClose).toBeLessThan(reconcile);
    const orgSwitch = authProviderSource.indexOf("const switchResult = await client.setActiveOrganization");
    const orgSwitchClose = authProviderSource.lastIndexOf("await closeToonFactoryForDenSession(authorityChange)", orgSwitch);
    expect(orgSwitchClose).toBeGreaterThan(-1);
    expect(orgSwitchClose).toBeLessThan(orgSwitch);
  });

  test("does not put a Den token in session event detail", () => {
    expect(handoffSource).not.toContain("token: exchange.token");
    expect(handoffSource).not.toContain("im: exchange.im");
  });

  test("revokes persisted project grants only for credential authority changes", () => {
    expect(toonFactoryLifecycleSource).toContain('import { toonFactoryCloseAndClearGrants } from "./desktop"');
    expect(toonFactoryLifecycleSource).toContain("close: toonFactoryCloseAndClearGrants");
    expect(toonFactoryLifecycleSource).not.toContain("close: toonFactoryClose,");
  });
});

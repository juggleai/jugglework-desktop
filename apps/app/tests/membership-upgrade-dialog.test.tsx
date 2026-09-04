import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { setLocale } from "../src/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.ComponentProps<"p">) => <p {...props}>{children}</p>,
  DialogHeader: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: React.ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
}));

let MembershipUpgradeDialog: typeof import("../src/react-app/shell/membership-upgrade-dialog").MembershipUpgradeDialog;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(async () => {
  ({ MembershipUpgradeDialog } = await import("../src/react-app/shell/membership-upgrade-dialog"));
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
});

function installWindow() {
  const values = new Map<string, string>([
    ["jugglework.den.authToken", "tok_test"],
    ["jugglework.den.activeOrgId", "org_personal"],
  ]);
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  target.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  target.location = { origin: "https://desktop.test" };
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  return target;
}

function installDocument(visibilityState: "visible" | "hidden") {
  const target = new EventTarget() as EventTarget & { visibilityState: "visible" | "hidden" };
  target.visibilityState = visibilityState;
  Object.defineProperty(globalThis, "document", { configurable: true, value: target });
  return target;
}

async function waitFor(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function paidClaimOrder() {
  return {
    id: "order_claim",
    organizationId: null,
    targetMode: "new_organization",
    targetKind: "organization",
    plan: "team",
    period: "monthly",
    seats: "3",
    unitAmountFen: "16900",
    totalAmountFen: "50700",
    currency: "CNY",
    allowancePerCycle: "75000",
    quoteKind: "activation",
    status: "paid_pending_activation",
    fulfillmentStatus: "unfulfilled",
    expiresAt: "2026-09-10T12:00:00Z",
    paidAt: "2026-09-03T12:00:00Z",
    fulfilledAt: null,
    nextAction: "create_organization",
    checkout: null,
    paymentCode: null,
  };
}

describe("MembershipUpgradeDialog", () => {
  test("recovers a paid claim, activates the named organization, switches context, and refreshes account state", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [paidClaimOrder()] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({
          orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }],
          activeOrgId: "org_personal",
          activeOrgSlug: "personal",
        }));
        if (url.endsWith("/team-organization")) {
          return new Response(JSON.stringify({ organization: { id: "org_paid", name: "Paid Team", slug: "paid-team", role: "owner", kind: "organization", tier: "team" } }));
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    let refreshed = 0;
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MembershipUpgradeDialog
          open
          onOpenChange={() => undefined}
          currentTier="normal"
          tenantKind="personal"
          organizationId="org_personal"
          organizations={[{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }]}
          canManageBilling
          onFulfilled={async () => { refreshed += 1; }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const input = renderer!.root.findByProps({ "data-testid": "membership-organization-name" });
    await act(async () => input.props.onChange({ target: { value: "Paid Team" } }));
    const action = renderer!.root.findByProps({ "data-testid": "membership-checkout-action" });
    expect(action.props.disabled).toBe(false);
    await act(async () => {
      await action.props.onClick();
    });

    const activation = requests.find((request) => request.url.endsWith("/team-organization"));
    expect(activation?.headers.get("idempotency-key")).toMatch(/^desktop-membership-claim-[0-9a-f]{64}$/);
    expect(activation?.headers.get("x-jugglework-legacy-org-id")).toBeNull();
    expect(JSON.parse(activation?.body ?? "null")).toEqual({ name: "Paid Team" });
    expect(requests.some((request) => request.url.endsWith("/me/active-organization"))).toBe(false);
    expect(refreshed).toBe(1);
  });

  test("switches only to a listed order organization before detail and close", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = {
      ...paidClaimOrder(),
      id: "order_existing",
      organizationId: "org_team",
      targetMode: "existing_tenant",
      targetKind: "organization",
      status: "quoted",
      fulfillmentStatus: "unfulfilled",
      paidAt: null,
      nextAction: "refresh_checkout",
    };
    const events: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({
          orgs: [
            { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
            { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
          ],
          activeOrgId: "org_personal",
        }));
        if (url.endsWith("/billing/orders/order_existing")) {
          events.push("detail");
          return new Response(JSON.stringify(order));
        }
        if (url.endsWith("/billing/orders/order_existing/close")) {
          events.push("close");
          return new Response(JSON.stringify({ ...order, status: "closed", nextAction: "none" }));
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <MembershipUpgradeDialog
          open
          onOpenChange={() => undefined}
          currentTier="normal"
          tenantKind="personal"
          organizationId="org_personal"
          organizations={[
            { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
            { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
          ]}
          canManageBilling
          onSwitchOrganization={async (id) => { events.push(`switch:${id}`); }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(events.slice(0, 2)).toEqual(["switch:org_team", "detail"]);
    const changePlan = renderer!.root.findByProps({ "data-testid": "membership-change-plan" });
    await act(async () => { await changePlan.props.onClick(); });
    expect(events.slice(-2)).toEqual(["switch:org_team", "close"]);
  });

  test("does not probe or switch to an order organization absent from the session organization list", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = { ...paidClaimOrder(), id: "order_foreign", organizationId: "org_foreign", targetMode: "existing_tenant", status: "quoted", paidAt: null, nextAction: "refresh_checkout" };
    const events: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        events.push(url);
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await act(async () => {
      TestRenderer.create(
        <MembershipUpgradeDialog
          open
          onOpenChange={() => undefined}
          currentTier="normal"
          tenantKind="personal"
          organizationId="org_personal"
          organizations={[{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }]}
          onSwitchOrganization={async (id) => { events.push(`switch:${id}`); }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(events).toEqual([]);
  });

  test("restores the original organization when cross-organization detail recovery fails", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = {
      ...paidClaimOrder(),
      id: "order_failed_detail",
      organizationId: "org_team",
      targetMode: "existing_tenant",
      targetKind: "organization",
      status: "quoted",
      paidAt: null,
      nextAction: "refresh_checkout",
    };
    const switches: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({
          orgs: [
            { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
            { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
          ],
          activeOrgId: "org_personal",
        }));
        if (url.endsWith("/billing/orders/order_failed_detail")) return new Response("{}", { status: 403 });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await act(async () => {
      TestRenderer.create(
        <MembershipUpgradeDialog
          open
          onOpenChange={() => undefined}
          currentTier="normal"
          tenantKind="personal"
          organizationId="org_personal"
          organizations={[
            { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
            { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
          ]}
          onSwitchOrganization={async (id) => { switches.push(id); }}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(switches).toEqual(["org_team", "org_personal"]);
  });

  test("restores the original organization when a target switch commits and then rejects", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = { ...paidClaimOrder(), id: "order_ambiguous_switch", organizationId: "org_team", targetMode: "existing_tenant", status: "quoted", paidAt: null, nextAction: "refresh_checkout" };
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [
          { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
          { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
        ], activeOrgId: "org_personal" }));
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const switches: string[] = [];
    await act(async () => {
      TestRenderer.create(<MembershipUpgradeDialog
        open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal"
        organizations={[
          { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
          { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
        ]}
        onSwitchOrganization={async (id) => {
          switches.push(id);
          if (id === "org_team") throw new Error("response lost after commit");
        }}
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(switches).toEqual(["org_team", "org_personal"]);
  });

  test("keeps every paid claim in the 100-order recovery result accessible", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const claims = ["order_claim_1", "order_claim_2", "order_claim_3"].map((id) => ({ ...paidClaimOrder(), id }));
    let listUrl = "";
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) { listUrl = url; return new Response(JSON.stringify({ orders: claims })); }
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-orders" })).toHaveLength(1)));
    expect(listUrl).toContain("limit=100");
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-orders" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-order-order_claim_2" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-order-order_claim_3" })).toHaveLength(1);
    await act(async () => renderer!.root.findByProps({ "data-testid": "membership-recovery-order-order_claim_2" }).props.onClick());
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-order-order_claim_1" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-order-order_claim_3" })).toHaveLength(1);
  });

  test("recovers a paid claim without active organization settings or a working organization directory", async () => {
    const windowTarget = installWindow();
    windowTarget.localStorage.removeItem("jugglework.den.activeOrgId");
    setLocale("en");
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [paidClaimOrder()] }));
        if (url.endsWith("/me/orgs")) return new Response("unavailable", { status: 503 });
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId={null} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(renderer!.root.findAllByProps({ "data-testid": "membership-organization-name" })).toHaveLength(1)));
    expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.children).toBeTruthy();
  });

  test("keeps all 100 recovery orders scrollable and continues after the first detail fails", async () => {
    installWindow();
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const orders = Array.from({ length: 100 }, (_, index) => ({
      ...paidClaimOrder(),
      id: `order_recovery_${index}`,
      organizationId: "org_personal",
      targetMode: "existing_tenant",
      targetKind: "personal",
      plan: "pro",
      seats: "1",
      unitAmountFen: "9900",
      totalAmountFen: "9900",
      allowancePerCycle: "20000",
      status: "quoted",
      paidAt: null,
      nextAction: "refresh_checkout",
    }));
    const details: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.includes("/billing/orders/order_recovery_")) {
          details.push(url);
          if (url.endsWith("order_recovery_0")) return new Response("forbidden", { status: 403 });
          return new Response(JSON.stringify(orders[1]));
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(details).toHaveLength(2)));
    const selector = renderer!.root.findByProps({ "data-testid": "membership-recovery-orders" });
    expect(selector.props.className).toContain("overflow-y-auto");
    expect(renderer!.root.findAll((node) => String(node.props["data-testid"] ?? "").startsWith("membership-recovery-order-"))).toHaveLength(99);
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-recovery-order-order_recovery_0" })).toHaveLength(1);
  });

  test("pauses polling while hidden and polls immediately when visible", async () => {
    installWindow();
    const documentTarget = installDocument("hidden");
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = { ...paidClaimOrder(), id: "order_poll", organizationId: "org_personal", targetMode: "existing_tenant", targetKind: "personal", plan: "pro", seats: "1", unitAmountFen: "9900", totalAmountFen: "9900", allowancePerCycle: "20000", status: "payment_pending", paidAt: null, nextAction: "refresh_checkout" };
    let details = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_poll")) { details += 1; return new Response(JSON.stringify(order)); }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(details).toBe(1)));
    expect(details).toBe(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    });
    expect(details).toBe(1);
    documentTarget.visibilityState = "visible";
    await act(async () => {
      documentTarget.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(details).toBe(2);
    await act(async () => renderer!.unmount());
  });

  test("opens an admitted checkout in the system browser without treating browser return as payment", async () => {
    const windowTarget = installWindow();
    installDocument("visible");
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const order = { ...paidClaimOrder(), id: "order_open", organizationId: "org_personal", targetMode: "existing_tenant", targetKind: "personal", plan: "pro", seats: "1", unitAmountFen: "9900", totalAmountFen: "9900", allowancePerCycle: "20000", status: "payment_pending", paidAt: null, nextAction: "open_checkout", expiresAt: "2099-09-10T12:00:00Z", checkout: { method: "alipay_page", url: "https://openapi.alipay.com/gateway.do?signed=opaque", status: "pending", expiresAt: "2099-09-10T12:00:00Z" } };
    const opened: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [order] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_open")) return new Response(JSON.stringify(order));
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.disabled).toBe(false), 100));
    windowTarget.__JUGGLEWORK_ELECTRON__ = { shell: { openExternal: async (url: string) => { opened.push(url); return { ok: true }; } } };
    await act(async () => renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.onClick());
    expect(opened).toEqual([order.checkout.url]);
    expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.children).toBeTruthy();
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-change-plan" })).toHaveLength(1);
    await act(async () => renderer!.unmount());
  });

  test("does not resurrect an order when a poll resolves after cancellation", async () => {
    installWindow();
    installDocument("visible");
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const pending = { ...paidClaimOrder(), id: "order_close_race", organizationId: "org_personal", targetMode: "existing_tenant", targetKind: "personal", plan: "pro", seats: "1", unitAmountFen: "9900", totalAmountFen: "9900", allowancePerCycle: "20000", status: "payment_pending", paidAt: null, nextAction: "refresh_checkout" };
    let detailCalls = 0;
    let releasePoll: (() => void) | null = null;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [pending] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_close_race/close")) return new Response(JSON.stringify({ ...pending, status: "closed", nextAction: "none" }));
        if (url.endsWith("/billing/orders/order_close_race")) {
          detailCalls += 1;
          if (detailCalls === 1) return new Response(JSON.stringify(pending));
          await new Promise<void>((resolve) => { releasePoll = resolve; });
          return new Response(JSON.stringify(pending));
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await waitFor(() => expect(detailCalls).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      await waitFor(() => expect(detailCalls).toBe(2));
    });
    await act(async () => renderer!.root.findByProps({ "data-testid": "membership-change-plan" }).props.onClick());
    await act(async () => {
      releasePoll?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renderer!.root.findAllByProps({ "data-testid": "membership-change-plan" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.disabled).toBe(false);
    await act(async () => renderer!.unmount());
  });

  test("does not restart polling after its retry budget is exhausted and visibility changes", async () => {
    installWindow();
    const documentTarget = installDocument("visible");
    setLocale("en");
    const catalog = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const pending = { ...paidClaimOrder(), id: "order_budget", organizationId: "org_personal", targetMode: "existing_tenant", targetKind: "personal", plan: "pro", seats: "1", unitAmountFen: "9900", totalAmountFen: "9900", allowancePerCycle: "20000", status: "payment_pending", paidAt: null, nextAction: "refresh_checkout" };
    let details = 0;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(catalog.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [pending] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_budget")) {
          details += 1;
          if (details === 1) return new Response(JSON.stringify(pending));
          return new Response("unavailable", { status: 503 });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(details).toBe(1)));
    for (let index = 0; index < 3; index += 1) {
      documentTarget.visibilityState = "hidden";
      documentTarget.dispatchEvent(new Event("visibilitychange"));
      documentTarget.visibilityState = "visible";
      await act(async () => {
        documentTarget.dispatchEvent(new Event("visibilitychange"));
        await waitFor(() => expect(details).toBe(index + 2));
      });
    }
    expect(details).toBe(4);
    documentTarget.visibilityState = "hidden";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    documentTarget.visibilityState = "visible";
    await act(async () => {
      documentTarget.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(details).toBe(4);
    await act(async () => renderer!.unmount());
  });

  test("does not open a checkout when payment-attempt creation resolves after the dialog closes", async () => {
    const windowTarget = installWindow();
    installDocument("visible");
    setLocale("en");
    const fixture = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const quoted = { ...fixture.orders.checkoutRefresh, plan: "pro", targetMode: "existing_tenant", targetKind: "personal", period: "annual", seats: "1", unitAmountFen: "94800", totalAmountFen: "94800", currency: "CNY", allowancePerCycle: "20000", quoteKind: "activation", expiresAt: "2099-09-10T12:00:00Z", paidAt: null, fulfilledAt: null, paymentCode: null };
    const checkout = { ...quoted, status: "payment_pending", nextAction: "open_checkout", checkout: { method: "alipay_page", url: "https://openapi.alipay.com/gateway.do?signed=delayed", status: "pending", expiresAt: "2099-09-10T12:00:00Z" } };
    let releaseAttempt: (() => void) | null = null;
    const opened: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(fixture.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [quoted] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [{ id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" }], activeOrgId: "org_personal" }));
        if (url.endsWith(`/billing/orders/${quoted.id}/payment-attempts`)) {
          await new Promise<void>((resolve) => { releaseAttempt = resolve; });
          return new Response(JSON.stringify(checkout));
        }
        if (url.endsWith(`/billing/orders/${quoted.id}`)) return new Response(JSON.stringify(quoted));
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    const props = { onOpenChange: () => undefined, currentTier: "normal" as const, tenantKind: "personal" as const, organizationId: "org_personal" };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog open {...props} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.disabled).toBe(false), 100));
    await act(async () => {
      renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(releaseAttempt).not.toBeNull(), 100);
    windowTarget.__JUGGLEWORK_ELECTRON__ = { shell: { openExternal: async (url: string) => { opened.push(url); return { ok: true }; } } };
    await act(async () => {
      renderer!.update(<MembershipUpgradeDialog open={false} {...props} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      releaseAttempt?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(opened).toEqual([]);
    await act(async () => renderer!.unmount());
  });

  test("stops cross-organization recovery when restoring the original organization fails", async () => {
    installWindow();
    setLocale("en");
    const fixture = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const candidate = (id: string, organizationId: string) => ({ ...paidClaimOrder(), id, organizationId, targetMode: "existing_tenant", targetKind: "organization", status: "quoted", fulfillmentStatus: "unfulfilled", paidAt: null, nextAction: "refresh_checkout" });
    const orders = [candidate("order_first", "org_team"), candidate("order_second", "org_other")];
    const events: string[] = [];
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(fixture.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [
          { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
          { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
          { id: "org_other", name: "Other", slug: "other", role: "owner", kind: "organization", tier: "team" },
        ], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_first")) { events.push("detail:first"); return new Response("forbidden", { status: 403 }); }
        if (url.endsWith("/billing/orders/order_second")) { events.push("detail:second"); return new Response(JSON.stringify(orders[1])); }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    await act(async () => {
      TestRenderer.create(<MembershipUpgradeDialog
        open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal"
        organizations={[]}
        onSwitchOrganization={async (id) => {
          events.push(`switch:${id}`);
          if (id === "org_personal") throw new Error("restore failed");
        }}
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(events).toEqual(["switch:org_team", "detail:first", "switch:org_personal"]);
  });

  test("restores the original organization when opening a newly generated checkout fails", async () => {
    const windowTarget = installWindow();
    installDocument("visible");
    setLocale("en");
    const fixture = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();
    const quoted = { ...paidClaimOrder(), id: "order_browser_fail", organizationId: "org_team", targetMode: "existing_tenant", targetKind: "organization", status: "quoted", fulfillmentStatus: "unfulfilled", paidAt: null, nextAction: "refresh_checkout", expiresAt: "2099-09-10T12:00:00Z" };
    const checkout = { ...quoted, status: "payment_pending", nextAction: "open_checkout", checkout: { method: "alipay_page", url: "https://openapi.alipay.com/gateway.do?signed=fail", status: "pending", expiresAt: "2099-09-10T12:00:00Z" } };
    const switches: string[] = [];
    let releaseAttempt: (() => void) | null = null;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/billing/catalog")) return new Response(JSON.stringify(fixture.catalog));
        if (url.includes("/billing/orders?")) return new Response(JSON.stringify({ orders: [quoted] }));
        if (url.endsWith("/me/orgs")) return new Response(JSON.stringify({ orgs: [
          { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
          { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
        ], activeOrgId: "org_personal" }));
        if (url.endsWith("/billing/orders/order_browser_fail")) return new Response(JSON.stringify(quoted));
        if (url.endsWith("/billing/orders/order_browser_fail/payment-attempts")) {
          await new Promise<void>((resolve) => { releaseAttempt = resolve; });
          return new Response(JSON.stringify(checkout));
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<MembershipUpgradeDialog
        open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal"
        organizations={[
          { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
          { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
        ]}
        onSwitchOrganization={async (id) => { switches.push(id); }}
      />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => waitFor(() => expect(renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.disabled).toBe(false)));
    await act(async () => renderer!.update(<MembershipUpgradeDialog
      open onOpenChange={() => undefined} currentTier="normal" tenantKind="personal" organizationId="org_personal"
      organizations={[
        { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "normal" },
        { id: "org_team", name: "Team", slug: "team", role: "owner", kind: "organization", tier: "team" },
      ]}
      onSwitchOrganization={async (id) => { switches.push(id); }}
    />));
    switches.length = 0;
    await act(async () => {
      renderer!.root.findByProps({ "data-testid": "membership-checkout-action" }).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(releaseAttempt).not.toBeNull(), 100);
    windowTarget.__JUGGLEWORK_ELECTRON__ = { shell: { openExternal: async () => ({ ok: false, error: "browser failed" }) } };
    await act(async () => {
      releaseAttempt?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(switches).toEqual(["org_team", "org_personal"]);
    expect(renderer!.root.findAll((node) => node.type === "p" && String(node.props.children).includes("browser failed")).length).toBeGreaterThan(0);
    await act(async () => renderer!.unmount());
  });
});

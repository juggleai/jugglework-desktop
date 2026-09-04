import { afterEach, describe, expect, test } from "bun:test";

import {
  createMembershipClaimIdempotencyKey,
  createDenClient,
  DenApiError,
  isAllowedAlipayCheckoutUrl,
  isMembershipCheckoutOpenable,
  isRetryableMembershipPollingError,
  normalizeDenMembershipBillingCatalog,
  normalizeDenMembershipOrder,
} from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

function setFetch(fetchImpl: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
}

function pageOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_page_1",
    organizationId: "org_personal",
    targetMode: "existing_tenant",
    targetKind: "personal",
    plan: "pro",
    period: "annual",
    seats: "1",
    unitAmountFen: "94800",
    totalAmountFen: "94800",
    currency: "CNY",
    allowancePerCycle: "20000",
    quoteKind: "activation",
    status: "payment_pending",
    fulfillmentStatus: "unfulfilled",
    expiresAt: "2026-09-03T12:15:00Z",
    paidAt: null,
    fulfilledAt: null,
    nextAction: "open_checkout",
    checkout: {
      method: "alipay_page",
      url: "https://openapi.alipay.com/gateway.do?signed=opaque",
      status: "pending",
      expiresAt: "2026-09-03T12:15:00Z",
      futureCheckoutField: { ignored: true },
    },
    paymentCode: null,
    futureOrderField: ["ignored"],
    ...overrides,
  };
}

const fixture = await Bun.file(new URL("./fixtures/desktop-billing-contract-v2.json", import.meta.url)).json();

afterEach(() => setFetch(originalFetch));

describe("Den membership billing parsers", () => {
  test("decodes the synchronized server v2 fixture and preserves decimal-string money", () => {
    const payload = structuredClone(fixture.catalog);
    payload.plans[1].annualAmountFen = "9223372036854775807";
    payload.plans[1].futureLabel = "ignored";
    payload.futureCatalogField = true;
    const catalog = normalizeDenMembershipBillingCatalog(payload);

    expect(catalog).toMatchObject({
      payment: { alipayPageAvailable: true, alipayQrAvailable: false },
      plans: expect.arrayContaining([{ ...catalog?.plans[1], plan: "pro", annualAmountFen: "9223372036854775807", minimumSeats: 1 }]),
    });
    expect(fixture.orders.checkoutPending.organizationId).toBe("org_personal");
    expect(fixture.orders.paidPendingActivation.organizationId).toBeNull();
  });

  test("rejects incomplete, duplicate, wrong-kind, and non-CNY catalogs", () => {
    const missing = structuredClone(fixture.catalog);
    missing.plans.pop();
    const duplicate = structuredClone(fixture.catalog);
    duplicate.plans[4].plan = "team";
    const wrongKind = structuredClone(fixture.catalog);
    wrongKind.plans[1].tenantKind = "organization";
    expect(normalizeDenMembershipBillingCatalog(missing)).toBeNull();
    expect(normalizeDenMembershipBillingCatalog(duplicate)).toBeNull();
    expect(normalizeDenMembershipBillingCatalog(wrongKind)).toBeNull();
    expect(normalizeDenMembershipBillingCatalog({ ...fixture.catalog, currency: "USD" })).toBeNull();
  });

  test("enforces stable catalog semantics while ignoring additive fields", () => {
    const additive = structuredClone(fixture.catalog);
    additive.futureCatalogField = true;
    additive.plans[1].futurePlanField = { ignored: true };
    expect(normalizeDenMembershipBillingCatalog(additive)).not.toBeNull();

    for (const mutate of [
      (catalog: typeof fixture.catalog) => { catalog.plans[0].monthlyAmountFen = "1"; },
      (catalog: typeof fixture.catalog) => { catalog.plans[1].annualAmountFen = "0"; },
      (catalog: typeof fixture.catalog) => { catalog.plans[1].minimumSeats = "2"; },
      (catalog: typeof fixture.catalog) => { catalog.plans[1].pricedPerSeat = true; },
      (catalog: typeof fixture.catalog) => { catalog.plans[3].pricedPerSeat = false; },
      (catalog: typeof fixture.catalog) => { catalog.plans[3].allowancePerCycle = "0"; },
    ]) {
      const invalid = structuredClone(fixture.catalog);
      mutate(invalid);
      expect(normalizeDenMembershipBillingCatalog(invalid)).toBeNull();
    }
  });

  test("parses additive page checkout without reusing the QR field", () => {
    const order = normalizeDenMembershipOrder(pageOrder());

    expect(order).toMatchObject({
      id: "order_page_1",
      organizationId: "org_personal",
      totalAmountFen: "94800",
      nextAction: "open_checkout",
      checkout: { method: "alipay_page", status: "pending" },
      paymentCode: null,
    });
  });

  test("rejects non-decimal or unsafe integer fields", () => {
    for (const value of [94800, "948.00", "+94800", "9.48e4", " 94800", "094800"]) {
      expect(normalizeDenMembershipOrder(pageOrder({ totalAmountFen: value }))).toBeNull();
    }
    expect(normalizeDenMembershipOrder(pageOrder({ seats: "9007199254740992" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ seats: 1 }))).toBeNull();
    const catalogWithNumericMoney = structuredClone(fixture.catalog);
    catalogWithNumericMoney.plans[1].monthlyAmountFen = 9900;
    expect(normalizeDenMembershipBillingCatalog(catalogWithNumericMoney)).toBeNull();
    const catalogWithNumericSeats = structuredClone(fixture.catalog);
    catalogWithNumericSeats.plans[1].minimumSeats = 1;
    expect(normalizeDenMembershipBillingCatalog(catalogWithNumericSeats)).toBeNull();
  });

  test("requires a safe organization scope that matches the target mode", () => {
    const missing = pageOrder();
    delete missing.organizationId;
    expect(normalizeDenMembershipOrder(missing)).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ organizationId: "  " }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ organizationId: null }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({
      organizationId: null,
      targetMode: "new_organization",
      targetKind: "organization",
      plan: "team",
      seats: "3",
      quoteKind: "activation",
    }))).toMatchObject({ organizationId: null, targetMode: "new_organization" });
  });

  test("rejects contradictory target, status, fulfillment, and payment-artifact combinations", () => {
    expect(normalizeDenMembershipOrder(pageOrder({ targetMode: "new_organization", plan: "pro" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ status: "paid_pending_activation", nextAction: "create_organization", checkout: null, paidAt: "2026-09-03T12:01:00Z" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ status: "fulfilled" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ paymentCode: { status: "pending", content: "qr", expiresAt: "2026-09-03T12:15:00Z" } }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ nextAction: "refresh_checkout" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ checkout: { ...pageOrder().checkout as Record<string, unknown>, status: "closed" } }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ expiresAt: "2026-09-03T12:15:00Z", checkout: { ...pageOrder().checkout as Record<string, unknown>, expiresAt: "2026-09-03T12:16:00Z" } }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ expiresAt: "2026-02-30T12:15:00Z" }))).toBeNull();
    expect(normalizeDenMembershipOrder(pageOrder({ expiresAt: "2026-09-03 12:15:00Z" }))).toBeNull();
  });
});

describe("Alipay checkout admission", () => {
  test("accepts only the exact production gateway and explicitly opted-in sandbox gateway", () => {
    expect(isAllowedAlipayCheckoutUrl("https://openapi.alipay.com/gateway.do?signed=opaque")).toBe(true);
    expect(isAllowedAlipayCheckoutUrl("https://openapi-sandbox.dl.alipaydev.com/gateway.do?signed=opaque")).toBe(false);
    expect(isAllowedAlipayCheckoutUrl("https://openapi-sandbox.dl.alipaydev.com/gateway.do?signed=opaque", { allowSandbox: true })).toBe(true);
    for (const url of [
      "https://user@openapi.alipay.com/gateway.do?signed=opaque",
      "https://openapi.alipay.com:444/gateway.do?signed=opaque",
      "https://openapi.alipay.com:443/gateway.do?signed=opaque",
      "https://openapi.alipay.com/gateway.do/extra?signed=opaque",
      "https://openapi.alipay.com/gateway.do?signed=opaque#fragment",
      "https://openapi.alipay.com.example.test/gateway.do?signed=opaque",
      "http://openapi.alipay.com/gateway.do?signed=opaque",
      "https://openapi.alipay.com/gateway.do",
      "https://openapi.alipay.com/gateway.do?",
      `https://openapi.alipay.com/gateway.do?signed=${"x".repeat(4096)}`,
      "https://openapi.alipay.com/gateway.do?signed=opaque\n",
      "\thttps://openapi.alipay.com/gateway.do?signed=opaque",
      "https://openapi.alipay.com/gateway.do?signed=opaque\r",
      "https://openapi.alipay.com/gateway.do?signed=opaque\0",
    ]) expect(isAllowedAlipayCheckoutUrl(url)).toBe(false);
    const prefix = "https://openapi.alipay.com/gateway.do?signed=";
    expect(isAllowedAlipayCheckoutUrl(prefix + "x".repeat(4096 - prefix.length))).toBe(true);
    expect(isAllowedAlipayCheckoutUrl(prefix + "x".repeat(4097 - prefix.length))).toBe(false);
  });

  test("retries only network, timeout, rate-limit, and server polling failures", () => {
    expect(isRetryableMembershipPollingError(new TypeError("offline"))).toBe(true);
    expect(isRetryableMembershipPollingError(new DenApiError(408, "timeout", "timeout"))).toBe(true);
    expect(isRetryableMembershipPollingError(new DenApiError(429, "rate_limited", "slow down"))).toBe(true);
    expect(isRetryableMembershipPollingError(new DenApiError(503, "unavailable", "unavailable"))).toBe(true);
    expect(isRetryableMembershipPollingError(new DenApiError(403, "forbidden", "forbidden"))).toBe(false);
  });

  test("checks both order and checkout expiry immediately before open", () => {
    const now = Date.parse("2026-09-03T12:00:00Z");
    const order = normalizeDenMembershipOrder(pageOrder());
    expect(order && isMembershipCheckoutOpenable(order, now)).toBe(true);
    expect(order && isMembershipCheckoutOpenable(order, Date.parse("2026-09-03T12:15:00Z"))).toBe(false);
    const expiredOrder = normalizeDenMembershipOrder(pageOrder({ expiresAt: "2026-09-03T11:59:59Z" }));
    expect(expiredOrder).toBeNull();
    const expiredCheckout = normalizeDenMembershipOrder(pageOrder({ checkout: { ...pageOrder().checkout as Record<string, unknown>, expiresAt: "2026-09-03T11:59:59Z" } }));
    expect(expiredCheckout && isMembershipCheckoutOpenable(expiredCheckout, now)).toBe(false);
  });
});

describe("paid organization claim idempotency", () => {
  test("is stable across retries and app restarts but changes with the canonical payload", async () => {
    const first = await createMembershipClaimIdempotencyKey("order_claim", " Paid Team ");
    const replay = await createMembershipClaimIdempotencyKey("order_claim", "Paid Team");
    const renamed = await createMembershipClaimIdempotencyKey("order_claim", "Other Team");
    expect(first).toBe(replay);
    expect(first).not.toBe(renamed);
    expect(first).toMatch(/^desktop-membership-claim-[0-9a-f]{64}$/);
    expect(first.length).toBeLessThanOrEqual(128);
  });
});

describe("Den membership billing client", () => {
  test("sends only the order selection with a stable idempotency header", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
    setFetch(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: String(init?.body ?? ""),
      });
      return new Response(JSON.stringify(pageOrder({ status: "quoted", nextAction: "refresh_checkout", checkout: null })));
    });

    const client = createDenClient({ baseUrl: "https://den.test", token: "tok_test" });
    await client.createMembershipOrder("org_personal", {
      targetMode: "existing_tenant",
      plan: "pro",
      period: "annual",
      seats: 1,
    }, "desktop-membership-order-stable");

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://den.test/jwork/api/v1/billing/orders");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers.get("idempotency-key")).toBe("desktop-membership-order-stable");
    expect(requests[0].headers.get("x-jugglework-legacy-org-id")).toBe("org_personal");
    expect(JSON.parse(requests[0].body)).toEqual({
      targetMode: "existing_tenant",
      plan: "pro",
      period: "annual",
      seats: 1,
    });
  });

  test("creates a page payment attempt with an empty body and relies on server reservation idempotency", async () => {
    let captured: { url: string; headers: Headers; body: BodyInit | null | undefined } | null = null;
    setFetch(async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers), body: init?.body };
      return new Response(JSON.stringify(pageOrder({ id: "order/page 1" })));
    });

    const previous = normalizeDenMembershipOrder(pageOrder({ id: "order/page 1", status: "quoted", nextAction: "refresh_checkout", checkout: null }))!;
    const order = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" })
      .createMembershipPaymentAttempt("org_personal", "order/page 1", previous);

    expect(captured?.url).toBe("https://den.test/jwork/api/v1/billing/orders/order%2Fpage%201/payment-attempts");
    expect(captured?.headers.get("idempotency-key")).toBeNull();
    expect(captured?.body).toBeUndefined();
    expect(order.nextAction).toBe("open_checkout");
    expect(order.checkout?.url).toStartWith("https://openapi.alipay.com/");
  });

  test("closes an unpaid order and activates a paid team with the correct scopes", async () => {
    const requests: Array<{ url: string; headers: Headers; body: string }> = [];
    setFetch(async (input, init) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      if (url.endsWith("/close")) {
        return new Response(JSON.stringify(pageOrder({ id: "order/page 1", status: "closed", nextAction: "none", checkout: null })));
      }
      return new Response(JSON.stringify({
        organization: { id: "org_paid", name: "Paid Team", slug: "paid-team", role: "owner", kind: "organization", tier: "team" },
      }));
    });
    const client = createDenClient({ baseUrl: "https://den.test", token: "tok_test" });
    await client.closeMembershipOrder("org_personal", "order/page 1", normalizeDenMembershipOrder(pageOrder({ id: "order/page 1" }))!);
    const organization = await client.activatePaidTeamOrganization("order/claim 1", "Paid Team", "desktop-membership-claim-stable");

    expect(requests[0].url).toEndWith("/billing/orders/order%2Fpage%201/close");
    expect(requests[0].headers.get("x-jugglework-legacy-org-id")).toBe("org_personal");
    expect(requests[1].url).toEndWith("/billing/orders/order%2Fclaim%201/team-organization");
    expect(requests[1].headers.get("x-jugglework-legacy-org-id")).toBeNull();
    expect(requests[1].headers.get("idempotency-key")).toBe("desktop-membership-claim-stable");
    expect(JSON.parse(requests[1].body)).toEqual({ name: "Paid Team" });
    expect(organization).toMatchObject({ id: "org_paid", role: "owner", tier: "team" });
  });

  test("rejects valid-looking responses that do not match the requested selection or immutable order", async () => {
    const client = createDenClient({ baseUrl: "https://den.test", token: "tok_test" });
    setFetch(async () => new Response(JSON.stringify(pageOrder({ status: "quoted", nextAction: "refresh_checkout", checkout: null, plan: "power" }))));
    await expect(client.createMembershipOrder("org_personal", {
      targetMode: "existing_tenant", plan: "pro", period: "annual", seats: 1,
    }, "desktop-membership-order-stable")).rejects.toMatchObject({ code: "invalid_billing_order_payload" });

    const previous = normalizeDenMembershipOrder(pageOrder({ status: "quoted", nextAction: "refresh_checkout", checkout: null }))!;
    setFetch(async () => new Response(JSON.stringify(pageOrder({ id: "other_order", status: "quoted", nextAction: "refresh_checkout", checkout: null }))));
    await expect(client.getMembershipOrder("org_personal", previous.id, previous)).rejects.toMatchObject({ code: "invalid_billing_order_payload" });

    setFetch(async () => new Response(JSON.stringify(pageOrder({ totalAmountFen: "99900" }))));
    await expect(client.createMembershipPaymentAttempt("org_personal", previous.id, previous)).rejects.toMatchObject({ code: "invalid_billing_order_payload" });
  });
});

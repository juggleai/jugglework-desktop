import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

function setFetch(fetchImpl: typeof fetch) {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });
}

afterEach(() => setFetch(originalFetch));

describe("Den tenant account client", () => {
  test("parses organization tiers from the directory", async () => {
    setFetch(async () => new Response(JSON.stringify({
      activeOrgId: "org_team",
      activeOrgSlug: "team",
      orgs: [
        { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "pro", accountStatus: "active" },
        { id: "org_team", name: "Studio", slug: "team", role: "admin", kind: "organization", tier: "business", accountStatus: "active" },
      ],
    }), { headers: { "content-type": "application/json" } }));

    const result = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).listOrgs();
    expect(result.orgs).toEqual([
      { id: "org_personal", name: "Personal", slug: "personal", role: "owner", kind: "personal", tier: "pro", accountStatus: "active" },
      { id: "org_team", name: "Studio", slug: "team", role: "admin", kind: "organization", tier: "business", accountStatus: "active" },
    ]);
  });

  test("loads the active tenant tier and points with the organization scope", async () => {
    let captured: { url: string; organizationId: string | null } | null = null;
    setFetch(async (input, init) => {
      const headers = new Headers(init?.headers);
      captured = { url: String(input), organizationId: headers.get("x-jugglework-legacy-org-id") };
      return new Response(JSON.stringify({
        kind: "personal",
        tier: "power",
        status: "active",
        tierVersion: 3,
        points: { available: 1280, reserved: 20, version: 8 },
        permissions: { canViewLedger: true, canManageBilling: false },
      }), { headers: { "content-type": "application/json" } });
    });

    const account = await createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).getTenantAccount("org_personal");
    expect(captured).toEqual({
      url: "https://den.test/jwork/api/v1/tenant-account",
      organizationId: "org_personal",
    });
    expect(account).toMatchObject({ tier: "power", points: { available: 1280 } });
  });

  test("rejects a tier that does not belong to the tenant kind", async () => {
    setFetch(async () => new Response(JSON.stringify({
      kind: "personal",
      tier: "business",
      status: "active",
      tierVersion: 1,
      points: { available: 1000, reserved: 0, version: 1 },
      permissions: { canViewLedger: true, canManageBilling: false },
    }), { headers: { "content-type": "application/json" } }));

    await expect(
      createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).getTenantAccount("org_personal"),
    ).rejects.toMatchObject({ code: "invalid_tenant_account_payload" });
  });
});

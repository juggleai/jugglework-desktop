import { describe, expect, test } from "bun:test";
import {
  buildCloudImportedProvider,
  buildRuntimeProviderPatch,
  filterImportableCloudOrgProviders,
  gatewayMirrorEnvName,
  isCloudProviderOutOfSync,
  resolveCloudProviderCredentials,
  type CloudProviderConnection,
} from "../src/index";

const provider: CloudProviderConnection = {
  id: "lpr_router",
  source: "juggle_router",
  providerId: "JuggleRouter",
  name: "JuggleRouter",
  providerConfig: {
    env: ["PRIMARY_KEY", "SECONDARY_KEY"],
    api: "https://gateway.example.test/v1",
  },
  enabled: true,
  models: [{ id: "model-a", name: "Model A", config: { reasoning: true } }],
  updatedAt: "2026-09-22T00:00:00Z",
  apiKeys: { SECONDARY_KEY: "secondary", PRIMARY_KEY: "primary" },
};

describe("shared cloud provider transformations", () => {
  test("resolves ordered credentials and gateway environment names", () => {
    expect(resolveCloudProviderCredentials(provider)).toEqual({
      envEntries: [
        { key: "PRIMARY_KEY", value: "primary" },
        { key: "SECONDARY_KEY", value: "secondary" },
      ],
      primaryApiKey: "primary",
    });
    const owner = { workspaceId: "ws", organizationId: "org", cloudProviderId: "lpr-router.1" };
    expect(gatewayMirrorEnvName(owner)).toMatch(/^MCP_GATEWAY_KEY_V2_/);
    expect(gatewayMirrorEnvName({ ...owner, cloudProviderId: "lpr.router.1" })).not.toBe(gatewayMirrorEnvName(owner));
    expect(gatewayMirrorEnvName({ ...owner, cloudProviderId: "" })).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });

  test("builds a runtime patch and compatible import baseline", () => {
    const mirror = { workspaceId: "ws", organizationId: "org_current", cloudProviderId: provider.id, key: "MCP_GATEWAY_KEY_V2_owner" };
    const baseline = buildCloudImportedProvider(provider, 123, "org_current", mirror);
    expect(buildRuntimeProviderPatch(provider, provider.id, "lpr_previous")).toEqual({
      lpr_previous: null,
      lpr_router: {
        id: "JuggleRouter",
        name: "JuggleRouter",
        env: ["PRIMARY_KEY", "SECONDARY_KEY"],
        api: "https://gateway.example.test/v1",
        models: {
          "model-a": { id: "model-a", name: "Model A", reasoning: true },
        },
      },
    });
    expect(isCloudProviderOutOfSync(provider, baseline)).toBe(false);
    expect(baseline).toMatchObject({ metadataVersion: 10, organizationId: "org_current", gatewayMirror: mirror });
    expect(isCloudProviderOutOfSync(provider, baseline, "org_current")).toBe(false);
    expect(isCloudProviderOutOfSync(provider, baseline, "org_other")).toBe(true);
    expect(isCloudProviderOutOfSync(provider, { ...baseline, metadataVersion: 9 }, "org_current")).toBe(true);
  });

  test("filters disabled and built-in hosted providers", () => {
    expect(filterImportableCloudOrgProviders([
      { ...provider, id: "disabled", enabled: false },
      { ...provider, id: "hosted", source: "jugglework" },
      provider,
    ])).toEqual([provider]);
  });

  test("requires an owned mirror when the effective provider uses the reserved gateway alias", () => {
    const gateway = { ...provider, providerConfig: { ...provider.providerConfig, env: ["JUGGLEWORK_GATEWAY_KEY_LPR_ROUTER"] } };
    const withoutMirror = buildCloudImportedProvider(gateway, 1, "org");
    expect(isCloudProviderOutOfSync(gateway, withoutMirror, "org")).toBe(true);
    const mirror = { workspaceId: "ws", organizationId: "org", cloudProviderId: gateway.id, key: gatewayMirrorEnvName({ workspaceId: "ws", organizationId: "org", cloudProviderId: gateway.id }) };
    expect(isCloudProviderOutOfSync(gateway, buildCloudImportedProvider(gateway, 1, "org", mirror), "org")).toBe(false);
  });
});

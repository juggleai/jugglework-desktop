import { describe, expect, test } from "bun:test";
import {
  buildCloudImportedProvider,
  buildCloudProviderConfig,
  CLOUD_PROVIDER_METADATA_VERSION,
  buildRuntimeProviderPatch,
  filterImportableCloudOrgProviders,
  gatewayMirrorEnvName,
  isCloudProviderOutOfSync,
  isManagedJWorkRouter,
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
  test("requires serving-model billing support for managed imports, including old servers", () => {
    const model = (managed: boolean, billing?: unknown, catalogBilling?: unknown) =>
      buildCloudProviderConfig({ ...provider, managed, models: [{ id: "media", name: "Media", config: {
        imageGeneration: { textToImage: true }, ...(billing === undefined ? {} : { managedMediaBilling: billing }),
      } }] }, { JuggleRouter: { media: { managedMediaBilling: catalogBilling } } }).models?.media;
    const affirmative = { version: 1, supported: true, required: false };
    expect(model(true, affirmative)?.managedMediaBilling).toEqual({ version: 1, supported: true, required: true });
    expect(model(true, undefined, affirmative)?.managedMediaBilling).toEqual({ version: 1, supported: false, required: true, reason: "managed_media_billing_unavailable" });
    expect(model(true, { version: 1, supported: false, reason: "managed_media_backend_unavailable" })?.managedMediaBilling).toMatchObject({ supported: false, reason: "managed_media_backend_unavailable" });
    for (const billing of [{ version: 2, supported: true }, { version: 1, supported: "true" }, null]) {
      expect(model(true, billing)?.managedMediaBilling).toMatchObject({ required: true, supported: false });
    }
    expect(model(false, affirmative)?.managedMediaBilling).toBeUndefined();
    expect(model(false, { required: true, version: 1, supported: false })?.managedMediaBilling).toBeUndefined();
    const rawProvider = { ...provider, managed: true, providerConfig: { models: { media: { managedMediaBilling: affirmative } } }, models: [{ id: "media", name: "Media" }] };
    expect(buildCloudProviderConfig(rawProvider).models?.media.managedMediaBilling).toMatchObject({ required: true, supported: false });
  });

  test("distinguishes managed JWorkRouter from ordinary JuggleRouter", () => {
    expect(isManagedJWorkRouter({ source: "juggle_router", managedKind: "juggle_router" })).toBe(true);
    expect(isManagedJWorkRouter({ source: "juggle_router", managedIdentity: "jwork_router" })).toBe(true);
    expect(isManagedJWorkRouter({ source: "juggle_router", managedKind: "juggle_router", managedIdentity: null })).toBe(false);
    expect(isManagedJWorkRouter({ source: "models_dev", managedIdentity: null })).toBe(false);
  });
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
    expect(baseline).toMatchObject({ metadataVersion: CLOUD_PROVIDER_METADATA_VERSION, organizationId: "org_current", gatewayMirror: mirror });
    expect(isCloudProviderOutOfSync(provider, baseline, "org_current")).toBe(false);
    expect(isCloudProviderOutOfSync(provider, baseline, "org_other")).toBe(true);
    expect(isCloudProviderOutOfSync(provider, { ...baseline, metadataVersion: 10 }, "org_current")).toBe(true);
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

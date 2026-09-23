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
    expect(gatewayMirrorEnvName("lpr-router.1")).toBe("MCP_GATEWAY_KEY_LPR_ROUTER_1");
  });

  test("builds a runtime patch and compatible import baseline", () => {
    const baseline = buildCloudImportedProvider(provider, 123);
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
  });

  test("filters disabled and built-in hosted providers", () => {
    expect(filterImportableCloudOrgProviders([
      { ...provider, id: "disabled", enabled: false },
      { ...provider, id: "hosted", source: "jugglework" },
      provider,
    ])).toEqual([provider]);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import type { CloudProviderConnection } from "@jugglework/cloud-provider";
import type { JuggleWorkApiClient, RuntimeProviderStatus } from "../src/api.js";
import type { CloudClient } from "../src/cloud-client.js";
import { importProvider, ProviderMutationError } from "../src/provider-command.js";

const provider: CloudProviderConnection = {
  id: "lpr_publication", providerId: "openai-compatible", name: "Managed Provider",
  providerConfig: { env: ["MANAGED_API_KEY"], api: "https://models.example/v1" },
  apiKey: "secret-primary", apiKeys: { MANAGED_API_KEY: "secret-env" },
  models: [{ id: "model-a", name: "Model A" }],
};
const visible: RuntimeProviderStatus = {
  providerId: provider.id, published: null, imported: true, loaded: true, authenticated: true, enabled: true,
  models: [{ id: "model-a", published: null, imported: true, loaded: true, authenticated: true, enabled: true, verifiedExecutable: null }],
};

function harness(failAt?: string) {
  const calls: string[] = [];
  const invoke = async <T>(name: string, value: T): Promise<T> => {
    calls.push(name);
    if (name === failAt) throw new Error(`failed-${name}-secret-primary`);
    return value;
  };
  const cloud = { providerConnection: () => invoke("connection", provider), catalog: () => invoke("catalog", {}) } as unknown as CloudClient;
  const runtime = {
    preflightProviderAuthority: () => invoke("host_authority", { ok: true as const }),
    getCloudProviderImport: () => invoke("read_baseline", { item: null }),
    upsertUserEnvironment: () => invoke("environment", { ok: true as const, count: 2 }),
    setProviderAuth: () => invoke("authentication", { ok: true as const }),
    patchWorkspaceConfig: () => invoke("runtime_config", { updatedAt: 1 }),
    setCloudProviderImport: () => invoke("baseline", { ok: true as const, item: {} }),
    reloadEngine: () => invoke("reload", { ok: true as const, reloadedAt: 1 }),
    providerStatus: () => invoke("verification", visible),
  } as unknown as JuggleWorkApiClient;
  return { calls, cloud, runtime };
}

test("preflights host authority before fetching provider credentials", async () => {
  const { calls, cloud, runtime } = harness("host_authority");
  await assert.rejects(
    importProvider({ cloud, runtime, token: "cloud", organizationId: "org", workspaceId: "ws", cloudProviderId: provider.id }),
    (error: unknown) => error instanceof ProviderMutationError && error.stage === "host_authority" && error.completedStages.length === 0,
  );
  assert.deepEqual(calls, ["host_authority"]);
});

test("rejects a disabled or mismatched publication before writing runtime credentials", async () => {
  for (const candidate of [{ ...provider, enabled: false }, { ...provider, id: "another-publication" }, { ...provider, id: "manual", source: "custom" }]) {
    const { calls, cloud, runtime } = harness();
    cloud.providerConnection = async () => { calls.push("connection"); return candidate; };
    await assert.rejects(
      importProvider({ cloud, runtime, token: "cloud", organizationId: "org", workspaceId: "ws", cloudProviderId: provider.id }),
      (error: unknown) => error instanceof ProviderMutationError && error.stage === "connection",
    );
    assert.deepEqual(calls, ["host_authority", "connection"]);
  }
});

for (const failedCall of ["connection", "environment", "authentication", "catalog", "runtime_config", "baseline", "reload", "verification"]) {
  test(`reports redacted retryable partial state when ${failedCall} fails`, async () => {
    const { calls, cloud, runtime } = harness(failedCall);
    await assert.rejects(
      importProvider({ cloud, runtime, token: "cloud", organizationId: "org", workspaceId: "ws", cloudProviderId: provider.id }),
      (error: unknown) => {
        assert.ok(error instanceof ProviderMutationError);
        assert.doesNotMatch(error.message, /secret-primary|secret-env/);
        assert.match(error.message, /Safe retry/);
        return true;
      },
    );
    assert.equal(calls.at(-1), failedCall);
  });
}

test("retries idempotently and writes a Desktop-compatible baseline", async () => {
  const { calls, cloud, runtime } = harness();
  const baselines: JsonRecord[] = [];
  runtime.setCloudProviderImport = async (_workspaceId, cloudProviderId, item) => {
    baselines.push(item);
    calls.push("baseline");
    assert.equal(cloudProviderId, provider.id);
    return { ok: true, item };
  };
  await importProvider({ cloud, runtime, token: "cloud", organizationId: "org", workspaceId: "ws", cloudProviderId: provider.id });
  await importProvider({ cloud, runtime, token: "cloud", organizationId: "org", workspaceId: "ws", cloudProviderId: provider.id });
  const baseline = baselines.at(-1);
  assert.ok(baseline);
  assert.equal(baseline.cloudProviderId, provider.id);
  assert.equal(baseline.providerId, provider.id);
  assert.equal(baseline.sourceProviderId, provider.providerId);
  assert.deepEqual(baseline.modelIds, ["model-a"]);
  assert.equal(baseline.metadataVersion, 8);
  assert.equal(calls.filter((call) => call === "verification").length, 2);
});

type JsonRecord = Record<string, unknown>;

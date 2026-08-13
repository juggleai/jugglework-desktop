import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ANTHROPIC_API_KEY_SECRET,
  AWS_ACCESS_KEY_ID_SECRET,
  AWS_BEARER_TOKEN_BEDROCK_SECRET,
  AWS_SECRET_ACCESS_KEY_SECRET,
  AWS_SESSION_TOKEN_SECRET,
  CLAUDE_GATEWAY_CREDENTIAL_SECRET,
  FOUNDRY_AUTH_TOKEN_SECRET,
  AnthropicByokCredentialBroker,
  ApprovedGatewayCredentialBroker,
  AwsBedrockCredentialBroker,
  ClaudeCredentialError,
  GoogleVertexCredentialBroker,
  MicrosoftFoundryCredentialBroker,
  RolloutGatedClaudeCredentialBroker,
  type ClaudeSecretName,
  type ClaudeSecretProvider,
} from "./claude-credentials.js";
import { ClaudeAdvancedRollout, claudeAdvancedFeatureEnvironment } from "./claude-advanced-rollout.js";

const FIXTURE_SECRET = "fixture-only-not-a-real-credential";

function secrets(values: Partial<Record<ClaudeSecretName, string>>): ClaudeSecretProvider {
  return { getSecret: async (name) => values[name] ?? null };
}

describe("Claude credential brokers", () => {
  test("leases Anthropic BYOK without exposing it in readiness state", async () => {
    const broker = new AnthropicByokCredentialBroker(secrets({ [ANTHROPIC_API_KEY_SECRET]: FIXTURE_SECRET }));

    expect(await broker.readiness()).toEqual({
      ready: true,
      reasonCode: "credential_ready",
      provider: "anthropic",
      authMethod: "api_key",
    });
    expect(JSON.stringify(await broker.readiness())).not.toContain(FIXTURE_SECRET);
    const lease = await broker.acquire();
    expect(lease.environment).toEqual({ ANTHROPIC_API_KEY: FIXTURE_SECRET });
    expect(lease.diagnostic).toEqual({ provider: "anthropic", authMethod: "api_key" });
    await lease.release();
    expect(lease.environment).toEqual({});
    await lease.release();
  });

  test("maps missing and unavailable stores to stable non-secret errors", async () => {
    const missing = new AnthropicByokCredentialBroker(secrets({}));
    await expect(missing.acquire()).rejects.toBeInstanceOf(ClaudeCredentialError);
    expect(await missing.readiness()).toMatchObject({ ready: false, reasonCode: "credential_missing" });

    const unavailable: ClaudeSecretProvider = { getSecret: async () => { throw new Error("keychain failed"); } };
    const broker = new AnthropicByokCredentialBroker(unavailable);
    expect(await broker.readiness()).toMatchObject({ ready: false, reasonCode: "credential_store_unavailable" });
    await expect(broker.acquire()).rejects.toMatchObject({ code: "credential_store_unavailable" });
  });

  test("requires an allowlisted HTTPS gateway origin and emits the official gateway contract", async () => {
    const broker = new ApprovedGatewayCredentialBroker(
      secrets({ [CLAUDE_GATEWAY_CREDENTIAL_SECRET]: FIXTURE_SECRET }),
      {
        baseUrl: "https://gateway.example.test/anthropic",
        credentialType: "bearer_token",
        policy: { approvedProviders: ["gateway"], approvedGatewayOrigins: ["https://gateway.example.test"] },
      },
    );
    expect(await broker.readiness()).toMatchObject({ ready: true, provider: "gateway", authMethod: "bearer_token" });
    expect((await broker.acquire()).environment).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example.test/anthropic",
      ANTHROPIC_AUTH_TOKEN: FIXTURE_SECRET,
    });

    const denied = new ApprovedGatewayCredentialBroker(secrets({ [CLAUDE_GATEWAY_CREDENTIAL_SECRET]: FIXTURE_SECRET }), {
      baseUrl: "https://unapproved.example.test",
      credentialType: "api_key",
      policy: { approvedProviders: ["gateway"], approvedGatewayOrigins: ["https://gateway.example.test"] },
    });
    expect(await denied.readiness()).toMatchObject({ ready: false, reasonCode: "provider_configuration_invalid" });
    await expect(denied.acquire()).rejects.toMatchObject({ code: "provider_configuration_invalid" });
  });

  test("supports Bedrock bearer and temporary access-key contracts", async () => {
    const bearer = new AwsBedrockCredentialBroker(secrets({ [AWS_BEARER_TOKEN_BEDROCK_SECRET]: FIXTURE_SECRET }), {
      region: "us-east-1",
      authMethod: "bearer_token",
      policy: { approvedProviders: ["bedrock"] },
    });
    expect((await bearer.acquire()).environment).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: FIXTURE_SECRET,
    });

    const accessKey = new AwsBedrockCredentialBroker(secrets({
      [AWS_ACCESS_KEY_ID_SECRET]: "FIXTUREACCESSID0000",
      [AWS_SECRET_ACCESS_KEY_SECRET]: "fixture-secret-key-not-real",
      [AWS_SESSION_TOKEN_SECRET]: "fixture-session-token-not-real",
    }), {
      region: "eu-west-1",
      authMethod: "access_key",
      policy: { approvedProviders: ["bedrock"] },
    });
    expect((await accessKey.acquire()).environment).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "FIXTUREACCESSID0000",
      AWS_SECRET_ACCESS_KEY: "fixture-secret-key-not-real",
      AWS_SESSION_TOKEN: "fixture-session-token-not-real",
    });
  });

  test("restricts Vertex ADC files to an approved host-owned root", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "jugglework-vertex-broker-"));
    const root = join(fixtureRoot, "secure");
    const outside = join(fixtureRoot, "workspace-fixture.json");
    const credentialPath = join(root, "vertex-adc.json");
    const linkPath = join(root, "escaped-adc.json");
    try {
      await mkdir(root);
      await writeFile(credentialPath, "fixture-only-not-a-real-adc");
      await writeFile(outside, "fixture-only-not-a-real-adc");
      await symlink(outside, linkPath);
      const broker = new GoogleVertexCredentialBroker({
        projectId: "fixture-project",
        region: "global",
        applicationCredentialsPath: credentialPath,
        policy: { approvedProviders: ["vertex"], approvedCredentialRoots: [root] },
      });
      expect((await broker.acquire()).environment).toEqual({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "global",
        ANTHROPIC_VERTEX_PROJECT_ID: "fixture-project",
        GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
      });

      const escaped = new GoogleVertexCredentialBroker({
        projectId: "fixture-project",
        region: "global",
        applicationCredentialsPath: linkPath,
        policy: { approvedProviders: ["vertex"], approvedCredentialRoots: [root] },
      });
      expect(await escaped.readiness()).toMatchObject({ ready: false, reasonCode: "provider_configuration_invalid" });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  test("validates Foundry endpoint choice and emits bearer auth", async () => {
    const broker = new MicrosoftFoundryCredentialBroker(secrets({ [FOUNDRY_AUTH_TOKEN_SECRET]: FIXTURE_SECRET }), {
      baseUrl: "https://fixture-resource.services.ai.azure.com/anthropic",
      authMethod: "bearer_token",
      policy: { approvedProviders: ["foundry"], approvedFoundryOrigins: ["https://fixture-resource.services.ai.azure.com"] },
    });
    expect((await broker.acquire()).environment).toEqual({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://fixture-resource.services.ai.azure.com/anthropic",
      ANTHROPIC_FOUNDRY_AUTH_TOKEN: FIXTURE_SECRET,
    });

    const invalid = new MicrosoftFoundryCredentialBroker(secrets({ [FOUNDRY_AUTH_TOKEN_SECRET]: FIXTURE_SECRET }), {
      resource: "fixture-resource",
      baseUrl: "https://fixture-resource.services.ai.azure.com/anthropic",
      authMethod: "bearer_token",
      policy: { approvedProviders: ["foundry"], approvedFoundryOrigins: ["https://fixture-resource.services.ai.azure.com"] },
    });
    expect(await invalid.readiness()).toMatchObject({ ready: false, reasonCode: "provider_configuration_invalid" });
  });

  test("fails closed when provider policy does not approve the broker", async () => {
    const broker = new AwsBedrockCredentialBroker(secrets({ [AWS_BEARER_TOKEN_BEDROCK_SECRET]: FIXTURE_SECRET }), {
      region: "us-east-1",
      authMethod: "bearer_token",
      policy: { approvedProviders: ["anthropic"] },
    });
    expect(await broker.readiness()).toMatchObject({ ready: false, reasonCode: "provider_not_approved", provider: "bedrock" });
    await expect(broker.acquire()).rejects.toMatchObject({ code: "provider_not_approved", provider: "bedrock" });
    expect(JSON.stringify(await broker.readiness())).not.toContain(FIXTURE_SECRET);
  });

  test.each(["gateway", "bedrock", "vertex", "foundry"] as const)("applies the independent %s rollout gate before broker acquisition", async (provider) => {
    let acquired = 0;
    const broker = {
      readiness: async () => ({ ready: true as const, reasonCode: "credential_ready" as const, provider }),
      acquire: async () => {
        acquired += 1;
        return { environment: {}, release: () => undefined };
      },
    };
    const disabled = new RolloutGatedClaudeCredentialBroker(broker, new ClaudeAdvancedRollout({ env: {} }));
    expect(await disabled.readiness()).toMatchObject({ ready: false, reasonCode: "provider_not_approved", provider });
    await expect(disabled.acquire()).rejects.toMatchObject({ code: "provider_not_approved", provider });
    expect(acquired).toBe(0);

    const names = claudeAdvancedFeatureEnvironment(`provider-${provider}`);
    const enabled = new RolloutGatedClaudeCredentialBroker(broker, new ClaudeAdvancedRollout({
      env: { [names.flag]: "1", [names.policy]: "1" },
    }));
    expect(await enabled.readiness()).toMatchObject({ ready: true, provider });
    await enabled.acquire();
    expect(acquired).toBe(1);
  });
});

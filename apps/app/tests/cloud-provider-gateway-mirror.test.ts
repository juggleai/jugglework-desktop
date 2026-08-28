import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  JuggleWorkServerError,
  type JuggleWorkServerClient,
} from "../src/app/lib/jugglework-server";
import type { DenOrgLlmProviderConnection } from "../src/app/lib/den";
import {
  buildCloudImportedProvider,
  buildRuntimeProviderPatch,
  CLOUD_PROVIDER_METADATA_VERSION,
  gatewayMirrorEnvName,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";
import {
  removeGatewayMirror,
  writeGatewayMirror,
} from "../src/react-app/domains/connections/provider-auth/gateway-mirror";

const storeSource = readFileSync(
  new URL("../src/react-app/domains/connections/provider-auth/store.ts", import.meta.url),
  "utf8",
);

describe("gateway credential mirror", () => {
  test("derives a stable name from the provider record id", () => {
    expect(gatewayMirrorEnvName("lpr_a1b2c3")).toBe("MCP_GATEWAY_KEY_LPR_A1B2C3");
    expect(gatewayMirrorEnvName("lpr-x.y")).toBe("MCP_GATEWAY_KEY_LPR_X_Y");
    expect(gatewayMirrorEnvName("  ")).toBe("MCP_GATEWAY_KEY");
  });

  test("never produces a name the env store would reject or strip", () => {
    // env-file.ts refuses writes to JUGGLEWORK_*/OPENCODE_* (isReservedEnvKey)
    // and strips them again on injection (readForInjection). A mirror under a
    // reserved name would silently never reach the MCP subprocess.
    for (const id of ["lpr_1", "jugglework_provider", "opencode-thing", ""]) {
      const name = gatewayMirrorEnvName(id);
      expect(name.startsWith("JUGGLEWORK_")).toBe(false);
      expect(name.startsWith("OPENCODE_")).toBe(false);
      expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).toBe(true);
    }
  });

  test("matches the name the web console shows on the provider", () => {
    // webconsole/web/.../llm-gateway-access.ts gatewayCredentialEnvName must
    // agree, or a distributed MCP reads a variable that is never written.
    // (The helper used to live in mcp-component-payload.ts, next to the MCP
    // form's provider binder; it moved with that binder onto the provider page.)
    const consoleSource = readFileSync(
      new URL("../../../../jugglework-server/webconsole/web/app/(cloud)/dashboard/_components/llm-gateway-access.ts", import.meta.url),
      "utf8",
    );
    expect(consoleSource).toContain("MCP_GATEWAY_KEY_${suffix}");
    expect(consoleSource).not.toContain("JUGGLEWORK_GATEWAY_KEY_${suffix}");
  });

  test("writes the mirror before completing the import baseline", () => {
    const writeAt = storeSource.indexOf("await writeGatewayMirror(");
    const persistAt = storeSource.indexOf("await persistImportedCloudProviders(nextImportedProviders);");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeGreaterThan(writeAt);
  });

  test("clears the mirror before completing provider removal", () => {
    // Every true provider removal path funnels through removeCloudProviderInternal.
    const removalStart = storeSource.indexOf("async function removeCloudProviderInternal");
    const removalMirrorAt = storeSource.indexOf("await removeGatewayMirror(", removalStart);
    const removalBaselineAt = storeSource.indexOf("delete nextImportedProviders[cloudProviderId]", removalStart);
    expect(removalMirrorAt).toBeGreaterThan(removalStart);
    expect(removalBaselineAt).toBeGreaterThan(removalMirrorAt);
  });

  test("local provider id migration preserves the cloud-row mirror", async () => {
    const cloudProviderId = "lpr_x";
    const legacyProviderId = "JuggleRouter";
    const gatewayToken = "jwgw_current_token";
    const env = new Map<string, string>();
    const removedAuth = new Set<string>();
    const client = {
      upsertUserEnv: async (entries: Array<{ key: string; value: string }>) => {
        for (const entry of entries) env.set(entry.key, entry.value);
      },
      deleteUserEnv: async (key: string) => {
        env.delete(key);
      },
    } as unknown as JuggleWorkServerClient;
    const provider: DenOrgLlmProviderConnection = {
      id: cloudProviderId,
      source: "juggle_router",
      providerId: "JuggleRouter",
      name: "JuggleRouter",
      providerConfig: {
        npm: "@ai-sdk/openai-compatible",
        api: `https://cloud.example.test/jwork/api/gateway/v1/${cloudProviderId}`,
        options: {
          baseURL: `https://cloud.example.test/jwork/api/gateway/v1/${cloudProviderId}`,
        },
      },
      hasApiKey: true,
      managed: true,
      managedKind: "juggle_router",
      accessScope: "organization",
      enabled: true,
      models: [],
      createdAt: null,
      updatedAt: "2026-08-25T01:02:03Z",
      apiKey: gatewayToken,
      apiKeys: null,
    };
    const startingBaseline = {
      ...buildCloudImportedProvider(provider, 1),
      providerId: legacyProviderId,
      metadataVersion: 5,
    };

    await writeGatewayMirror(client, cloudProviderId, gatewayToken);
    if (startingBaseline.providerId !== cloudProviderId) {
      removedAuth.add(startingBaseline.providerId);
    }
    const runtimePatch = buildRuntimeProviderPatch(
      provider,
      cloudProviderId,
      startingBaseline.providerId,
    );
    const finalBaseline = buildCloudImportedProvider(provider, 2);

    expect(env.get("MCP_GATEWAY_KEY_LPR_X")).toBe(gatewayToken);
    expect(removedAuth.has(legacyProviderId)).toBe(true);
    expect(runtimePatch[legacyProviderId]).toBeNull();
    expect(runtimePatch[cloudProviderId]).toBeDefined();
    expect(finalBaseline).toMatchObject({
      cloudProviderId,
      providerId: cloudProviderId,
      sourceProviderId: "JuggleRouter",
      metadataVersion: CLOUD_PROVIDER_METADATA_VERSION,
    });
    expect(finalBaseline.metadataVersion).toBe(6);

    const connectStart = storeSource.indexOf("async function connectCloudProviderInternal");
    const connectEnd = storeSource.indexOf("async function connectCloudProvider(", connectStart);
    const connectSource = storeSource.slice(connectStart, connectEnd);
    expect(connectSource).toContain("await removeProviderAuthCredentials(existingImported.providerId);");
    expect(connectSource).toContain("existingImported?.providerId ?? null");
    expect(connectSource).not.toContain("await removeGatewayMirror(");
  });

  test("a transient mirror write failure is sanitized, blocks completion, and retries", async () => {
    const token = "jwgw_secret_must_not_escape";
    let attempts = 0;
    const client = {
      upsertUserEnv: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new JuggleWorkServerError(503, "unavailable", `failed for ${token}`);
        }
      },
    } as unknown as JuggleWorkServerClient;

    let message = "";
    try {
      await writeGatewayMirror(client, "lpr_retry", token);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Could not store the cloud provider gateway credential. Retry the import.");
    expect(message.includes(token)).toBe(false);
    expect(attempts).toBe(1);

    await writeGatewayMirror(client, "lpr_retry", token);
    expect(attempts).toBe(2);
  });

  test("a transient mirror delete failure is sanitized and retried", async () => {
    const token = "jwgw_delete_secret_must_not_escape";
    let attempts = 0;
    const client = {
      deleteUserEnv: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new JuggleWorkServerError(500, "env_store_failed", `failed for ${token}`);
        }
      },
    } as unknown as JuggleWorkServerClient;

    let message = "";
    try {
      await removeGatewayMirror(client, "lpr_retry");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Could not remove the cloud provider gateway credential. Retry the removal.");
    expect(message.includes(token)).toBe(false);
    expect(attempts).toBe(1);

    await removeGatewayMirror(client, "lpr_retry");
    expect(attempts).toBe(2);
  });

  test("delete 404 and demonstrably missing old-server routes are benign", async () => {
    const missingItem = {
      deleteUserEnv: async () => {
        throw new JuggleWorkServerError(404, "env_not_found", "Environment variable not found");
      },
    } as unknown as JuggleWorkServerClient;
    const oldServer = {
      upsertUserEnv: async () => {
        throw new JuggleWorkServerError(404, "not_found", "Not found");
      },
      deleteUserEnv: async () => {
        throw new JuggleWorkServerError(501, "not_implemented", "Not implemented");
      },
    } as unknown as JuggleWorkServerClient;

    await expect(removeGatewayMirror(missingItem, "lpr_missing")).resolves.toBeUndefined();
    await expect(writeGatewayMirror(oldServer, "lpr_old", "jwgw_secret")).resolves.toBeUndefined();
    await expect(removeGatewayMirror(oldServer, "lpr_old")).resolves.toBeUndefined();
  });

  test("compatibility does not use broad message matching", async () => {
    const token = "jwgw_message_secret";
    const untyped404 = {
      upsertUserEnv: async () => {
        throw new Error(`404 not found ${token}`);
      },
    } as unknown as JuggleWorkServerClient;
    const writeItem404 = {
      upsertUserEnv: async () => {
        throw new JuggleWorkServerError(404, "env_not_found", `not found ${token}`);
      },
    } as unknown as JuggleWorkServerClient;

    for (const client of [untyped404, writeItem404]) {
      let message = "";
      try {
        await writeGatewayMirror(client, "lpr_strict", token);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe("Could not store the cloud provider gateway credential. Retry the import.");
      expect(message.includes(token)).toBe(false);
    }
  });

  test("no client remains a compatibility no-op", async () => {
    await expect(writeGatewayMirror(null, "lpr_none", "jwgw_secret")).resolves.toBeUndefined();
    await expect(removeGatewayMirror(undefined, "lpr_none")).resolves.toBeUndefined();
  });
});

describe("upgrade from a build without the mirror", () => {
  test("bumps the metadata version so existing imports are rewritten once", () => {
    // Providers imported by an older build carry no mirror variable. The sync
    // pass only re-imports when isCloudProviderOutOfSync says so, and nothing
    // else about those providers changed — the version counter is what makes
    // the upgrade self-healing instead of requiring a manual re-import.
    const configSource = readFileSync(
      new URL("../src/react-app/domains/connections/provider-auth/cloud-provider-config.ts", import.meta.url),
      "utf8",
    );
    const version = Number(configSource.match(/CLOUD_PROVIDER_METADATA_VERSION = (\d+)/)?.[1]);
    expect(version).toBeGreaterThanOrEqual(6);
  });
});

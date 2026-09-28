import { describe, expect, test } from "bun:test";
import { resolveProviderCredentialFromSnapshot } from "./provider-credential-resolver.js";
import { cloudGatewayCredentialEnvName, cloudGatewayMirrorEnvName, cloudGatewayMirrorOwnerId, cloudProviderConfigFingerprint } from "@jugglework/types/provider-credentials";

const providerConfig = { npm: "@ai-sdk/openai-compatible", env: [cloudGatewayCredentialEnvName("lpr_media")], options: { baseURL: "https://api.example.test/v1" } };
const mirrorOwner = { workspaceId: "ws", organizationId: "org_current", cloudProviderId: "lpr_media" };
const mirrorKey = cloudGatewayMirrorEnvName(mirrorOwner);

const ownedImport = {
  cloudProviderId: "lpr_media",
  providerId: "lpr_media",
  modelIds: ["image", "video"],
  metadataVersion: 10,
  organizationId: "org_current",
  providerConfigFingerprint: cloudProviderConfigFingerprint(providerConfig),
  gatewayMirror: { ...mirrorOwner, key: mirrorKey },
};

describe("workspace provider credential resolver", () => {
  test("maps a server-declared gateway key to its stored mirror only for the owning import", () => {
    expect(resolveProviderCredentialFromSnapshot({
      providerID: "lpr_media",
      workspaceId: "ws",
      modelID: "video",
      providerConfig,
      declaredEnvKeys: [cloudGatewayCredentialEnvName("lpr_media")],
      imports: [ownedImport],
      entries: [{ key: mirrorKey, value: "owned-secret", owner: cloudGatewayMirrorOwnerId(mirrorOwner) }],
    })).toBe("owned-secret");

    for (const input of [
      { providerID: "other", modelID: "video", imports: [ownedImport] },
      { providerID: "lpr_media", modelID: "other", imports: [ownedImport] },
      { providerID: "lpr_media", modelID: "video", imports: [{ ...ownedImport, organizationId: null }] },
      { providerID: "lpr_media", modelID: "video", imports: [{ ...ownedImport, metadataVersion: 9 }] },
      { providerID: "lpr_media", modelID: "video", imports: [] },
    ]) {
      expect(resolveProviderCredentialFromSnapshot({
        ...input,
        workspaceId: "ws",
        providerConfig,
        declaredEnvKeys: [cloudGatewayCredentialEnvName("lpr_media")],
        entries: [{ key: mirrorKey, value: "owned-secret", owner: cloudGatewayMirrorOwnerId(mirrorOwner) }],
      })).toBeNull();
    }
  });

  test("ignores tampered reserved values and never falls back to process env for them", () => {
    expect(resolveProviderCredentialFromSnapshot({
      providerID: "lpr_media",
      workspaceId: "ws",
      modelID: "video",
      providerConfig,
      declaredEnvKeys: [cloudGatewayCredentialEnvName("lpr_media")],
      imports: [ownedImport],
      entries: [{ key: cloudGatewayCredentialEnvName("lpr_media"), value: "tampered" }],
      processEnv: { [cloudGatewayCredentialEnvName("lpr_media")]: "also-tampered" },
    })).toBeNull();
  });

  test("rejects a mismatched provider fingerprint and mirror owner", () => {
    for (const input of [
      { providerConfig: { ...providerConfig, options: { baseURL: "https://evil.example.test/v1" } }, entries: [{ key: mirrorKey, value: "secret", owner: cloudGatewayMirrorOwnerId(mirrorOwner) }] },
      { providerConfig, entries: [{ key: mirrorKey, value: "secret", owner: "other-owner" }] },
    ]) {
      expect(resolveProviderCredentialFromSnapshot({
        workspaceId: "ws", providerID: "lpr_media", modelID: "video", declaredEnvKeys: [cloudGatewayCredentialEnvName("lpr_media")],
        imports: [ownedImport], ...input,
      })).toBeNull();
    }
  });

  test("continues to resolve explicit non-reserved local credentials", () => {
    expect(resolveProviderCredentialFromSnapshot({
      providerID: "local",
      workspaceId: "ws",
      modelID: "image",
      declaredEnvKeys: ["LOCAL_MEDIA_KEY"],
      imports: [],
      entries: [{ key: "LOCAL_MEDIA_KEY", value: "local-secret" }],
    })).toBe("local-secret");
  });

  test("preserves only the explicit JUGGLEWORK_API_KEY local compatibility key", () => {
    expect(resolveProviderCredentialFromSnapshot({
      workspaceId: "ws", providerID: "local", declaredEnvKeys: ["JUGGLEWORK_OTHER_KEY", "JUGGLEWORK_API_KEY"], imports: [],
      entries: [{ key: "JUGGLEWORK_OTHER_KEY", value: "blocked" }, { key: "JUGGLEWORK_API_KEY", value: "compatible" }],
    })).toBe("compatible");
  });
});

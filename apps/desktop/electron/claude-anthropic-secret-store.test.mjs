import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClaudeAnthropicSecretStore } from "./claude-anthropic-secret-store.mjs";

function safeStorage(backend = "keychain") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").slice("protected:".length),
  };
}

describe("Anthropic desktop secret store", () => {
  it("persists only platform-encrypted BYOK material", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-claude-secret-"));
    const filePath = path.join(root, "anthropic.json");
    const secret = "sk-ant-plaintext-canary";
    try {
      const store = createClaudeAnthropicSecretStore({ filePath, safeStorage: safeStorage(), platform: "darwin" });
      await store.setSecret(secret);
      const persisted = await readFile(filePath, "utf8");
      assert.doesNotMatch(persisted, new RegExp(secret));
      assert.match(Buffer.from(JSON.parse(persisted).encryptedValue, "base64").toString(), /^protected:/);
      assert.equal(await store.getSecret("anthropic_api_key"), secret);
      assert.equal(await store.getSecret("unknown"), null);
      assert.deepEqual(await store.readiness(), { ready: true, reasonCode: "credential_ready" });
      await store.deleteSecret();
      assert.equal(await store.getSecret("anthropic_api_key"), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects degraded Linux storage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-claude-secret-"));
    try {
      const store = createClaudeAnthropicSecretStore({
        filePath: path.join(root, "anthropic.json"),
        safeStorage: safeStorage("basic_text"),
        platform: "linux",
      });
      await assert.rejects(store.setSecret("sk-ant-test"), { code: "secure_storage_degraded" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores provider-specific secrets under separate encrypted records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-claude-secret-"));
    const filePath = path.join(root, "claude-provider.json");
    const gatewaySecret = "fixture-only-not-a-real-gateway-token";
    try {
      const store = createClaudeAnthropicSecretStore({ filePath, safeStorage: safeStorage(), platform: "darwin" });
      await store.setSecret("claude_gateway_credential", gatewaySecret);
      const providerPath = `${filePath}.claude_gateway_credential`;
      const persisted = await readFile(providerPath, "utf8");
      assert.doesNotMatch(persisted, new RegExp(gatewaySecret));
      assert.equal(await store.getSecret("claude_gateway_credential"), gatewaySecret);
      assert.equal(await store.getSecret("anthropic_api_key"), null);
      assert.deepEqual(await store.readiness("claude_gateway_credential"), { ready: true, reasonCode: "credential_ready" });
      await store.deleteSecret("claude_gateway_credential");
      assert.equal(await store.getSecret("claude_gateway_credential"), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

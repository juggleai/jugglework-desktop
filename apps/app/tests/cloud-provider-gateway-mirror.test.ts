import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { gatewayMirrorEnvName } from "../src/react-app/domains/connections/provider-auth/cloud-provider-config";

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

  test("matches the name the web console writes into MCP components", () => {
    // webconsole/web/.../mcp-component-payload.ts gatewayCredentialEnvName must
    // agree, or a distributed MCP reads a variable that is never written.
    const consoleSource = readFileSync(
      new URL("../../../../jugglework-server/webconsole/web/app/(cloud)/dashboard/_components/mcp-component-payload.ts", import.meta.url),
      "utf8",
    );
    expect(consoleSource).toContain("MCP_GATEWAY_KEY_${suffix}");
    expect(consoleSource).not.toContain("JUGGLEWORK_GATEWAY_KEY_${suffix}");
  });

  test("writes the mirror only alongside the auth.json credential", () => {
    expect(storeSource).toContain("await writeGatewayMirror(cloudProviderId, primaryApiKey);");
  });

  test("clears the mirror when the provider is removed or replaced", () => {
    // Every removal path funnels through removeCloudProviderInternal, and a
    // re-import under a new provider id must not strand the old credential.
    expect(storeSource).toContain("await removeGatewayMirror(cloudProviderId);");
    expect(storeSource).toContain("await removeGatewayMirror(existingImported.cloudProviderId);");
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
    expect(version).toBeGreaterThanOrEqual(4);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const storeSource = readFileSync(join(
  import.meta.dir,
  "..",
  "src",
  "react-app",
  "domains",
  "connections",
  "provider-auth",
  "store.ts",
), "utf8");

function sourceBetween(startMarker: string, endMarker: string) {
  const start = storeSource.indexOf(startMarker);
  const end = storeSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return storeSource.slice(start, end);
}

describe("provider auth host authorization", () => {
  test("removes credentials through the host-authorized bridge before the direct OpenCode fallback", () => {
    const source = sourceBetween(
      "const removeProviderAuthCredentials = async",
      "const describeProviderError",
    );
    const bridgeCall = source.indexOf("hostTarget.client.removeProviderAuth");
    const directCall = source.indexOf("authClient.remove");

    expect(source).toContain('resolveHostProviderAuthTarget()');
    expect(bridgeCall).toBeGreaterThanOrEqual(0);
    expect(directCall).toBeGreaterThan(bridgeCall);
  });

  test("writes API credentials through the same host-authorized bridge", () => {
    const source = sourceBetween(
      "const setProviderAuthCredentials = async",
      "const removeProviderAuthCredentials = async",
    );

    expect(source).toContain("hostTarget.client.setProviderAuth");
    expect(source).toContain("await c.auth.set");
  });

  test("all API-key provider flows use the authorized credential helper", () => {
    expect(storeSource.match(/await setProviderAuthCredentials\(/g)?.length).toBe(3);
    expect(storeSource).not.toContain("await c.auth.set({\n          providerID:");
  });
});

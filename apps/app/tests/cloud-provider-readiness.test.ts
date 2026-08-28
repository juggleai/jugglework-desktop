import { describe, expect, test } from "bun:test";

import { isCloudProviderSyncReady } from "../src/react-app/domains/connections/provider-auth/cloud-provider-readiness";

describe("cloud provider readiness", () => {
  test("keeps managed providers gated before or after a failed refresh", () => {
    expect(isCloudProviderSyncReady(null)).toBe(false);
  });

  test("becomes ready after an authoritative provider list loads", () => {
    expect(isCloudProviderSyncReady({ all: [], connected: [], default: {} })).toBe(true);
  });
});

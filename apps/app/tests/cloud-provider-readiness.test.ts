import { describe, expect, test } from "bun:test";

import {
  isCloudProviderSyncReady,
  isManagedModelSubmissionReady,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-readiness";

describe("cloud provider readiness", () => {
  test("keeps managed providers gated before or after a failed refresh", () => {
    expect(isCloudProviderSyncReady(null)).toBe(false);
  });

  test("becomes ready after an authoritative provider list loads", () => {
    expect(isCloudProviderSyncReady({ all: [], connected: [], default: {} })).toBe(true);
  });

  test("allows an already connected managed model while background sync is recovering", () => {
    expect(isManagedModelSubmissionReady({
      cloudProviderSyncReady: false,
      model: { providerID: "lpr_org", modelID: "gpt-managed" },
      providerList: {
        connected: ["lpr_org"],
        default: {},
        all: [{
          id: "lpr_org",
          name: "Organization provider",
          source: "config",
          env: [],
          models: { "gpt-managed": { id: "gpt-managed", name: "Managed" } },
        }],
      },
    })).toBe(true);
  });

  test("keeps a missing or disconnected managed model gated", () => {
    const providerList = {
      connected: [] as string[],
      default: {},
      all: [{
        id: "lpr_org",
        name: "Organization provider",
        source: "config" as const,
        env: [],
        models: { "gpt-managed": { id: "gpt-managed", name: "Managed" } },
      }],
    };
    expect(isManagedModelSubmissionReady({
      cloudProviderSyncReady: false,
      model: { providerID: "lpr_org", modelID: "gpt-managed" },
      providerList,
    })).toBe(false);
    expect(isManagedModelSubmissionReady({
      cloudProviderSyncReady: false,
      model: { providerID: "lpr_org", modelID: "missing" },
      providerList: { ...providerList, connected: ["lpr_org"] },
    })).toBe(false);
  });
});

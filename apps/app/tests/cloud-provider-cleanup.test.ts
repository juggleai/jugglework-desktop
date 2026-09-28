import { describe, expect, test } from "bun:test";
import { cleanupCloudProviderIndependently, registerOrganizationCleanup, requireOrganizationCleanup } from "../src/react-app/domains/connections/provider-auth/cloud-provider-cleanup";

describe("cloud provider organization cleanup", () => {
  test("attempts mirror, auth, and runtime independently and fails closed", async () => {
    const attempts: string[] = [];
    let baselineRetained = true;
    await expect(cleanupCloudProviderIndependently({
      mirror: async () => { attempts.push("mirror"); throw new Error("mirror fault"); },
      auth: async () => { attempts.push("auth"); },
      runtime: async () => { attempts.push("runtime"); throw new Error("runtime fault"); },
    }).then(() => { baselineRetained = false; })).rejects.toThrow("cloud_provider_cleanup_incomplete:mirror,runtime");
    expect(attempts.sort()).toEqual(["auth", "mirror", "runtime"]);
    expect(baselineRetained).toBe(true);
  });

  test("blocks activation while any registered workspace cleanup is unresolved", async () => {
    let activations = 0;
    const unregister = registerOrganizationCleanup(async () => { throw new Error("fault"); });
    try {
      await expect(requireOrganizationCleanup().then(() => { activations += 1; })).rejects.toThrow("Retry before switching organizations");
      expect(activations).toBe(0);
    } finally {
      unregister();
    }
  });
});

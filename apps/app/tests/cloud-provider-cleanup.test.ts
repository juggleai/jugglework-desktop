import { describe, expect, test } from "bun:test";
import {
  cleanupCloudProviderIndependently,
  registerOrganizationCloudCleanup,
  runOrganizationCloudCleanup,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-cleanup";

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

  test("does not block organization activation when cloud cleanup fails", async () => {
    let activations = 0;
    let laterCleanupRan = false;
    const unregister = registerOrganizationCloudCleanup(async () => {
      throw new Error("fault");
    });
    const unregisterLater = registerOrganizationCloudCleanup(async () => {
      laterCleanupRan = true;
    });
    try {
      await expect(runOrganizationCloudCleanup().then(() => {
        activations += 1;
      })).resolves.toBeUndefined();
      expect(activations).toBe(1);
      expect(laterCleanupRan).toBe(true);
    } finally {
      unregister();
      unregisterLater();
    }
  });
});

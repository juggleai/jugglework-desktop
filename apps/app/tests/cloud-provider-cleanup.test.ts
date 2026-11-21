import { describe, expect, test } from "bun:test";
import {
  cleanupCloudProviderIndependently,
  describeCloudCleanupFailure,
  registerOrganizationCloudCleanup,
  runOrganizationCloudCleanup,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-cleanup";

describe("cloud provider organization cleanup", () => {
  test("diagnostics contain only a fixed stage, valid status, and known error codes", async () => {
    const sensitive = { message: "private message", details: { authorization: "private value" }, url: "https://private.test" };
    const error = await cleanupCloudProviderIndependently({
      mirror: async () => { throw { ...sensitive, status: 409, code: "cloud_provider_mirror_unowned" }; },
      auth: async () => { throw { ...sensitive, status: 401, code: "generic_looking_private_value" }; },
      runtime: async () => { throw { ...sensitive, status: 999, name: "TimeoutError" }; },
    }).catch((error) => error);
    expect(describeCloudCleanupFailure("workspace_cleanup", error)).toEqual([
      { stage: "provider_mirror", status: 409, code: "cloud_provider_mirror_unowned" },
      { stage: "provider_auth", status: 401 },
      { stage: "provider_runtime", code: "transport_timeout_or_abort" },
    ]);
  });

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

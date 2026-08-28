import { describe, expect, test } from "bun:test";

import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import type { Client } from "../src/app/types";
import {
  readRuntimeDisabledProviders,
  removeManagedRuntimeDisabledProviders,
  updateManagedDisabledProviders,
  withoutDisabledProviders,
} from "../src/react-app/domains/connections/managed-engine-config";

function opencodeClient(input: {
  current?: Record<string, unknown>;
  onGet?: () => void;
  onUpdate?: (config: Record<string, unknown>) => void;
}): Client {
  return {
    config: {
      get: async () => {
        input.onGet?.();
        return { data: input.current ?? {} };
      },
      update: async ({ config }: { config: Record<string, unknown> }) => {
        input.onUpdate?.(config);
        return { data: config };
      },
    },
  } as unknown as Client;
}

describe("managed engine config writes", () => {
  test("skips config.update when disabled providers already match", async () => {
    let updateCount = 0;
    const client = opencodeClient({
      current: { disabled_providers: ["opencode", "demo"] },
      onUpdate: () => updateCount += 1,
    });

    const result = await updateManagedDisabledProviders({
      opencodeClient: client,
      workspaceType: "remote",
      disabledProviders: ["opencode", "demo"],
    });

    expect(result).toEqual({
      managedRuntime: false,
      disabledProviders: ["opencode", "demo"],
      changed: false,
    });
    expect(updateCount).toBe(0);
  });

  test("updates engine config when disabled providers change", async () => {
    let updatedConfig: Record<string, unknown> | null = null;
    const client = opencodeClient({
      current: { model: "demo/model", disabled_providers: ["demo"] },
      onUpdate: (config) => {
        updatedConfig = config;
      },
    });

    await updateManagedDisabledProviders({
      opencodeClient: client,
      workspaceType: "remote",
      disabledProviders: ["opencode", "demo", "opencode"],
    });

    expect(updatedConfig).toEqual({
      model: "demo/model",
      disabled_providers: ["opencode", "demo"],
    });
  });

  test("keeps local workspaces on the managed runtime endpoint", async () => {
    let runtimeWrites = 0;
    let engineUpdates = 0;
    const juggleworkClient = {
      setRuntimeDisabledProviders: async (_workspaceId: string, disabledProviders: string[]) => {
        runtimeWrites += 1;
        return { disabledProviders, changed: true };
      },
    } as unknown as JuggleWorkServerClient;

    const result = await updateManagedDisabledProviders({
      opencodeClient: opencodeClient({ onUpdate: () => engineUpdates += 1 }),
      juggleworkClient,
      workspaceId: "ws_1",
      workspaceType: "local",
      disabledProviders: ["opencode"],
    });

    expect(result).toEqual({ managedRuntime: true, disabledProviders: ["opencode"], changed: true });
    expect(runtimeWrites).toBe(1);
    expect(engineUpdates).toBe(0);
  });

  test("does not request a reload when the managed runtime value is unchanged", async () => {
    let reloads = 0;
    const juggleworkClient = {
      setRuntimeDisabledProviders: async () => ({ disabledProviders: ["opencode"], changed: false }),
    } as unknown as JuggleWorkServerClient;

    const result = await updateManagedDisabledProviders({
      opencodeClient: null,
      juggleworkClient,
      workspaceId: "ws_1",
      workspaceType: "local",
      disabledProviders: ["opencode"],
      markReloadRequired: () => reloads += 1,
    });

    expect(result).toEqual({ managedRuntime: true, disabledProviders: ["opencode"], changed: false });
    expect(reloads).toBe(0);
  });

  test("keeps reload behavior with an older managed runtime response", async () => {
    let reloads = 0;
    const juggleworkClient = {
      setRuntimeDisabledProviders: async () => ({ disabledProviders: ["opencode"] }),
    } as unknown as JuggleWorkServerClient;

    const result = await updateManagedDisabledProviders({
      opencodeClient: null,
      juggleworkClient,
      workspaceId: "ws_1",
      workspaceType: "local",
      disabledProviders: ["opencode"],
      markReloadRequired: () => reloads += 1,
    });

    expect(result.changed).toBe(true);
    expect(reloads).toBe(1);
  });

  test("reads only the runtime layer and removes current and previous cloud ids", async () => {
    const writes: string[][] = [];
    let reloads = 0;
    const juggleworkClient = {
      getRuntimeConfigStatus: async () => ({
        runtime: {
          disabled_providers: ["runtime-only", "lpr_current", "LPR_PREVIOUS"],
        },
        effective: {
          disabled_providers: [
            "global-only",
            "project-only",
            "runtime-only",
            "lpr_current",
            "LPR_PREVIOUS",
          ],
        },
      }),
      setRuntimeDisabledProviders: async (_workspaceId: string, disabledProviders: string[]) => {
        writes.push(disabledProviders);
        return { disabledProviders, changed: true };
      },
    } as unknown as JuggleWorkServerClient;

    expect(await readRuntimeDisabledProviders(juggleworkClient, "ws_1")).toEqual([
      "runtime-only",
      "lpr_current",
      "LPR_PREVIOUS",
    ]);
    const result = await removeManagedRuntimeDisabledProviders({
      juggleworkClient,
      workspaceId: "ws_1",
      providerIds: ["lpr_current", "lpr_previous"],
      markReloadRequired: () => reloads += 1,
    });

    expect(result).toEqual({
      managedRuntime: true,
      disabledProviders: ["runtime-only"],
      changed: true,
    });
    expect(writes).toEqual([["runtime-only"]]);
    expect(reloads).toBe(1);
  });

  test("cloud disabled cleanup is idempotent and does not reload on a no-op", async () => {
    let writes = 0;
    let reloads = 0;
    const juggleworkClient = {
      getRuntimeConfigStatus: async () => ({
        runtime: { disabled_providers: ["runtime-only"] },
      }),
      setRuntimeDisabledProviders: async () => {
        writes += 1;
        return { disabledProviders: ["runtime-only"], changed: false };
      },
    } as unknown as JuggleWorkServerClient;

    const result = await removeManagedRuntimeDisabledProviders({
      juggleworkClient,
      workspaceId: "ws_1",
      providerIds: ["lpr_current", "lpr_previous"],
      markReloadRequired: () => reloads += 1,
    });

    expect(result.changed).toBe(false);
    expect(writes).toBe(0);
    expect(reloads).toBe(0);
  });

  test("effective merged entries are never accepted as a runtime cleanup base", async () => {
    let writes = 0;
    const juggleworkClient = {
      getRuntimeConfigStatus: async () => ({
        runtime: null,
        effective: { disabled_providers: ["global-only", "lpr_current"] },
      }),
      setRuntimeDisabledProviders: async () => {
        writes += 1;
        return { disabledProviders: [] };
      },
    } as unknown as JuggleWorkServerClient;

    await expect(removeManagedRuntimeDisabledProviders({
      juggleworkClient,
      workspaceId: "ws_1",
      providerIds: ["lpr_current"],
    })).rejects.toThrow("Could not read managed runtime disabled providers.");
    expect(writes).toBe(0);
  });

  test("removes provider ids case-insensitively without mutating unrelated entries", () => {
    expect(withoutDisabledProviders(
      ["global-looking-but-runtime", "LPR_CURRENT", "lpr_previous"],
      ["lpr_current", "LPR_PREVIOUS"],
    )).toEqual(["global-looking-but-runtime"]);
  });
});

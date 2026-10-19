import { describe, expect, test } from "bun:test";

import {
  assertCloudProviderAuthorityCurrent,
  createKeyedSerialQueue,
  createKeyedSingleflight,
  createLatestSyncQueue,
  StaleCloudProviderAuthorityError,
  shouldAdoptWorkspaceSnapshot,
} from "../src/react-app/domains/connections/provider-auth/cloud-provider-sync-queue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLatestSyncQueue", () => {
  test("waits for the queued workspace pass before resolving callers", async () => {
    const firstPass = deferred();
    const calls: string[] = [];
    const queue = createLatestSyncQueue(async (workspace: string) => {
      calls.push(workspace);
      if (workspace === "old-workspace") await firstPass.promise;
    });

    const first = queue.run("old-workspace");
    const switched = queue.run("new-workspace");

    expect(calls).toEqual(["old-workspace"]);
    firstPass.resolve();
    await switched;

    expect(calls).toEqual(["old-workspace", "new-workspace"]);
    await first;
  });

  test("coalesces repeated requests to the latest queued reason", async () => {
    const firstPass = deferred();
    const calls: string[] = [];
    const queue = createLatestSyncQueue(async (reason: string) => {
      calls.push(reason);
      if (reason === "app_launch") await firstPass.promise;
    });

    const pending = queue.run("app_launch");
    void queue.run("model_picker_open");
    void queue.run("new_chat");
    firstPass.resolve();
    await pending;

    expect(calls).toEqual(["app_launch", "new_chat"]);
  });
});

describe("createKeyedSingleflight", () => {
  test("shares one in-flight provider connection across stores", async () => {
    const gate = deferred();
    const singleflight = createKeyedSingleflight<string, string>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await gate.promise;
      return "credential";
    };

    const sessionStore = singleflight.run("org::provider", load);
    const settingsStore = singleflight.run("org::provider", load);
    expect(calls).toBe(1);
    gate.resolve();
    expect(await sessionStore).toBe("credential");
    expect(await settingsStore).toBe("credential");

    await singleflight.run("org::provider", async () => {
      calls += 1;
      return "fresh";
    });
    expect(calls).toBe(2);
  });
});

describe("createKeyedSerialQueue", () => {
  test("serializes account mutations across stores for one workspace", async () => {
    const queue = createKeyedSerialQueue<string>();
    const oldAccountGate = deferred();
    const calls: string[] = [];

    const oldAccount = queue.run("workspace", async () => {
      calls.push("old:start");
      await oldAccountGate.promise;
      calls.push("old:end");
    });
    const newAccount = queue.run("workspace", async () => {
      calls.push("new:start");
      calls.push("new:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["old:start"]);
    oldAccountGate.resolve();
    await Promise.all([oldAccount, newAccount]);
    expect(calls).toEqual(["old:start", "old:end", "new:start", "new:end"]);
  });

  test("does not block independent workspaces", async () => {
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred();
    const calls: string[] = [];
    const first = queue.run("workspace-a", async () => {
      calls.push("a:start");
      await gate.promise;
    });
    await queue.run("workspace-b", async () => {
      calls.push("b:start");
    });
    expect(calls).toEqual(["a:start", "b:start"]);
    gate.resolve();
    await first;
  });

  test("drops a late old-account response before the new account commits", async () => {
    const queue = createKeyedSerialQueue<string>();
    const oldResponse = deferred();
    const oldStarted = deferred();
    let authority = "account-a";
    const committed: string[] = [];

    const oldAccount = queue.run("workspace", async () => {
      const capturedAuthority = authority;
      oldStarted.resolve();
      await oldResponse.promise;
      assertCloudProviderAuthorityCurrent(capturedAuthority, authority);
      committed.push("account-a");
    });

    await oldStarted.promise;
    authority = "account-b";
    const newAccount = queue.run("workspace", async () => {
      const capturedAuthority = authority;
      assertCloudProviderAuthorityCurrent(capturedAuthority, authority);
      committed.push("account-b");
    });

    oldResponse.resolve();
    await expect(oldAccount).rejects.toBeInstanceOf(StaleCloudProviderAuthorityError);
    await newAccount;
    expect(committed).toEqual(["account-b"]);
  });
});

describe("cloud provider authority fence", () => {
  test("rejects a late response from the previous account", () => {
    expect(() => assertCloudProviderAuthorityCurrent("account-a", "account-b"))
      .toThrow(StaleCloudProviderAuthorityError);
  });

  test("allows the current account to commit", () => {
    expect(() => assertCloudProviderAuthorityCurrent("account-b", "account-b"))
      .not.toThrow();
  });
});

describe("shouldAdoptWorkspaceSnapshot", () => {
  test("adopts an empty snapshot after switching workspaces", () => {
    expect(
      shouldAdoptWorkspaceSnapshot({
        currentWorkspaceKey: "new-workspace",
        snapshotWorkspaceKey: "old-workspace",
        currentEntryCount: 1,
        nextEntryCount: 0,
      }),
    ).toBe(true);
  });

  test("retains a non-empty snapshot on a transient empty read in the same workspace", () => {
    expect(
      shouldAdoptWorkspaceSnapshot({
        currentWorkspaceKey: "current-workspace",
        snapshotWorkspaceKey: "current-workspace",
        currentEntryCount: 1,
        nextEntryCount: 0,
      }),
    ).toBe(false);
  });
});

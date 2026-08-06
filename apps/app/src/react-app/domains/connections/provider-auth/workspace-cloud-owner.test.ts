declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import {
  workspaceCloudStateOwnerAction,
  workspaceCloudStateOwnerIdentity,
} from "./workspace-cloud-owner";

describe("workspaceCloudStateOwnerAction", () => {
  test("keeps a workspace the current account already owns", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentOwnerId: "usr_a",
    })).toBe("keep");
  });

  test("adopts a workspace with no owner on record", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: null,
      currentOwnerId: "usr_a",
    })).toBe("stamp");
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "   ",
      currentOwnerId: "usr_a",
    })).toBe("stamp");
  });

  test("purges a workspace still holding another account's state", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentOwnerId: "usr_b",
    })).toBe("purge");
  });

  test("never purges without an identity for the current session", () => {
    // No signed-in user id yet: purging here would wipe a working session's
    // providers on nothing more than a guess.
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentOwnerId: null,
    })).toBe("keep");
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentOwnerId: "  ",
    })).toBe("keep");
  });

  test("ignores surrounding whitespace on both sides", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: " usr_a ",
      currentOwnerId: "usr_a",
    })).toBe("keep");
  });

  test("purges when the same user switches organizations", () => {
    const stored = workspaceCloudStateOwnerIdentity({
      userId: "usr_a",
      organizationId: "org_a",
    });
    const current = workspaceCloudStateOwnerIdentity({
      userId: "usr_a",
      organizationId: "org_b",
    });
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: stored,
      currentOwnerId: current,
    })).toBe("purge");
  });

  test("keeps the same user in the same organization", () => {
    const owner = workspaceCloudStateOwnerIdentity({
      userId: " usr_a ",
      organizationId: " org_a ",
    });
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: owner,
      currentOwnerId: owner,
    })).toBe("keep");
  });

  test("does not form an owner identity without both user and organization", () => {
    expect(workspaceCloudStateOwnerIdentity({
      userId: "usr_a",
      organizationId: null,
    })).toBe(null);
  });
});

declare const describe: (name: string, fn: () => void) => void;
declare const test: (name: string, fn: () => void) => void;
declare const expect: (value: unknown) => {
  toBe: (expected: unknown) => void;
};

import { workspaceCloudStateOwnerAction } from "./workspace-cloud-owner";

describe("workspaceCloudStateOwnerAction", () => {
  test("keeps a workspace the current account already owns", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentUserId: "usr_a",
    })).toBe("keep");
  });

  test("adopts a workspace with no owner on record", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: null,
      currentUserId: "usr_a",
    })).toBe("stamp");
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "   ",
      currentUserId: "usr_a",
    })).toBe("stamp");
  });

  test("purges a workspace still holding another account's state", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentUserId: "usr_b",
    })).toBe("purge");
  });

  test("never purges without an identity for the current session", () => {
    // No signed-in user id yet: purging here would wipe a working session's
    // providers on nothing more than a guess.
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentUserId: null,
    })).toBe("keep");
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: "usr_a",
      currentUserId: "  ",
    })).toBe("keep");
  });

  test("ignores surrounding whitespace on both sides", () => {
    expect(workspaceCloudStateOwnerAction({
      storedOwnerId: " usr_a ",
      currentUserId: "usr_a",
    })).toBe("keep");
  });
});

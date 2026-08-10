import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRuntimeIpcHandlers } from "./runtime-ipc.mjs";

describe("runtime IPC", () => {
  it("delegates commands to runtime and engine operations", async () => {
    const calls = [];
    const runtimeStatus = { lifecycleState: "healthy" };
    const activation = { id: "workspace", path: "/workspace", name: "Workspace" };
    const handlers = createRuntimeIpcHandlers({
      runtimeStatus: async () => {
        calls.push(["runtimeStatus"]);
        return runtimeStatus;
      },
      workspaceActivate: async (input) => {
        calls.push(["workspaceActivate", input]);
        return activation;
      },
      engineDispose: async (workspacePath) => {
        calls.push(["engineDispose", workspacePath]);
        return true;
      },
    });

    assert.deepEqual(Object.keys(handlers).sort(), ["engineDispose", "runtimeStatus", "workspaceActivate"]);
    assert.equal(Object.hasOwn(handlers, "managedServerAccess"), false);
    assert.equal(await handlers.runtimeStatus(), runtimeStatus);
    assert.equal(
      await handlers.workspaceActivate({ workspacePath: "/workspace" }),
      activation,
    );
    assert.equal(await handlers.engineDispose(" /workspace "), true);
    assert.deepEqual(calls, [
      ["runtimeStatus"],
      ["workspaceActivate", { workspacePath: "/workspace" }],
      ["engineDispose", "/workspace"],
    ]);
  });
});

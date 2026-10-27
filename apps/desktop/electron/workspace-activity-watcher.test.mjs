import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { createWorkspaceActivityWatcher } from "./workspace-activity-watcher.mjs";

describe("workspace activity watcher", () => {
  it("initializes before remote transport startup and wraps local collection mutations", async () => {
    const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const initialize = main.indexOf("await workspaceActivityWatcher.initialize()");
    const agentStart = main.indexOf("await remoteControlAgent.start()");
    assert.ok(initialize >= 0 && initialize < agentStart);
    for (const call of ["createWorkspace", "forgetWorkspace", "importConfig", "resetJuggleWorkState"]) {
      assert.match(main, new RegExp(`workspaceActivityWatcher\\.mutate\\(\\(\\) => workspaceStore\\.${call}\\(`));
    }
  });

  it("migrates before reading canonical state and watching local Desktop workspaces", async () => {
    const calls = [];
    const watcher = createWorkspaceActivityWatcher({
      workspaceStore: {
        async migrateLegacyElectronWorkspaceStateIfNeeded() { calls.push("migrate"); },
        async readWorkspaceState() {
          calls.push("read");
          return {
            workspaces: [
              { id: "local", name: "Local", workspaceType: "local" },
              { id: "remote", name: "Remote", workspaceType: "remote" },
            ],
          };
        },
      },
      getBridge: () => ({ watch(workspaces) { calls.push(["watch", workspaces]); return true; } }),
    });

    await watcher.initialize();

    assert.deepEqual(calls, [
      "migrate",
      "read",
      ["watch", [{ id: "local", name: "Local", workspaceType: "local" }]],
    ]);
  });

  it("refreshes from canonical state after runtime add and remove mutations", async () => {
    const watched = [];
    const state = { workspaces: [{ id: "first", workspaceType: "local" }] };
    const watcher = createWorkspaceActivityWatcher({
      workspaceStore: {
        async migrateLegacyElectronWorkspaceStateIfNeeded() {},
        async readWorkspaceState() { return structuredClone(state); },
      },
      getBridge: () => ({ watch(workspaces) { watched.push(workspaces.map(({ id }) => id)); return true; } }),
    });

    await watcher.refresh();
    await watcher.mutate(async () => { state.workspaces.push({ id: "second", workspaceType: "local" }); });
    await watcher.mutate(async () => { state.workspaces = state.workspaces.filter(({ id }) => id !== "first"); });

    assert.deepEqual(watched, [["first"], ["first", "second"], ["second"]]);
  });

  it("ignores malformed state and entries without subscribing to invalid workspaces", async () => {
    let state;
    const watched = [];
    const watcher = createWorkspaceActivityWatcher({
      workspaceStore: {
        async migrateLegacyElectronWorkspaceStateIfNeeded() {},
        async readWorkspaceState() { return state; },
      },
      getBridge: () => ({ watch(workspaces) { watched.push(workspaces); return true; } }),
    });
    for (state of [undefined, null, "state", 42, {}, { workspaces: null }, { workspaces: {} }]) {
      assert.equal(await watcher.refresh(), state);
    }
    assert.deepEqual(watched, Array.from({ length: 7 }, () => []));
    const local = { id: "local", name: "Local", workspaceType: "local" };
    const legacy = { id: "legacy" };
    state = { workspaces: [null, undefined, 1, "workspace", {}, { id: "" }, { id: 2 },
      { id: "bad-name", name: {} }, { id: "remote", workspaceType: "remote" }, local, legacy] };
    await watcher.refresh();
    assert.deepEqual(watched.at(-1), [local, legacy]);
  });
});

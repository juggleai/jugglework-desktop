import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CodexProcessManagerError, createCodexProcessManager, resolveBundledCodexCommand } from "./codex-process-manager.mjs";

function fixture() {
  const brokers = [];
  const clients = [];
  const invalidations = [];
  const tokenProvider = {
    async getToken() { throw new Error("not used by fake broker"); },
    invalidate(input) { invalidations.push(input); },
  };
  const createBroker = () => {
    const broker = {
      disposed: false,
      async start(binding) {
        broker.binding = binding;
        return { baseUrl: "http://127.0.0.1:41234/private-path/v1", localSecret: "local-secret" };
      },
      async dispose() { broker.disposed = true; },
    };
    brokers.push(broker);
    return broker;
  };
  const createClient = (options) => {
    const client = {
      options,
      running: false,
      closed: false,
      async initialize() {
        client.running = true;
        return { codexHome: options.env.CODEX_HOME };
      },
      snapshot() { return { running: client.running }; },
      async close() { client.running = false; client.closed = true; },
      crash() { client.running = false; options.onExit?.({ code: 1, signal: null }); },
    };
    clients.push(client);
    return client;
  };
  return { tokenProvider, createBroker, createClient, brokers, clients, invalidations };
}

async function setup() {
  const f = fixture();
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "jugglework-codex-manager-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jugglework-workspace-"));
  const manager = createCodexProcessManager({
    ...f,
    userDataPath,
    command: "/application/sidecars/codex-test",
    platform: "darwin",
  });
  return { ...f, userDataPath, cwd, manager };
}

const startInput = (cwd, overrides = {}) => ({
  organizationId: "org_1",
  workspaceId: "ws_1",
  workspaceType: "local",
  deviceId: "device_1",
  providerId: "lpr_gateway",
  model: "gpt-5.6-terra",
  cwd,
  ...overrides,
});

describe("Codex process manager", () => {
  it("lazily starts and reuses one healthy isolated App Server per local workspace", async () => {
    const f = await setup();
    const first = await f.manager.startWorkspace(startInput(f.cwd));
    const second = await f.manager.startWorkspace(startInput(f.cwd));
    assert.equal(first, second);
    assert.equal(f.clients.length, 1);
    assert.equal(f.brokers.length, 1);
    assert.equal(f.clients[0].options.cwd, await import("node:fs/promises").then(({ realpath }) => realpath(f.cwd)));
    assert.match(f.clients[0].options.env.CODEX_HOME, new RegExp(`^${f.userDataPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(f.clients[0].options.env.JUGGLEWORK_CODEX_LOCAL_SECRET, "local-secret");
    const config = await readFile(path.join(f.clients[0].options.env.CODEX_HOME, "config.toml"), "utf8");
    assert.doesNotMatch(config, /local-secret/);
    assert.deepEqual(f.manager.status("ws_1"), {
      workspaceId: "ws_1", organizationId: "org_1", state: "ready", running: true,
      model: "gpt-5.6-terra", failureCode: null,
    });
    assert.doesNotMatch(JSON.stringify(f.manager.status()), /local-secret|private-path|127\.0\.0\.1/);
    assert.deepEqual(f.manager.capabilitySnapshot("ws_1"), { mcpCount: 0, skills: [] });
    assert.equal(f.manager.capabilitySnapshot("missing"), null);
  });

  it("rejects remote workspaces before starting any child", async () => {
    const f = await setup();
    await assert.rejects(
      f.manager.startWorkspace(startInput(f.cwd, { workspaceType: "remote" })),
      (error) => error instanceof CodexProcessManagerError && error.code === "local_workspace_required",
    );
    assert.equal(f.clients.length, 0);
  });

  it("stops an organization, clears credentials and permits a clean restart", async () => {
    const f = await setup();
    await f.manager.startWorkspace(startInput(f.cwd));
    await f.manager.stopOrganization("org_1");
    assert.equal(f.clients[0].closed, true);
    assert.equal(f.brokers[0].disposed, true);
    assert.equal(f.manager.status("ws_1"), null);
    assert.deepEqual(f.invalidations, [{ organizationId: "org_1" }]);
    await f.manager.startWorkspace(startInput(f.cwd));
    assert.equal(f.clients.length, 2);
  });

  it("converges crash state and application disposal without leaking secrets", async () => {
    const f = await setup();
    await f.manager.startWorkspace(startInput(f.cwd));
    f.clients[0].crash();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.manager.status("ws_1"), {
      workspaceId: "ws_1", organizationId: "org_1", state: "crashed", running: false,
      model: "gpt-5.6-terra", failureCode: "runtime_exited",
    });
    assert.equal(f.brokers[0].disposed, true);
    await f.manager.dispose();
    assert.deepEqual(f.invalidations, [undefined]);
  });

  it("never reads or overwrites a separate global Codex home", async () => {
    const f = await setup();
    const globalHome = await mkdtemp(path.join(os.tmpdir(), "user-global-codex-"));
    const marker = path.join(globalHome, "config.toml");
    await writeFile(marker, "global-user-setting = true\n");
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = globalHome;
    try {
      await f.manager.startWorkspace(startInput(f.cwd));
      assert.notEqual(f.clients[0].options.env.CODEX_HOME, globalHome);
      assert.equal(await readFile(marker, "utf8"), "global-user-setting = true\n");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe("bundled Codex command resolution", () => {
  it("selects fixed macOS and Windows sidecars without consulting PATH", () => {
    assert.equal(resolveBundledCodexCommand({ desktopRoot: "/app", platform: "darwin", arch: "arm64" }), "/app/resources/sidecars/codex-aarch64-apple-darwin");
    assert.equal(resolveBundledCodexCommand({ packaged: true, resourcesPath: "C:\\resources", platform: "win32", arch: "x64" }), path.join("C:\\resources", "sidecars", "codex-x86_64-pc-windows-msvc.exe"));
  });
});

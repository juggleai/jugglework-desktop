import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readJuggleWorkWorkspaceConfig } from "./jugglework-workspace-config-store.js";
import type { ServerConfig } from "./types.js";
import {
  deriveWorkspaceKey,
  ensureWorkspaceKey,
  MAX_WORKSPACE_KEY_LENGTH,
  readInstallId,
  resetInstallIdCacheForTests,
} from "./workspace-key.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.JUGGLEWORK_RUNTIME_DB;

afterEach(async () => {
  resetInstallIdCacheForTests();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
  else process.env.JUGGLEWORK_RUNTIME_DB = previousRuntimeDb;
});

async function serverConfig(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-workspace-key-"));
  roots.push(root);
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test",
    hostToken: "host",
    configPath: join(root, "jugglework.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("workspace key", () => {
  test("derives an opaque key that fits the cloud column and carries no path", () => {
    const key = deriveWorkspaceKey("ws_abc", "install-1");
    expect(key).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(key.length).toBeLessThanOrEqual(MAX_WORKSPACE_KEY_LENGTH);
    expect(deriveWorkspaceKey("ws_abc", "install-1")).toBe(key);
  });

  test("a different install id yields a different key for the same workspace", () => {
    expect(deriveWorkspaceKey("ws_abc", "install-1")).not.toBe(deriveWorkspaceKey("ws_abc", "install-2"));
  });

  test("persists on first read and stays stable afterwards", async () => {
    const config = await serverConfig();
    const first = await ensureWorkspaceKey(config, "ws_one");
    expect(first).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(await readJuggleWorkWorkspaceConfig(config, "ws_one")).toMatchObject({ workspaceKey: first });

    // A changed derivation rule must not re-key an existing workspace: the stored
    // value wins, so cloud-side policy stays attached to the same key.
    resetInstallIdCacheForTests();
    expect(await ensureWorkspaceKey(config, "ws_one")).toBe(first);
  });

  test("two workspaces on one install get distinct keys", async () => {
    const config = await serverConfig();
    expect(await ensureWorkspaceKey(config, "ws_one")).not.toBe(await ensureWorkspaceKey(config, "ws_two"));
  });

  test("the install id survives the in-process cache being dropped", async () => {
    const config = await serverConfig();
    const first = await readInstallId(config);
    resetInstallIdCacheForTests();
    expect(await readInstallId(config)).toBe(first);
  });

  test("an empty workspace id yields no key", async () => {
    expect(await ensureWorkspaceKey(await serverConfig(), "  ")).toBe("");
  });
});

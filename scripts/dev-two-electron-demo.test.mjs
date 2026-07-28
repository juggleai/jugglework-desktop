import assert from "node:assert/strict";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDemoRun,
  demoEnv,
  existingDemoRun,
  parseDemoProcessIds,
  resetDemoData,
  resolveDemoRoot
} from "./dev-two-electron-demo.mjs";

test("finds stale launchers and profile processes while excluding the current reset", () => {
  const output = [
    "101 node /repo/scripts/dev-two-electron-demo.mjs",
    "102 /bin/sh -c cd /repo && pnpm demo:electron",
    "103 Electron --user-data-dir=/tmp/demo-root/run-old/demo-a",
    "104 node /repo/scripts/dev-two-electron-demo.mjs --reset-only",
    "105 /bin/zsh -lc node /repo/scripts/dev-two-electron-demo.mjs --reset-only",
    "106 unrelated-process",
  ].join("\n");

  assert.deepEqual(
    parseDemoProcessIds(output, {
      demoRootPath: "/tmp/demo-root",
      repoRootPath: "/repo",
      currentPid: 104,
      parentPid: 105,
    }),
    [101, 102, 103],
  );
});

test("uses a non-production temporary demo root by default", () => {
  const root = resolveDemoRoot({});

  assert.equal(root, path.join(os.tmpdir(), "jugglework-two-electron-demo"));
  assert.notEqual(root, path.join(os.homedir(), ".jugglework"));
});

test("honors an explicit demo root", () => {
  assert.equal(
    resolveDemoRoot({
      JUGGLEWORK_ELECTRON_DEMO_ROOT: " /tmp/jugglework-custom-demo "
    }),
    "/tmp/jugglework-custom-demo"
  );
});

test("creates fresh, independent folders for every demo launch", async context => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "jugglework-demo-test-"));
  context.after(() => rm(testRoot, { recursive: true, force: true }));

  const first = await createDemoRun(testRoot);
  const second = await createDemoRun(testRoot);

  assert.notEqual(first.runRoot, second.runRoot);
  assert.notEqual(first.admin.root, first.consumer.root);
  assert.equal(path.dirname(first.admin.root), first.runRoot);
  assert.equal(path.dirname(first.consumer.root), first.runRoot);

  for (const paths of [
    first.admin,
    first.consumer,
    second.admin,
    second.consumer
  ]) {
    assert.equal((await stat(paths.userDataDir)).isDirectory(), true);
    assert.equal((await stat(paths.dataDir)).isDirectory(), true);
    assert.equal((await stat(paths.homeDir)).isDirectory(), true);
    assert.equal((await stat(paths.configHome)).isDirectory(), true);
  }
});

test("reopens the same prepared profile pair without falling back to another profile", async context => {
  const testRoot = await mkdtemp(path.join(os.tmpdir(), "jugglework-demo-reopen-test-"));
  context.after(() => rm(testRoot, { recursive: true, force: true }));
  const prepared = await createDemoRun(testRoot);
  const reopened = existingDemoRun(prepared.runRoot);

  assert.deepEqual(reopened, prepared);
});

test("reset removes all prior demo runs from the configured root", async context => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "jugglework-demo-reset-test-")
  );
  context.after(() => rm(testRoot, { recursive: true, force: true }));
  const run = await createDemoRun(testRoot);

  await resetDemoData(testRoot);

  await assert.rejects(access(run.runRoot));
});

test("points each Electron instance at its own profile folders", async context => {
  const testRoot = await mkdtemp(
    path.join(os.tmpdir(), "jugglework-demo-env-test-")
  );
  context.after(() => rm(testRoot, { recursive: true, force: true }));
  const run = await createDemoRun(testRoot);
  const profile = {
    appIdentifier: "com.example.demo",
    appName: "Demo"
  };

  const adminEnv = demoEnv(profile, run.admin, "5273", "9923");
  const consumerEnv = demoEnv(profile, run.consumer, "5274", "9924");

  assert.equal(adminEnv.JUGGLEWORK_ELECTRON_USERDATA, run.admin.userDataDir);
  assert.equal(adminEnv.JUGGLEWORK_DATA_DIR, run.admin.dataDir);
  assert.equal(adminEnv.HOME, run.admin.homeDir);
  assert.equal(adminEnv.XDG_CONFIG_HOME, run.admin.configHome);
  assert.equal(adminEnv.XDG_DATA_HOME, run.admin.dataHome);
  assert.equal(adminEnv.XDG_CACHE_HOME, run.admin.cacheHome);
  assert.equal(adminEnv.XDG_STATE_HOME, run.admin.stateHome);
  assert.equal(adminEnv.JUGGLEWORK_ENV_STORE, run.admin.envStorePath);
  assert.equal(adminEnv.OPENCODE_CONFIG_DIR, run.admin.opencodeConfigDir);
  assert.equal(adminEnv.APPDATA, run.admin.appDataDir);
  assert.equal(adminEnv.LOCALAPPDATA, run.admin.localAppDataDir);
  assert.equal(adminEnv.JUGGLEWORK_DEV_MODE, "1");
  assert.equal(adminEnv.JUGGLEWORK_ELECTRON_USE_MOCK_KEYCHAIN, "1");
  assert.equal(adminEnv.JUGGLEWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION, "1");
  assert.equal(
    consumerEnv.JUGGLEWORK_ELECTRON_USERDATA,
    run.consumer.userDataDir
  );
  assert.equal(consumerEnv.JUGGLEWORK_DATA_DIR, run.consumer.dataDir);
  assert.notEqual(
    adminEnv.JUGGLEWORK_ELECTRON_USERDATA,
    consumerEnv.JUGGLEWORK_ELECTRON_USERDATA
  );
  assert.notEqual(adminEnv.JUGGLEWORK_DATA_DIR, consumerEnv.JUGGLEWORK_DATA_DIR);
  assert.notEqual(adminEnv.HOME, consumerEnv.HOME);
  assert.notEqual(adminEnv.XDG_CONFIG_HOME, consumerEnv.XDG_CONFIG_HOME);
  assert.notEqual(adminEnv.JUGGLEWORK_ENV_STORE, consumerEnv.JUGGLEWORK_ENV_STORE);
  assert.notEqual(adminEnv.OPENCODE_CONFIG_DIR, consumerEnv.OPENCODE_CONFIG_DIR);
});

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EmbeddedServerHandle } from "jugglework-server";
import { parseCliArgs } from "../src/args.js";
import {
  cliRuntimePaths,
  createRuntime,
  REQUIRED_PLUGIN_FILES,
  resolveOpenCodeBinary,
  resolvePluginDirectory,
} from "../src/runtime.js";

async function writePlugins(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  for (const filename of REQUIRED_PLUGIN_FILES) {
    await writeFile(join(path, filename), "export default {}\n");
  }
}

test("resolves explicit executable and validates required plugin assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-runtime-"));
  const executable = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  const plugins = join(root, "plugins");
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(executable, 0o700);
    await mkdir(plugins);
    assert.equal(await resolveOpenCodeBinary(executable), executable);
    assert.notEqual(await resolvePluginDirectory(plugins, executable), plugins);
    for (const filename of REQUIRED_PLUGIN_FILES.slice(0, -1)) {
      await writeFile(join(plugins, filename), "export default {}\n");
    }
    assert.notEqual(await resolvePluginDirectory(plugins, executable), plugins);
    await writeFile(join(plugins, REQUIRED_PLUGIN_FILES.at(-1)!), "export default {}\n");
    assert.equal(await resolvePluginDirectory(plugins, executable), plugins);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid configured runtime paths do not fall through to discovered assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-runtime-strict-"));
  const executable = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  const plugins = join(root, "plugins");
  const previousBin = process.env.JUGGLEWORK_OPENCODE_BIN;
  const previousPlugins = process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR;
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(executable, 0o700);
    await writePlugins(plugins);
    process.env.JUGGLEWORK_OPENCODE_BIN = executable;
    process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR = plugins;
    assert.equal(await resolveOpenCodeBinary(join(root, "missing-opencode")), null);
    assert.equal(await resolvePluginDirectory(join(root, "missing-plugins"), executable), null);
    await assert.rejects(
      createRuntime(parseCliArgs(["--opencode-bin", join(root, "missing-opencode")])),
      /Configured OpenCode binary is not an executable file/,
    );
    await assert.rejects(
      createRuntime(parseCliArgs(["--opencode-bin", executable, "--plugin-dir", join(root, "missing-plugins")])),
      /Configured plugin directory is missing one or more required JuggleWork plugin assets/,
    );
  } finally {
    if (previousBin === undefined) delete process.env.JUGGLEWORK_OPENCODE_BIN;
    else process.env.JUGGLEWORK_OPENCODE_BIN = previousBin;
    if (previousPlugins === undefined) delete process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR;
    else process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR = previousPlugins;
    await rm(root, { recursive: true, force: true });
  }
});

test("owned runtime forces per-workspace storage and restores inherited environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-runtime-env-"));
  const executable = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  const plugins = join(root, "plugins");
  const workspace = join(root, "workspace");
  const inherited = {
    JUGGLEWORK_RUNTIME_DB: process.env.JUGGLEWORK_RUNTIME_DB,
    JUGGLEWORK_EXTENSIONS_PLUGIN_DIR: process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR,
  };
  const desktopDb = join(root, "desktop", "runtime.sqlite");
  let stopped = false;
  try {
    await mkdir(workspace);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(executable, 0o700);
    await writePlugins(plugins);
    process.env.JUGGLEWORK_RUNTIME_DB = desktopDb;
    process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR = join(root, "desktop-plugins");
    const options = parseCliArgs(["--workspace", workspace, "--opencode-bin", executable, "--plugin-dir", plugins]);
    const paths = cliRuntimePaths(workspace);
    const runtime = await createRuntime(options, {
      startEmbeddedServer: async (input) => {
        assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, paths.database);
        assert.equal(process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR, plugins);
        assert.equal(typeof input.logger?.log, "function");
        return {
          url: "http://127.0.0.1:12345",
          stop: async () => {
            assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, paths.database);
            stopped = true;
          },
        } as EmbeddedServerHandle;
      },
    });
    assert.notEqual(paths.database, desktopDb);
    assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, paths.database);
    await runtime.stop();
    await runtime.stop();
    assert.equal(stopped, true);
    assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, desktopDb);
    assert.equal(process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR, join(root, "desktop-plugins"));
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("owned runtime restores environment when embedded startup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-runtime-failure-"));
  const executable = join(root, process.platform === "win32" ? "opencode.exe" : "opencode");
  const plugins = join(root, "plugins");
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  try {
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    if (process.platform !== "win32") await chmod(executable, 0o700);
    await writePlugins(plugins);
    process.env.JUGGLEWORK_RUNTIME_DB = "inherited-desktop.sqlite";
    const options = parseCliArgs(["--opencode-bin", executable, "--plugin-dir", plugins]);
    await assert.rejects(
      createRuntime(options, { startEmbeddedServer: async () => { throw new Error("startup failed"); } }),
      /startup failed/,
    );
    assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, "inherited-desktop.sqlite");
  } finally {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});

test("connected mode does not require or mutate local runtime assets", async () => {
  const before = { ...process.env };
  const options = parseCliArgs([
    "--server", "https://server.example.test/", "--token", "connected-token",
    "--opencode-bin", "/definitely/missing/opencode", "--plugin-dir", "/definitely/missing/plugins",
  ]);
  const runtime = await createRuntime(options, {
    startEmbeddedServer: async () => { throw new Error("must not start an owned runtime"); },
  });
  assert.equal(runtime.url, "https://server.example.test");
  assert.equal(runtime.token, "connected-token");
  assert.equal(runtime.owned, false);
  await runtime.stop();
  assert.deepEqual(process.env, before);
});

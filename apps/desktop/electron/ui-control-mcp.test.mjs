import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bundledUiControlMcpPath,
  getJuggleWorkUiMcpCommand,
  getJuggleWorkUiMcpEnvironment,
  installBundledUiControlMcp,
  packagedUiControlMcpRuntime,
} from "./ui-control-mcp.mjs";

test("packaged UI control MCP uses the application runtime and bundled resource", () => {
  const resourcesPath = path.join(path.sep, "Applications", "JuggleWork.app", "Contents", "Resources");
  const executablePath = path.join(path.sep, "Applications", "JuggleWork.app", "Contents", "MacOS", "JuggleWork");
  const expectedEntry = bundledUiControlMcpPath(resourcesPath);
  const command = getJuggleWorkUiMcpCommand({
    packaged: true,
    executablePath,
    resourcesPath,
    pathExists: (candidate) => candidate === expectedEntry,
  });

  assert.deepEqual(command, [executablePath, expectedEntry]);
  assert.equal(command.some((part) => /(?:^|[/\\])npx(?:\.cmd)?$/i.test(part)), false);
  assert.equal(command.some((part) => part === "node" || part === "npm"), false);
});

test("development UI control MCP uses source with the current Electron runtime", () => {
  const command = getJuggleWorkUiMcpCommand({
    packaged: false,
    executablePath: "/path/to/Electron",
    sourcePath: "/repo/packages/jugglework-ui-mcp/index.mjs",
    pathExists: () => true,
  });
  assert.deepEqual(command, ["/path/to/Electron", "/repo/packages/jugglework-ui-mcp/index.mjs"]);
});

test("packaged UI control MCP fails closed when its resource is missing", () => {
  assert.throws(
    () => getJuggleWorkUiMcpCommand({
      packaged: true,
      executablePath: "/Applications/JuggleWork.app/Contents/MacOS/JuggleWork",
      resourcesPath: "/Applications/JuggleWork.app/Contents/Resources",
      pathExists: () => false,
    }),
    /missing from this JuggleWork build/,
  );
});

test("UI control MCP environment enables Electron Node mode and runtime discovery", () => {
  const environment = getJuggleWorkUiMcpEnvironment("/Users/test/Library/Application Support/com.juggleai.jugglework");
  assert.deepEqual(environment, {
    ELECTRON_RUN_AS_NODE: "1",
    JUGGLEWORK_UI_CONTROL_DISCOVERY: path.join(
      "/Users/test/Library/Application Support/com.juggleai.jugglework",
      "jugglework-ui-control.json",
    ),
  });
});

test("Linux AppImage uses the stable original executable", () => {
  assert.equal(packagedUiControlMcpRuntime({
    platform: "linux",
    executablePath: "/tmp/.mount_juggle/JuggleWork",
    appImagePath: "/home/test/JuggleWork.AppImage",
  }), "/home/test/JuggleWork.AppImage");
});

test("bundled UI control MCP is copied to a stable versioned profile path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-ui-mcp-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const source = bundledUiControlMcpPath(resources);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "bundled-ui-mcp");
  const installed = await installBundledUiControlMcp({ resourcesPath: resources, userDataPath: path.join(root, "profile"), version: "1.2.13" });
  assert.equal(installed, path.join(root, "profile", "runtime", "jugglework-ui-mcp", "1.2.13", "index.mjs"));
  assert.equal(await readFile(installed, "utf8"), "bundled-ui-mcp");
});

test("concurrent bundled UI control MCP installs do not share a temporary file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-ui-mcp-concurrent-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const source = bundledUiControlMcpPath(resources);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, "bundled-ui-mcp");
  const options = { resourcesPath: resources, userDataPath: path.join(root, "profile"), version: "1.2.13" };

  const installed = await Promise.all([
    installBundledUiControlMcp(options),
    installBundledUiControlMcp(options),
    installBundledUiControlMcp(options),
  ]);

  assert.equal(new Set(installed).size, 1);
  assert.equal(await readFile(installed[0], "utf8"), "bundled-ui-mcp");
});

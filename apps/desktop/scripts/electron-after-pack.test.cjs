const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeArch,
  runAfterPack,
  targetTriple,
} = require("./electron-after-pack.cjs");

test("normalizes electron-builder numeric and string architectures", () => {
  assert.equal(normalizeArch(1), "x64");
  assert.equal(normalizeArch(3), "arm64");
  assert.equal(normalizeArch("x86_64"), "x64");
  assert.equal(normalizeArch("aarch64"), "arm64");
  assert.equal(normalizeArch(0), null);
  assert.equal(normalizeArch("universal"), null);

  assert.equal(targetTriple("darwin", 1), "x86_64-apple-darwin");
  assert.equal(targetTriple("darwin", 3), "aarch64-apple-darwin");
  assert.equal(targetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(targetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
});

test("selects only the requested sidecar and processes the macOS helper", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jugglework-after-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const appOutDir = path.join(root, "output");
  const sidecarsDir = path.join(appOutDir, "JuggleWork.app", "Contents", "Resources", "sidecars");
  const uiControlMcpDir = path.join(appOutDir, "JuggleWork.app", "Contents", "Resources", "jugglework-ui-mcp");
  const sqlitePrebuildsDir = path.join(
    appOutDir,
    "JuggleWork.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "prebuilds",
  );
  fs.mkdirSync(sidecarsDir, { recursive: true });
  fs.mkdirSync(uiControlMcpDir, { recursive: true });
  fs.mkdirSync(sqlitePrebuildsDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarsDir, "opencode-aarch64-apple-darwin"), "arm64");
  fs.writeFileSync(path.join(sidecarsDir, "opencode-x86_64-apple-darwin"), "x64");
  fs.writeFileSync(path.join(sidecarsDir, "versions.json-aarch64-apple-darwin"), "arm64 metadata");
  fs.writeFileSync(path.join(sidecarsDir, "versions.json-x86_64-apple-darwin"), "x64 metadata");
  fs.writeFileSync(path.join(sqlitePrebuildsDir, "darwin-arm64.node"), "arm64 native module");
  fs.writeFileSync(path.join(sqlitePrebuildsDir, "darwin-x64.node"), "x64 native module");
  fs.writeFileSync(path.join(sqlitePrebuildsDir, "linux-arm64.node"), "linux native module");
  fs.writeFileSync(path.join(uiControlMcpDir, "index.mjs"), 'const name = "jugglework-ui";');

  const context = {
    appOutDir,
    arch: 3,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "JuggleWork" } },
  };
  let helperContext = null;

  await runAfterPack(context, {
    verifyContracts() {},
    verifyUiControlMcpRuntime() {},
    signHelper(receivedContext) {
      helperContext = receivedContext;
    },
  });

  assert.equal(fs.readFileSync(path.join(sidecarsDir, "opencode"), "utf8"), "arm64");
  assert.equal(fs.readFileSync(path.join(sidecarsDir, "versions.json"), "utf8"), "arm64 metadata");
  assert.deepEqual(fs.readdirSync(sidecarsDir).sort(), [
    "opencode",
    "opencode-aarch64-apple-darwin",
    "versions.json",
    "versions.json-aarch64-apple-darwin",
  ]);
  assert.deepEqual(fs.readdirSync(sqlitePrebuildsDir), ["darwin-arm64.node"]);
  assert.equal(helperContext, context);
});

test("skips architecture processing for unsupported targets", async () => {
  let signed = false;
  await runAfterPack(
    { appOutDir: "/unused", arch: 0, electronPlatformName: "darwin" },
    {
      verifyContracts() {},
      verifyUiControlMcp() {},
      verifyUiControlMcpRuntime() {},
      signHelper() {
        signed = true;
      },
    },
  );
  assert.equal(signed, false);
});

test("rejects packages missing the bundled UI control MCP", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jugglework-after-pack-ui-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appOutDir = path.join(root, "output");
  fs.mkdirSync(path.join(appOutDir, "JuggleWork.app", "Contents", "Resources"), { recursive: true });

  await assert.rejects(
    runAfterPack(
      {
        appOutDir,
        arch: 0,
        electronPlatformName: "darwin",
        packager: { appInfo: { productFilename: "JuggleWork" } },
      },
      { verifyContracts() {}, verifyUiControlMcpRuntime() {}, signHelper() {} },
    ),
    /Missing packaged JuggleWork UI control MCP/,
  );
});

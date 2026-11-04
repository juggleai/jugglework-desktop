import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { parse } from "yaml";
import { buildFileWindowPreload } from "./build-file-window-preload.mjs";

test("bundled preload executes with only sandbox electron require and retains the limited bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-preload-build-"));
  try {
    const output = await buildFileWindowPreload({ output: join(root, "preload.cjs") });
    const calls = [];
    /** @type {any} */
    let bridge;
    vm.runInNewContext(await readFile(output, "utf8"), {
      process: { platform: "darwin" },
      require(name) {
        assert.equal(name, "electron");
        return {
          contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "__JUGGLEWORK_ELECTRON__"); bridge = value; } },
          ipcRenderer: { on() {}, invoke(...args) { calls.push(args); return Promise.resolve("fixture"); } },
        };
      },
    });
    assert.deepEqual(Object.keys(bridge).sort(), ["fileEditor", "fileWindow", "invokeDesktop", "office", "platform"]);
    await bridge.invokeDesktop("__setNativeTheme", "dark");
    await bridge.invokeDesktop("__setApplicationMenuVisible", false);
    assert.equal(calls.length, 0);
    assert.throws(() => bridge.invokeDesktop("__arbitraryCommand"), /文件窗口不支持此操作/);
    assert.equal(await bridge.fileWindow.state(), "fixture");
    assert.equal(await bridge.office.resources("doc"), "fixture");
    assert.equal(await bridge.fileEditor.state({ path: "notes.md" }), "fixture");
    assert.deepEqual(calls.map(([name]) => name), ["jugglework:file-window:state", "jugglework:office:resources", "jugglework:file-editor:state"]);

    const badInput = join(root, "bad.mjs");
    await writeFile(badInput, 'import fs from "node:fs"; globalThis.leak = fs;');
    await assert.rejects(buildFileWindowPreload({ input: badInput, output }), /Could not resolve "node:fs"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build, dev and packaged Main share the generated preload path", async () => {
  const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
  const main = await read("../electron/main.mjs");
  assert.match(main, /preloadPath: path\.join\(__dirname, "\.\.\/dist\/preload\/file-window-preload\.cjs"\)/);
  for (const entry of ["./electron-build.mjs", "./electron-dev.mjs"]) {
    const source = await read(entry);
    const build = source.indexOf('"build-file-window-preload.mjs"');
    assert.ok(build > source.indexOf('"build:electron-runtime"'), entry);
    const launch = entry.includes("dev") ? source.indexOf('electronChild = run(') : source.indexOf('"check-electron-bridge.mjs"');
    assert.ok(build < launch, entry);
  }
  const config = parse(await read("../electron-builder.yml"));
  assert.ok(config.files.includes("dist/preload/**/*"));
  assert.ok(config.files.includes("electron/**/*"));
});

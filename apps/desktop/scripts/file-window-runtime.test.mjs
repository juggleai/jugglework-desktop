import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPackage } from "@electron/asar";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../", import.meta.url));

test("Electron argv resolves bundled shared file formats in development and packaged asar layouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "file-window-runtime-"));
  try {
    const staging = path.join(root, "staging");
    await mkdir(path.join(staging, "electron"), { recursive: true });
    await mkdir(path.join(staging, "dist/runtime"), { recursive: true });
    const runtime = path.join(desktop, "dist/runtime/file-window.js");
    const code = await readFile(runtime, "utf8");
    assert.doesNotMatch(code, /(?:from\s*|import\s*\()["'][^"']+(?:\.ts|@jugglework\/types)/);
    await copyFile(runtime, path.join(staging, "dist/runtime/file-window.js"));
    await copyFile(path.join(desktop, "electron/system-file-opening.mjs"), path.join(staging, "electron/system-file-opening.mjs"));
    await writeFile(path.join(staging, "package.json"), JSON.stringify({ type: "module" }));
    const archive = path.join(root, "app.asar");
    await createPackage(staging, archive);
    for (const layout of [desktop, archive]) {
      const helper = pathToFileURL(path.join(layout, "dist/runtime/file-window.js")).href;
      const argv = pathToFileURL(path.join(layout, "electron/system-file-opening.mjs")).href;
      const expression = `
        const assert = require('node:assert/strict');
        (async () => {
          assert.ok(process.versions.electron);
          const { FILE_WINDOW_EXTENSIONS, isSupportedFileWindowPath, isSupportedWorkspaceTextFilePath } = await import(${JSON.stringify(helper)});
          const { systemOfficeFilePaths, secondInstanceOfficeFilePaths } = await import(${JSON.stringify(argv)});
          assert.ok(FILE_WINDOW_EXTENSIONS.includes('md'));
          assert.equal(isSupportedFileWindowPath('说明.MD'), true);
          assert.equal(isSupportedWorkspaceTextFilePath('说明.MD'), true);
          assert.equal(isSupportedWorkspaceTextFilePath('报告.pdf'), false);
          assert.deepEqual(systemOfficeFilePaths(['JuggleWork', '说明.MD', '报告.pdf', '旧表.xls', '开放表.ods', '--user-data-dir', 'profile.md', 'jugglework://open/doc.md'], { platform: 'darwin', cwd: '/资料' }),
            ['/资料/说明.MD', '/资料/报告.pdf', '/资料/旧表.xls', '/资料/开放表.ods']);
          const files = systemOfficeFilePaths(['JuggleWork', '说明.MD', '报告.pdf'], { platform: 'darwin', cwd: '/资料' });
          const payload = JSON.parse(JSON.stringify({ systemFileOpening: { version: 1, files: [...files, files[0]] } }));
          assert.deepEqual(secondInstanceOfficeFilePaths(['JuggleWork', '错误回退.xlsx'], payload, { platform: 'darwin', cwd: '/资料' }),
            ['/资料/说明.MD', '/资料/报告.pdf']);
          console.log('file-window-runtime-ok');
        })().catch(error => { console.error(error); process.exitCode = 1; });`;
      const result = spawnSync(require("electron"), ["-e", expression], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 20000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, `${layout}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /file-window-runtime-ok/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

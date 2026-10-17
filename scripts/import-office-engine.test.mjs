import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { importOfficeEngine } from "./import-office-engine.mjs";

test("可以跨平台导入本地 Windows 与 Intel SDK，保留独立平台清单并排除临时输出", (t) => {
  const root = mkdtempSync(join(tmpdir(), "office-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "resources");
  const put = (name, value) => {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    writeFileSync(join(source, name), value);
  };
  put("package.json", JSON.stringify({ version: "0.2.196-wb" }));
  put("editor-sdk-version.json", JSON.stringify({ version: "0.0.0.499" }));
  put("lib/common/tencent-docs-service.js", "module.exports={}");
  put("scripts/editor-sdk-platforms.js", "module.exports={}");
  for (const platform of ["win32-x64", "darwin-x64"]) {
    const executable = platform.startsWith("win32")
      ? "editor_sdk.exe"
      : "editor_sdk";
    put(`bin/${platform}/${executable}`, "native");
    put(`bin/${platform}/.editor-sdk-version`, "0.0.0.499");
    put(`bin/${platform}/tmp/private.txt`, "runtime");
    const manifest = importOfficeEngine(source, destination, platform);
    assert.equal(manifest.platform, platform);
    assert.equal(existsSync(join(destination, manifest.binary)), true);
    assert.equal(existsSync(join(destination, platform, "tmp")), false);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(destination, platform, "version.json"), "utf8"),
      ),
      manifest,
    );
  }
  assert.equal(existsSync(join(destination, "win32-x64/version.json")), true);
  assert.throws(
    () => importOfficeEngine(source, destination, "darwin-arm64"),
    /缺少.*原生引擎/,
  );
});

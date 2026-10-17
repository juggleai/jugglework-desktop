import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importOfficeEngine } from "./import-office-engine.mjs";

/** 创建当前资源格式的最小目录，仅验证文件系统保护，不启动 SDK。 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "office-resource-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  put(
    join(source, "wrapper/package.json"),
    JSON.stringify({
      name: "office-docs-ai-engine",
      version: "0.2.196-office.1",
    }),
  );
  for (const name of [
    "office-docs-service",
    "document-types",
    "engine-port-file",
    "editor-sdk-process-launcher",
  ])
    put(join(source, `wrapper/lib/common/${name}.js`), "module.exports={}");
  put(
    join(source, "wrapper/supported-extensions.cjs"),
    "module.exports=['.docx']",
  );
  put(
    join(source, "wrapper/scripts/editor-sdk-platforms.js"),
    "module.exports={}",
  );
  put(join(source, "darwin-arm64/editor_sdk"), "native");
  put(join(source, "darwin-arm64/.editor-sdk-version"), "0.0.0.499");
  const manifest = {
    schema: 1,
    platform: "darwin-arm64",
    wrapperVersion: "0.2.196-office.1",
    engineVersion: "0.0.0.499",
    binary: "darwin-arm64/editor_sdk",
    wrapper: "wrapper/lib/common/office-docs-service.js",
    sha256: createHash("sha256").update("native").digest("hex"),
  };
  put(join(source, "darwin-arm64/version.json"), JSON.stringify(manifest));
  const alias = join(root, "alias");
  symlinkSync(source, alias, process.platform === "win32" ? "junction" : "dir");
  return { root, source, alias, manifest };
}

test("源与目标通过目录别名指向同一资源时保持源文件不变", (t) => {
  const { source, alias, manifest } = fixture(t);
  const pkg = readFileSync(join(source, "wrapper/package.json"), "utf8");
  for (const [input, output] of [
    [source, alias],
    [alias, source],
  ]) {
    assert.deepEqual(
      importOfficeEngine(input, output, "darwin-arm64"),
      manifest,
    );
    assert.equal(
      readFileSync(join(source, "wrapper/package.json"), "utf8"),
      pkg,
    );
    assert.equal(readFileSync(join(source, manifest.binary), "utf8"), "native");
  }
});

test("别名后的尚不存在子目录及祖先目录均不能作为导入目标", (t) => {
  const { root, source, alias } = fixture(t);
  const destination = join(alias, "missing", "nested");
  assert.throws(
    () => importOfficeEngine(source, destination, "darwin-arm64"),
    /不能互相嵌套/,
  );
  assert.equal(existsSync(destination), false);
  const parentAlias = join(root, "parent-alias");
  symlinkSync(
    root,
    parentAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => importOfficeEngine(source, parentAlias, "darwin-arm64"),
    /不能互相嵌套/,
  );
  assert.equal(existsSync(join(source, "wrapper/package.json")), true);
});

test("独立目录导入保留原生字节及其他平台资源", (t) => {
  const { root, source, manifest } = fixture(t);
  const destination = join(root, "destination");
  mkdirSync(join(destination, "darwin-x64"), { recursive: true });
  writeFileSync(join(destination, "darwin-x64/sentinel"), "other platform");
  assert.deepEqual(
    importOfficeEngine(source, destination, "darwin-arm64"),
    manifest,
  );
  assert.equal(
    readFileSync(join(destination, manifest.binary), "utf8"),
    "native",
  );
  assert.equal(
    readFileSync(join(destination, "darwin-x64/sentinel"), "utf8"),
    "other platform",
  );
  assert.equal(readFileSync(join(source, manifest.binary), "utf8"), "native");
});

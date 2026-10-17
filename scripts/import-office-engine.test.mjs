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
import { join, dirname, basename } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { importOfficeEngine } from "./import-office-engine.mjs";

// TIPS: 原始供应字段放在独立样例中，不从生产替换规则派生，防止规则和断言同时出错。
const sourceFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/office-engine-source.json", import.meta.url),
    "utf8",
  ),
);

test("可以跨平台导入本地 Windows 与 Intel SDK，保留独立平台清单并排除临时输出", (t) => {
  const root = mkdtempSync(join(tmpdir(), "office-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    destination = join(root, "resources");
  const put = (name, value) => {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    writeFileSync(join(source, name), value);
  };
  put("package.json", JSON.stringify(sourceFixture.package));
  put("editor-sdk-version.json", JSON.stringify({ version: "0.0.0.499" }));
  put(
    "supported-extensions.cjs",
    "module.exports=['.docx','.csv','.xlsx','.pptx'];",
  );
  const serviceSource = `exports.${sourceFixture.service.exportName} = class {};`;
  put(sourceFixture.service.entry, serviceSource);
  put(
    "lib/common/index.js",
    `module.exports = require('./${basename(sourceFixture.service.entry, ".js")}');`,
  );
  put(
    "lib/common/preview-runtime.js",
    `exports.protocol = ${JSON.stringify(sourceFixture.preview)};`,
  );
  put(
    "lib/common/engine-port-file.js",
    `exports.${sourceFixture.port.environment}_ENV = ${JSON.stringify(sourceFixture.port.environment)}; exports.config = ${JSON.stringify(sourceFixture.port.configEnvironment)};`,
  );
  put("LICENSE", "Original copyright and license notice\n");
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
    assert.equal(manifest.wrapperVersion, "0.2.196-office.1");
    assert.equal(manifest.wrapper, "wrapper/lib/common/office-docs-service.js");
    assert.equal(existsSync(join(destination, manifest.binary)), true);
    assert.equal(
      manifest.sha256,
      createHash("sha256").update("native").digest("hex"),
    );
    assert.equal(existsSync(join(destination, platform, "tmp")), false);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(destination, platform, "version.json"), "utf8"),
      ),
      manifest,
    );
  }
  assert.equal(existsSync(join(destination, "win32-x64/version.json")), true);
  const pkg = JSON.parse(
    readFileSync(join(destination, "wrapper/package.json"), "utf8"),
  );
  assert.equal(pkg.name, "office-docs-ai-engine");
  assert.equal(pkg.version, "0.2.196-office.1");
  assert.equal(pkg.license, "MIT");
  assert.equal(
    existsSync(join(destination, "wrapper/supported-extensions.cjs")),
    true,
  );
  assert.equal(
    existsSync(join(destination, "wrapper", sourceFixture.service.entry)),
    false,
  );
  const require = createRequire(import.meta.url);
  const sdk = require(join(destination, "wrapper"));
  assert.equal(typeof sdk.OfficeDocsService, "function");
  assert.equal(sdk[sourceFixture.service.exportName], undefined);
  assert.equal(
    readFileSync(join(destination, "wrapper/LICENSE"), "utf8"),
    "Original copyright and license notice\n",
  );
  assert.deepEqual(
    require(join(destination, "wrapper/lib/common/engine-port-file.js")),
    {
      OFFICE_DOCS_ENGINE_PORT_FILE_ENV: "OFFICE_DOCS_ENGINE_PORT_FILE",
      config: "JUGGLEWORK_CONFIG_DIR",
    },
  );
  assert.deepEqual(
    require(join(destination, "wrapper/lib/common/preview-runtime.js"))
      .protocol,
    sourceFixture.preview,
  );
  assert.equal(
    readFileSync(join(source, sourceFixture.service.entry), "utf8"),
    serviceSource,
  );
  assert.throws(
    () => importOfficeEngine(source, destination, "darwin-arm64"),
    /缺少.*原生引擎/,
  );
});

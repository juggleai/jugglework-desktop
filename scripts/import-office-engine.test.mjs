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
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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
  put(
    "package.json",
    JSON.stringify({
      name: "@tencent/tencent-docs-ai-engine",
      version: "0.2.196-wb",
      license: "MIT",
      main: "lib/common/index.js",
    }),
  );
  put("editor-sdk-version.json", JSON.stringify({ version: "0.0.0.499" }));
  put(
    "supported-extensions.cjs",
    "module.exports=['.docx','.csv','.xlsx','.pptx'];",
  );
  put(
    "lib/common/tencent-docs-service.js",
    "exports.TencentDocsService = class TencentDocsService {};",
  );
  put(
    "lib/common/index.js",
    "module.exports = require('./tencent-docs-service');",
  );
  put(
    "lib/common/preview-runtime.js",
    "exports.theme = 'workbuddyTheme'; exports.themeMessage = 'workbuddy:themeChanged'; exports.localeMessage = 'workbuddy:localeChanged';",
  );
  put(
    "lib/common/engine-port-file.js",
    "exports.TENCENT_DOCS_ENGINE_PORT_FILE_ENV = 'TENCENT_DOCS_ENGINE_PORT_FILE'; exports.config = 'CODEBUDDY_CONFIG_DIR';",
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
    existsSync(join(destination, "wrapper/lib/common/tencent-docs-service.js")),
    false,
  );
  const sdk = createRequire(import.meta.url)(join(destination, "wrapper"));
  assert.equal(typeof sdk.OfficeDocsService, "function");
  assert.equal(sdk.TencentDocsService, undefined);
  assert.equal(
    readFileSync(join(destination, "wrapper/LICENSE"), "utf8"),
    "Original copyright and license notice\n",
  );
  assert.match(
    readFileSync(
      join(destination, "wrapper/lib/common/engine-port-file.js"),
      "utf8",
    ),
    /OFFICE_DOCS_ENGINE_PORT_FILE/,
  );
  assert.match(
    readFileSync(
      join(destination, "wrapper/lib/common/engine-port-file.js"),
      "utf8",
    ),
    /JUGGLEWORK_CONFIG_DIR/,
  );
  assert.match(
    readFileSync(
      join(destination, "wrapper/lib/common/preview-runtime.js"),
      "utf8",
    ),
    /workbuddy:themeChanged/,
  );
  assert.match(
    readFileSync(join(source, "lib/common/tencent-docs-service.js"), "utf8"),
    /exports.TencentDocsService/,
  );
  assert.throws(
    () => importOfficeEngine(source, destination, "darwin-arm64"),
    /缺少.*原生引擎/,
  );
});

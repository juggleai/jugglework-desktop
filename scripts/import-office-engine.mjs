import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_WRAPPER_VERSION = "0.2.196-office.1";

/**
 * 将固定供应版本的 JS 包装层适配为项目内 Office 命名，保留原生协议和许可文件。
 * @param {string} wrapper 已复制到项目的包装层目录，不修改供应源文件
 */
export function adaptOfficeWrapper(wrapper) {
  const replacements = [
    ["@tencent/tencent-docs-ai-engine", "office-docs-ai-engine"],
    ["TencentDocs", "OfficeDocs"],
    ["TENCENT_DOCS", "OFFICE_DOCS"],
    ["tencent_docs", "office_docs"],
    ["tencent-docs", "office-docs"],
    ["tencent-local-office-edit", "office-local-edit"],
    ["Tencent Docs", "Office Docs"],
    ["Tencent Doc", "Office Doc"],
    ["Tencent-Docs", "Office-Docs"],
    ["Tencent", "Office"],
    ["腾讯", "Office"],
    ["WorkBuddy", "JuggleWork"],
    ["workbuddy", "jugglework"],
    ["CODEBUDDY_CONFIG_DIR", "JUGGLEWORK_CONFIG_DIR"],
    ["CodeBuddy", "JuggleWork"],
  ];
  // TIPS: 这些字符串属于二进制内嵌页面的固定协议，修改会使主题与语言消息失效。
  const nativeProtocol = [
    "workbuddyTheme",
    "workbuddy:themeChanged",
    "workbuddy:localeChanged",
  ];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".js")) {
        let text = readFileSync(file, "utf8");
        nativeProtocol.forEach((value, index) => {
          text = text.replaceAll(value, `__OFFICE_NATIVE_PROTOCOL_${index}__`);
        });
        for (const [source, target] of replacements)
          text = text.replaceAll(source, target);
        nativeProtocol.forEach((value, index) => {
          text = text.replaceAll(`__OFFICE_NATIVE_PROTOCOL_${index}__`, value);
        });
        writeFileSync(file, text);
      }
    }
  }
  visit(join(wrapper, "lib"));
  const preview = join(wrapper, "lib/common/preview-runtime.js");
  const previewTip =
    "// TIPS: 内嵌页面的固定主题/语言协议字段保持原值，避免名称适配破坏消息兼容。\n";
  if (
    existsSync(preview) &&
    !readFileSync(preview, "utf8").startsWith(previewTip)
  )
    writeFileSync(preview, previewTip + readFileSync(preview, "utf8"));
  const sourceEntry = join(wrapper, "lib/common/tencent-docs-service.js");
  if (existsSync(sourceEntry))
    renameSync(sourceEntry, join(wrapper, "lib/common/office-docs-service.js"));
  const pkg = JSON.parse(readFileSync(join(wrapper, "package.json"), "utf8"));
  pkg.name = "office-docs-ai-engine";
  pkg.version = LOCAL_WRAPPER_VERSION;
  pkg.private = true;
  pkg.description =
    "Office 本地文档引擎适配包，管理原生进程、编辑页面与 MCP 接口。";
  pkg.bin = { "office-docs-mcp": "./lib/mcp/stdio-mcp-bridge.js" };
  pkg.files = [
    "lib",
    "supported-extensions.cjs",
    "scripts/editor-sdk-platforms.js",
    "editor-sdk-version.json",
  ];
  delete pkg.typings;
  delete pkg.publishConfig;
  writeFileSync(
    join(wrapper, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
}

/**
 * 导入显式提供的本地 Office SDK，保持原生目录和配套版本，不联网下载。
 * @param {string} source 本地 SDK 包根目录
 * @param {string} destination JuggleWork 本地资源目录
 * @param {string} platform 目标平台，可在 macOS 上导入本地 Windows 或 Intel SDK
 */
export function importOfficeEngine(
  source,
  destination,
  platform = `${process.platform}-${process.arch}`,
) {
  if (!/^(darwin|linux)-(arm64|x64)$|^win32-(arm64|x64|ia32)$/.test(platform))
    throw new Error("不支持的 SDK 目标平台");
  const binaryName = platform.startsWith("win32-")
    ? "editor_sdk.exe"
    : "editor_sdk";
  const binary = join(source, "bin", platform, binaryName);
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const version = JSON.parse(
    readFileSync(join(source, "editor-sdk-version.json"), "utf8"),
  ).version;
  if (pkg.version !== "0.2.196-wb" || version !== "0.0.0.499")
    throw new Error("Office SDK 版本尚未适配");
  if (!existsSync(binary)) throw new Error(`缺少 ${platform} 原生引擎`);
  const installed = readFileSync(
    join(dirname(binary), ".editor-sdk-version"),
    "utf8",
  ).trim();
  if (installed !== version) throw new Error("原生引擎和配套版本不一致");
  mkdirSync(destination, { recursive: true });
  cpSync(dirname(binary), join(destination, platform), {
    recursive: true,
    filter: (file) =>
      !["tmp", "logs", ".DS_Store"].includes(file.split(/[\\/]/).pop()) &&
      !file.endsWith(".log"),
  });
  const wrapper = join(destination, "wrapper");
  mkdirSync(wrapper, { recursive: true });
  cpSync(join(source, "lib"), join(wrapper, "lib"), { recursive: true });
  mkdirSync(join(wrapper, "scripts"), { recursive: true });
  cpSync(
    join(source, "scripts", "editor-sdk-platforms.js"),
    join(wrapper, "scripts", "editor-sdk-platforms.js"),
  );
  cpSync(join(source, "package.json"), join(wrapper, "package.json"));
  cpSync(
    join(source, "supported-extensions.cjs"),
    join(wrapper, "supported-extensions.cjs"),
  );
  cpSync(
    join(source, "editor-sdk-version.json"),
    join(wrapper, "editor-sdk-version.json"),
  );
  for (const name of ["LICENSE", "LICENSE.md", "NOTICE"])
    if (existsSync(join(source, name)))
      cpSync(join(source, name), join(wrapper, name));
  adaptOfficeWrapper(wrapper);
  const manifest = {
    schema: 1,
    platform,
    wrapperVersion: LOCAL_WRAPPER_VERSION,
    engineVersion: version,
    binary: `${platform}/${binaryName}`,
    wrapper: "wrapper/lib/common/office-docs-service.js",
    sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  };
  writeFileSync(
    join(destination, "version.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(
    join(destination, platform, "version.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = process.argv[2];
  if (!source)
    throw new Error(
      "用法：node scripts/import-office-engine.mjs <本地 SDK 包目录> [资源目录] [目标平台]",
    );
  const destination =
    process.argv[3] ??
    fileURLToPath(
      new URL("../apps/desktop/resources/office-engine", import.meta.url),
    );
  console.log(
    JSON.stringify(
      importOfficeEngine(
        resolve(source),
        resolve(destination),
        process.argv[4],
      ),
      null,
      2,
    ),
  );
}

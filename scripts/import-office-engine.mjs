import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 导入显式提供的本地 Office SDK，保持原生目录和配套版本，不联网下载。
 * @param {string} source 腾讯 SDK 包根目录
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
    join(source, "editor-sdk-version.json"),
    join(wrapper, "editor-sdk-version.json"),
  );
  for (const name of ["LICENSE", "LICENSE.md", "NOTICE"])
    if (existsSync(join(source, name)))
      cpSync(join(source, name), join(wrapper, name));
  const manifest = {
    schema: 1,
    platform,
    wrapperVersion: pkg.version,
    engineVersion: version,
    binary: `${platform}/${binaryName}`,
    wrapper: "wrapper/lib/common/tencent-docs-service.js",
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

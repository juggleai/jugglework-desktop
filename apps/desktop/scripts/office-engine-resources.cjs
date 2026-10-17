const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** 读取指定目标平台的供应清单，缺少资源时禁止生成漏带 Office SDK 的安装包。 */
function readOfficeEngineManifest(root, platform) {
  const target = path.join(root, platform, "version.json");
  const manifestPath = fs.existsSync(target)
    ? target
    : path.join(root, "version.json");
  if (!fs.existsSync(manifestPath))
    throw new Error(`缺少 ${platform} Office SDK 资源清单`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const executable = platform.startsWith("win32-")
    ? "editor_sdk.exe"
    : "editor_sdk";
  if (manifest.schema !== 1 || manifest.platform !== platform)
    throw new Error(
      `缺少 ${platform} Office SDK，请先导入该平台的完整本地资源`,
    );
  if (
    manifest.engineVersion !== "0.0.0.499" ||
    manifest.wrapperVersion !== "0.2.196-office.1" ||
    manifest.binary !== `${platform}/${executable}` ||
    manifest.wrapper !== "wrapper/lib/common/office-docs-service.js"
  )
    throw new Error("Office SDK 清单与已适配版本或路径不一致");
  const marker = fs
    .readFileSync(path.join(root, platform, ".editor-sdk-version"), "utf8")
    .trim();
  const wrapper = JSON.parse(
    fs.readFileSync(path.join(root, "wrapper/package.json"), "utf8"),
  );
  if (
    marker !== manifest.engineVersion ||
    wrapper.version !== manifest.wrapperVersion
  )
    throw new Error("Office SDK 配套版本不一致");
  const binary = path.join(root, manifest.binary);
  if (digest(binary) !== manifest.sha256)
    throw new Error("Office SDK 校验失败，请确认 Git LFS 资源已完整检出");
  for (const file of [
    manifest.wrapper,
    "wrapper/supported-extensions.cjs",
    "wrapper/scripts/editor-sdk-platforms.js",
    "wrapper/lib/common/document-types.js",
    "wrapper/lib/common/engine-port-file.js",
    "wrapper/lib/common/editor-sdk-process-launcher.js",
  ])
    if (!fs.statSync(path.join(root, file)).isFile())
      throw new Error(`Office SDK 缺少文件：${file}`);
  return manifest;
}

/** 计算实际交付的原生文件哈希，签名改变字节后同步到安装包清单。 */
function digest(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 复制 wrapper 与唯一目标平台到 ASAR 外，排除 SDK 运行时产生的日志和临时文件。 */
function copyOfficeEngineResources({
  sourceDirectory,
  resourcesDirectory,
  platform,
  signBinary,
}) {
  const manifest = readOfficeEngineManifest(sourceDirectory, platform);
  const destination = path.join(resourcesDirectory, "office-engine");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const filter = (file) =>
    !["tmp", "logs", ".DS_Store"].includes(path.basename(file)) &&
    !file.endsWith(".log");
  for (const name of ["wrapper", platform])
    fs.cpSync(path.join(sourceDirectory, name), path.join(destination, name), {
      recursive: true,
      filter,
    });
  const binary = path.join(destination, manifest.binary);
  if (!platform.startsWith("win32-")) fs.chmodSync(binary, 0o755);
  // TIPS: 先签 SDK、更新其哈希，再让 electron-builder 签主应用；后续不能重复改写 SDK 字节。
  if (signBinary) signBinary(binary);
  const packaged = { ...manifest, sha256: digest(binary) };
  for (const file of [
    path.join(destination, "version.json"),
    path.join(destination, platform, "version.json"),
  ])
    fs.writeFileSync(file, JSON.stringify(packaged, null, 2) + "\n");
  readOfficeEngineManifest(destination, platform);
  return { directory: destination, manifest: packaged };
}

module.exports = { copyOfficeEngineResources, readOfficeEngineManifest };

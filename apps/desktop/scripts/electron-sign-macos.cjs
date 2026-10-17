const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { readOfficeEngineManifest } = require("./office-engine-resources.cjs");

/**
 * 在主应用封存前，用 electron-builder 已解析的身份和钥匙串签署 Office 内核并更新哈希。
 * @param options electron-builder 的原始 macOS 签名参数；保留默认签名和验证行为
 * @param dependencies 签名边界验证时替换原生命令和主应用签名
 */
async function signMacApplication(options, dependencies = {}) {
  const root = path.join(options.app, "Contents/Resources/office-engine");
  const platform = JSON.parse(
    fs.readFileSync(path.join(root, "version.json"), "utf8"),
  ).platform;
  const manifest = readOfficeEngineManifest(root, platform);
  const binary = path.join(root, manifest.binary);
  if (!options.identity)
    throw new Error("Office SDK 签名缺少主应用的实际签名身份");
  const args = [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    path.join(__dirname, "../build/entitlements.mac.plist"),
    "--sign",
    options.identity,
  ];
  if (options.keychain) args.push("--keychain", options.keychain);
  if (options.identity !== "-") args.push("--timestamp");
  args.push(binary);
  const result = (dependencies.run ?? spawnSync)("codesign", args, {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Office SDK 签名失败");
  // TIPS: SDK 签名会改变字节；必须在主应用签名封存资源前写入最终哈希。
  const packaged = {
    ...manifest,
    sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
  };
  for (const file of [
    path.join(root, "version.json"),
    path.join(root, platform, "version.json"),
  ])
    fs.writeFileSync(file, JSON.stringify(packaged, null, 2) + "\n");
  readOfficeEngineManifest(root, platform);
  if (dependencies.signApp) return dependencies.signApp(options);
  // 沿用已安装 electron-builder 的默认签名器及其重试，不另装第二套签名依赖。
  const builderRequire = createRequire(
    require.resolve("electron-builder/package.json"),
  );
  return builderRequire("app-builder-lib/out/codeSign/macCodeSign.js").sign(
    options,
  );
}

function sign(options) {
  return signMacApplication(options);
}
module.exports = sign;
module.exports.sign = sign;
module.exports.signMacApplication = signMacApplication;

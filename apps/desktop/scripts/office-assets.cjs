const fs = require("node:fs");
const path = require("node:path");
const { readOfficeAssets } = require("../electron/office-assets.cjs");

/** 将配套资源及字体目录复制至 ASAR 外；缺失或损坏的必需资源在签名前停止打包。 */
function copyOfficeAssets(source, resources) {
  const manifest = readOfficeAssets(source);
  const destination = path.join(resources, "office-assets");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of manifest.entries) {
    if (!entry.file) continue;
    const target = path.join(destination, ...entry.file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, ...entry.file.split("/")), target);
  }
  fs.copyFileSync(
    path.join(source, "manifest.json"),
    path.join(destination, "manifest.json"),
  );
  readOfficeAssets(destination);
  return destination;
}

module.exports = { copyOfficeAssets };

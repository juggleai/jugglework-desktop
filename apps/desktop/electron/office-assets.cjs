const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

/** 读取配套的资源目录；路径只来自清单，禁止按请求 URL 生成磁盘路径。 */
function readOfficeAssets(directory) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.schema !== 1 ||
    manifest.engineVersion !== "0.0.0.499" ||
    manifest.wrapperVersion !== "0.2.196-office.1" ||
    !manifest.assetVersion ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.optional)
  )
    throw new Error("Office 补充资源版本不匹配");
  const identities = new Set();
  const ids = new Set();
  const files = new Set();
  for (const entry of manifest.entries) {
    const identity = entry.url ?? entry.path;
    if (
      !entry.id ||
      ids.has(entry.id) ||
      !["core", "font"].includes(entry.kind) ||
      typeof entry.required !== "boolean" ||
      typeof identity !== "string" ||
      identities.has(identity) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0 ||
      entry.size > 32 * 1024 * 1024 ||
      typeof entry.mime !== "string"
    )
      throw new Error("Office 补充资源清单无效");
    identities.add(identity);
    ids.add(entry.id);
    if (entry.url) {
      const url = new URL(entry.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Office 字体来源必须是固定 HTTPS 静态地址");
    } else if (
      !entry.path?.startsWith("/static/") ||
      entry.path.includes("?") ||
      entry.path.includes("#")
    ) {
      throw new Error("Office 本地资源必须使用精确静态路径");
    }
    if (
      entry.kind === "font" &&
      (!entry.fontId ||
        !entry.family ||
        !entry.version ||
        !entry.purpose ||
        !entry.coverage ||
        !entry.use)
    )
      throw new Error("Office 字体缺少用途或使用范围");
    if (!entry.file && (entry.kind !== "font" || !entry.url || entry.required))
      throw new Error("Office 必需资源缺少本地文件");
    if (entry.file) {
      // TIPS: 同一 POSIX 清单在 Windows/macOS 解析一致，拒绝反斜杠、盘符及目录穿越。
      if (
        !/^[a-zA-Z0-9_./-]+$/.test(entry.file) ||
        entry.file
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.endsWith(".") ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
          ) ||
        path.isAbsolute(entry.file)
      )
        throw new Error("Office 资源文件路径无效");
      if (files.has(entry.file.toLowerCase()))
        throw new Error("Office 资源文件名大小写冲突");
      files.add(entry.file.toLowerCase());
      const file = path.join(directory, ...entry.file.split("/"));
      const relative = path.relative(
        fs.realpathSync(directory),
        fs.realpathSync(file),
      );
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Office 资源超出目录");
      const info = fs.statSync(file);
      if (!info.isFile() || info.size !== entry.size)
        throw new Error(`Office 资源校验失败：${entry.id}`);
      const bytes = fs.readFileSync(file);
      if (
        bytes.length !== entry.size ||
        createHash("sha256").update(bytes).digest("hex") !== entry.sha256
      )
        throw new Error(`Office 资源校验失败：${entry.id}`);
    }
  }
  for (const item of manifest.optional) {
    const identity = item.path;
    if (
      !item.path?.startsWith("/") ||
      item.path.includes("?") ||
      item.path.includes("#") ||
      item.origin !== undefined ||
      !item.purpose ||
      identities.has(identity)
    )
      throw new Error("Office 可选资源分类无效");
    identities.add(identity);
  }
  return manifest;
}

module.exports = { readOfficeAssets };

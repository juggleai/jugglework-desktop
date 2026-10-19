import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import officeResources from "../apps/desktop/scripts/office-engine-resources.cjs";

/** 目标可尚未创建；先解析最近的真实父目录，避免目录别名绕过同源及嵌套检查。 */
function canonicalDirectory(path) {
  let parent = resolve(path);
  const pending = [];
  for (;;) {
    try {
      return resolve(realpathSync(parent), ...pending);
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(parent) === parent) throw error;
      pending.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

/**
 * 导入当前格式的本地 Office 资源，校验配套版本和哈希，不转换其他包格式。
 * @param {string} source 包含 wrapper、平台目录及版本清单的资源根目录
 * @param {string} destination 项目 Office 资源目录
 * @param {string} platform 目标平台，不启动原生引擎或联网下载
 */
export function importOfficeEngine(
  source,
  destination,
  platform = `${process.platform}-${process.arch}`,
) {
  if (!/^(darwin|linux)-(arm64|x64)$|^win32-(arm64|x64|ia32)$/.test(platform))
    throw new Error("不支持的 SDK 目标平台");
  const input = realpathSync(resolve(source));
  const output = canonicalDirectory(destination);
  const manifest = officeResources.readOfficeEngineManifest(input, platform);
  const pkg = JSON.parse(
    readFileSync(join(input, "wrapper/package.json"), "utf8"),
  );
  if (pkg.name !== "office-docs-ai-engine")
    throw new Error("请提供当前 Office 适配包资源");
  const key = (path) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  const inputKey = key(input),
    outputKey = key(output);
  if (inputKey === outputKey) return manifest;
  // TIPS: 避免替换 wrapper 时删除嵌套的供应源，平台资源可在不同根目录间复制。
  const inside = (parent, child) =>
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (inside(outputKey, inputKey) || inside(inputKey, outputKey))
    throw new Error("Office 供应源与目标目录不能互相嵌套");
  mkdirSync(output, { recursive: true });
  const wrapper = join(output, "wrapper");
  rmSync(wrapper, { recursive: true, force: true });
  cpSync(join(input, "wrapper"), wrapper, { recursive: true });
  cpSync(join(input, platform), join(output, platform), {
    recursive: true,
    filter: (file) =>
      !["tmp", "logs", ".DS_Store"].includes(file.split(/[\\/]/).pop()) &&
      !file.endsWith(".log"),
  });
  for (const file of [
    join(output, "version.json"),
    join(output, platform, "version.json"),
  ])
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = process.argv[2];
  if (!source)
    throw new Error(
      "用法：node scripts/import-office-engine.mjs <当前 Office 资源根目录> [资源目录] [目标平台]",
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

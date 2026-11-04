import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));

/** 将有限文件窗口桥打包为 Electron sandbox 可加载的单文件 CJS。 */
export async function buildFileWindowPreload({
  input = resolve(desktopRoot, "electron/file-window-preload.mjs"),
  output = resolve(desktopRoot, "dist/preload/file-window-preload.cjs"),
} = {}) {
  const result = await build({
    entryPoints: [input],
    outfile: output,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: ["electron"],
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  // sandbox 的 require 不能解析本地模块或任意 Node 内置模块。
  const imports = Object.values(result.metafile.outputs).flatMap((entry) => entry.imports);
  if (imports.some((entry) => entry.path !== "electron" || entry.kind !== "require-call")) {
    throw new Error("File-window preload must only require electron at runtime");
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, result.outputFiles[0].contents);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildFileWindowPreload();
}

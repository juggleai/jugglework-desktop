import { copyFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * 通过宿主保存对话框导出工作区文件副本，原文件身份保持不变。
 * @param {{ workspaceRoot: string; relativePath: string; choosePath: (name: string) => Promise<string | null> }} input 文件及对话框能力
 * @returns {Promise<string | null>} 副本位置；取消时返回 null
 */
export async function saveArtifactFileCopy({
  workspaceRoot,
  relativePath,
  choosePath,
}) {
  const root = path.resolve(workspaceRoot);
  const source = path.resolve(root, relativePath);
  const child = path.relative(root, source);
  if (
    !child ||
    child === ".." ||
    child.startsWith(`..${path.sep}`) ||
    path.isAbsolute(child)
  ) {
    throw new Error("File must belong to the workspace.");
  }
  if (!(await stat(source)).isFile()) throw new Error("Source must be a file.");
  const destination = await choosePath(path.basename(source));
  if (!destination) return null;
  if (path.resolve(destination) === source)
    throw new Error("Choose a different file for the copy.");
  // TIPS: 原生磁盘复制支持空文件和大型产物，不经 Renderer/base64 整体加载，也不修改源文件。
  await copyFile(source, destination);
  return destination;
}

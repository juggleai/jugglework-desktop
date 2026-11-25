import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { ApiError } from "../errors.js";

const CONTENT_TYPES =
  "http://schemas.openxmlformats.org/package/2006/content-types";
const PIVOT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml",
]);

/**
 * 在导入或覆盖原文件前检查写权限及已确认会丢失内容的工作簿结构。
 * @param path 原始 Office 文件的绝对路径；此检查只读取文件
 */
export async function assertOfficeFileEditable(path: string): Promise<void> {
  const readonly = () => new ApiError(
    409,
    "office_file_not_writable",
    "原文件为只读或没有写入权限，不能编辑或保存修改。请先在系统中确认文件写入权限后重试。",
  );
  const info = await stat(path);
  // TIPS: 不改原件权限、不试写；POSIX 无写位时，即使高权限进程可写也尊重文件的只读意图。
  if (process.platform !== "win32" && (info.mode & 0o222) === 0) throw readonly();
  try {
    await access(path, constants.W_OK);
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) throw readonly();
    throw error;
  }
  if (!/\.xlsx$/i.test(path)) return;
  const archive = await JSZip.loadAsync(await readFile(path));
  const part = archive.file("[Content_Types].xml");
  const invalid = () => {
    throw new Error("Excel 文件缺少有效的内容类型清单");
  };
  if (!part) return invalid();
  const xml = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(await part.async("string"), "application/xml");
  if (
    xml.documentElement?.namespaceURI !== CONTENT_TYPES ||
    xml.documentElement.localName !== "Types"
  )
    return invalid();
  // TIPS: SDK 在导入时已丢失透视数据，不能先建模型再阻止保存，也不能用旧部件掩盖模型损坏。
  for (const name of ["Override", "Default"]) {
    const entries = xml.getElementsByTagNameNS(CONTENT_TYPES, name);
    for (let index = 0; index < entries.length; index++) {
      if (
        PIVOT_TYPES.has(entries.item(index)!.getAttribute("ContentType") ?? "")
      )
        throw new ApiError(
          409,
          "office_readonly_required",
          "此工作簿包含数据透视表，当前仅支持预览。请在默认应用中编辑。",
        );
    }
  }
}

import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";

const SHEET_NAMESPACE =
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * 适配 SDK 0.0.0.499 的 XLSX 导出公式：OOXML 的 f 节点不包含界面输入用的前导等号。
 * @param bytes 原生引擎刚保存的 XLSX；保留其他部件和公式缓存，不重建工作簿
 */
export async function normalizeXlsxExport(bytes: Buffer): Promise<Buffer> {
  const archive = await JSZip.loadAsync(bytes);
  let changed = false;
  for (const part of Object.values(archive.files)) {
    if (part.dir || !/^xl\/worksheets\/[^/]+\.xml$/.test(part.name)) continue;
    const source = await part.async("string");
    const rejectXml = () => {
      throw new Error("Excel 保存结果中的工作表 XML 无效");
    };
    const xml = new DOMParser({
      errorHandler: {
        warning: rejectXml,
        error: rejectXml,
        fatalError: rejectXml,
      },
    }).parseFromString(source, "application/xml");
    if (
      xml.documentElement?.namespaceURI !== SHEET_NAMESPACE ||
      xml.documentElement.localName !== "worksheet"
    )
      throw new Error("Excel 保存结果缺少有效工作表");
    let sheetChanged = false;
    const formulas = xml.getElementsByTagNameNS(SHEET_NAMESPACE, "f");
    for (let index = 0; index < formulas.length; index++) {
      const formula = formulas.item(index)!;
      const value = formula.textContent;
      // TIPS: 仅调整公式文本的表示；共享/数组公式属性、缓存值、图表及媒体部件均保留。
      if (value?.startsWith("=")) {
        formula.textContent = value.slice(1);
        sheetChanged = true;
      }
    }
    if (sheetChanged) {
      archive.file(part.name, new XMLSerializer().serializeToString(xml));
      changed = true;
    }
  }
  return changed
    ? archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
    : bytes;
}

/** 在统一保存完成前适配 XLSX 导出，以同目录原子替换保留完整工作簿及文件权限。 */
export async function finalizeXlsxExport(path: string): Promise<void> {
  const original = await readFile(path);
  const result = await normalizeXlsxExport(original);
  if (result === original) return;
  const info = await stat(path);
  const directory = await mkdtemp(join(dirname(path), ".jugglework-xlsx-"));
  try {
    const temporary = join(directory, "workbook.xlsx");
    await writeFile(temporary, result, { mode: info.mode });
    await rename(temporary, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

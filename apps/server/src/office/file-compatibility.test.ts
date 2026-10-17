import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { assertOfficeFileEditable } from "./file-compatibility.js";

test("按 OOXML 内容类型保护透视表及独立透视缓存，原始文件保持不变", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-compatibility-"));
  const path = join(root, "透视.XLSX");
  try {
    for (const type of [
      "pivotTable",
      "pivotCacheDefinition",
      "pivotCacheRecords",
    ]) {
      const zip = new JSZip();
      zip.file(
        "[Content_Types].xml",
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/renamed/item.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${type}+xml"/></Types>`,
      );
      zip.file("renamed/item.xml", "<original/>");
      const bytes = await zip.generateAsync({ type: "nodebuffer" });
      await writeFile(path, bytes);
      await expect(assertOfficeFileEditable(path)).rejects.toMatchObject({
        code: "office_readonly_required",
        status: 409,
      });
      expect(await readFile(path)).toEqual(bytes);
    }
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/pivotTable.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    );
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    await assertOfficeFileEditable(path);
    await writeFile(path, "not an archive");
    await expect(assertOfficeFileEditable(path)).rejects.toThrow();
    zip.file("[Content_Types].xml", "<Types/>");
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(assertOfficeFileEditable(path)).rejects.toThrow(
      "内容类型清单",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

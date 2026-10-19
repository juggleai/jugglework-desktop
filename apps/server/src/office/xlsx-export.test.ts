import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { finalizeXlsxExport, normalizeXlsxExport } from "./xlsx-export.js";

const namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

test("导出只去除公式前导等号，保留数组/共享公式、缓存及其他 OOXML 部件", async () => {
  const zip = new JSZip();
  const sheet = `<s:worksheet xmlns:s="${namespace}"><s:sheetData><s:row r="1"><s:c r="A1"><s:f>=SUM(A2:A3)</s:f><s:v>60</s:v></s:c><s:c r="B1"><s:f t="array" ref="B1">=IFERROR(INDEX(A2:A3,1),0)</s:f><s:v>40</s:v></s:c><s:c r="C1"><s:f t="shared" si="0" ref="C1:C3">=A1</s:f><s:v>60</s:v></s:c><s:c r="D1"><s:f t="shared" si="0"/><s:v>60</s:v></s:c><s:c r="E1" t="str"><s:v>=literal</s:v></s:c></s:row></s:sheetData></s:worksheet>`;
  zip.file("xl/worksheets/sheet1.xml", sheet);
  const parts = {
    "xl/workbook.xml": Buffer.from(
      '<workbook><definedName name="保留">Sheet1!A1</definedName></workbook>',
    ),
    "xl/charts/chart1.xml": Buffer.from('<chart source="Sheet1!A1:A3"/>'),
    "xl/pivotTables/pivotTable1.xml": Buffer.from('<pivotTable name="保留"/>'),
    "xl/media/image1.png": Buffer.from([0, 255, 80, 75, 1, 2]),
    "xl/styles.xml": Buffer.from("<styles/>"),
    "xl/worksheets/_rels/sheet1.xml.rels": Buffer.from("<relationships/>"),
  };
  for (const [name, bytes] of Object.entries(parts)) zip.file(name, bytes);
  const output = await normalizeXlsxExport(
    await zip.generateAsync({ type: "nodebuffer" }),
  );
  const result = await JSZip.loadAsync(output);
  const xml = new DOMParser().parseFromString(
    await result.file("xl/worksheets/sheet1.xml")!.async("string"),
    "application/xml",
  );
  const formulas = Array.from(xml.getElementsByTagNameNS(namespace, "f"));
  expect(formulas.map((formula) => formula.textContent)).toEqual([
    "SUM(A2:A3)",
    "IFERROR(INDEX(A2:A3,1),0)",
    "A1",
    "",
  ]);
  expect(formulas[1]!.getAttribute("t")).toBe("array");
  expect(formulas[1]!.getAttribute("ref")).toBe("B1");
  expect(formulas[2]!.getAttribute("si")).toBe("0");
  expect(formulas[3]!.getAttribute("t")).toBe("shared");
  expect(
    Array.from(xml.getElementsByTagNameNS(namespace, "v")).map(
      (node) => node.textContent,
    ),
  ).toEqual(["60", "40", "60", "60", "=literal"]);
  for (const [name, bytes] of Object.entries(parts))
    expect(await result.file(name)!.async("nodebuffer")).toEqual(bytes);
  expect(await normalizeXlsxExport(output)).toBe(output);
});

test("无效导出不能替换文件，成功适配不残留临时文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-xlsx-export-"));
  const path = join(root, "汇总.xlsx");
  try {
    const broken = Buffer.from("broken workbook");
    await writeFile(path, broken);
    await expect(finalizeXlsxExport(path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(broken);
    const archive = new JSZip();
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet xmlns="${namespace}"><sheetData><c><f>=SUM(A1)</f></c></sheetData></worksheet>`,
    );
    await writeFile(path, await archive.generateAsync({ type: "nodebuffer" }));
    await finalizeXlsxExport(path);
    expect(await readdir(root)).toEqual(["汇总.xlsx"]);
    const saved = await JSZip.loadAsync(await readFile(path));
    expect(
      await saved.file("xl/worksheets/sheet1.xml")!.async("string"),
    ).toContain("<f>SUM(A1)</f>");
    archive.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet xmlns="wrong"><f>=SUM(A1)</f></worksheet>',
    );
    const wrong = await archive.generateAsync({ type: "nodebuffer" });
    await writeFile(path, wrong);
    await expect(finalizeXlsxExport(path)).rejects.toThrow("有效工作表");
    expect((await readFile(path)).equals(wrong)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

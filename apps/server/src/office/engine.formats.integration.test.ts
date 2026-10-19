import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeEngine } from "./engine.js";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;

/** 创建往返验证专用模板副本，等待内容导入完成；不提供产品新建入口。 */
async function fixture(engine: OfficeEngine, kind: "sheet" | "slide") {
  const created = await engine.tool(`create_${kind}`, {});
  const fileId = String(created.file_id);
  const query = kind === "sheet" ? "sheet_get_sheet_info" : "slide_get_info";
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const info = await engine.tool(query, { file_id: fileId });
        if (kind === "sheet" || info.is_open === true)
          return { fileId, path: String(created.file_path), info };
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("SDK fixture did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    await engine.close(fileId, true);
    await rm(String(created.file_path), { force: true });
    throw error;
  }
}

nativeTest(
  "真实 SDK 的 XLSX 多表、跨表公式及未修改数据在编辑保存重开后保留",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-native-xlsx-"));
    const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
    const path = join(root, "多表.xlsx");
    let model: string | undefined;
    let template: string | undefined;
    try {
      const created = await fixture(engine, "sheet");
      model = created.fileId;
      template = created.path;
      const summary = (created.info.sheets as Array<{ sheet_id: string }>)[0]!
        .sheet_id;
      await engine.tool("sheet_rename_sheet", {
        file_id: model,
        sheet_id: summary,
        name: "汇总",
      });
      await engine.tool("sheet_add_sheet", { file_id: model, name: "明细" });
      const info = await engine.tool("sheet_get_sheet_info", {
        file_id: model,
      });
      const detail = (
        info.sheets as Array<{ sheet_id: string; name: string }>
      ).find((sheet) => sheet.name === "明细")!.sheet_id;
      await engine.tool("sheet_set_cell_value", {
        file_id: model,
        sheet_id: detail,
        cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 10 },
      });
      await engine.tool("sheet_set_cell_value", {
        file_id: model,
        sheet_id: detail,
        cell: { row: 1, col: 0, value_type: "NUMBER", number_value: 20 },
      });
      await engine.tool("sheet_set_cell_value", {
        file_id: model,
        sheet_id: summary,
        cell: {
          row: 0,
          col: 0,
          value_type: "FORMULA",
          formula: "=SUM(明细!A1:A2)",
        },
      });
      await engine.tool("save_file", { file_id: model, file_path: path });
      await engine.close(model, true);
      model = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      model = (await engine.editor(path))!.file_id;
      const opened = await engine.tool("sheet_get_sheet_info", {
        file_id: model,
      });
      const sheets = opened.sheets as Array<{ sheet_id: string; name: string }>;
      expect(sheets.map((sheet) => sheet.name)).toEqual(["汇总", "明细"]);
      await engine.tool("sheet_set_cell_value", {
        file_id: model,
        sheet_id: sheets[1]!.sheet_id,
        cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 40 },
      });
      await engine.save(model);
      expect((await readFile(path)).subarray(0, 2).toString()).toBe("PK");
      // 标准 OOXML 读取器不接受 f 中的前导等号，不能只以 SDK 自己回读正确作为兼容证明。
      const exported = await JSZip.loadAsync(await readFile(path));
      const worksheetParts = Object.values(exported.files).filter((part) =>
        /^xl\/worksheets\/[^/]+\.xml$/.test(part.name),
      );
      const formulas: string[] = [];
      for (const part of worksheetParts) {
        const xml = new DOMParser().parseFromString(
          await part.async("string"),
          "application/xml",
        );
        formulas.push(
          ...Array.from(
            xml.getElementsByTagNameNS(
              "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
              "f",
            ),
          ).map((node) => node.textContent ?? ""),
        );
      }
      expect(formulas).toEqual(["SUM(明细!A1:A2)"]);
      await engine.close(model);
      model = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      model = (await engine.editor(path))!.file_id;
      const reopened = await engine.tool("sheet_get_sheet_info", {
        file_id: model,
      });
      const actual = reopened.sheets as Array<{
        sheet_id: string;
        name: string;
      }>;
      expect(actual.map((sheet) => sheet.name)).toEqual(["汇总", "明细"]);
      const total = await engine.tool("sheet_get_cell_data", {
        file_id: model,
        sheet_id: actual[0]!.sheet_id,
        start_row: 0,
        start_col: 0,
        end_row: 0,
        end_col: 0,
        return_csv: false,
        include_formula: true,
      });
      expect(JSON.stringify(total)).toContain("SUM(");
      expect(JSON.stringify(total)).toContain("60");
      const rows = await engine.tool("sheet_get_cell_data", {
        file_id: model,
        sheet_id: actual[1]!.sheet_id,
        start_row: 0,
        start_col: 0,
        end_row: 1,
        end_col: 0,
        return_csv: true,
      });
      expect(rows.csv_data).toBe("40\n20");
    } finally {
      if (model) await engine.close(model, true);
      await engine.dispose();
      if (template) await rm(template, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

nativeTest(
  "真实 SDK 的 PPTX 页面及文本对象修改保存重开，未修改页面保留",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-native-pptx-"));
    const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
    const path = join(root, "页面.pptx");
    let model: string | undefined;
    let template: string | undefined;
    try {
      const created = await fixture(engine, "slide");
      model = created.fileId;
      template = created.path;
      expect(created.info.slide_count).toBe(1);
      await engine.tool("slide_add_slide", { file_id: model, index: -1 });
      await engine.tool("slide_add_text", {
        file_id: model,
        page_index: 0,
        x: 30,
        y: 30,
        w: 300,
        h: 60,
        text: "原始标题",
      });
      await engine.tool("slide_add_text", {
        file_id: model,
        page_index: 1,
        x: 30,
        y: 30,
        w: 300,
        h: 60,
        text: "保留第二页",
      });
      await engine.tool("save_file", { file_id: model, file_path: path });
      await engine.close(model, true);
      model = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      model = (await engine.editor(path))!.file_id;
      const page = await engine.tool("slide_get_page_info", {
        file_id: model,
        page_index: 0,
      });
      const title = (page.shapes as Array<{ id: string; text?: string }>).find(
        (shape) => shape.text?.includes("原始标题"),
      )!;
      expect(title).toBeTruthy();
      await engine.tool("slide_set_text", {
        file_id: model,
        page_index: 0,
        shape_id: title.id,
        text: "修改后的标题",
      });
      await engine.save(model);
      await engine.close(model);
      model = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      model = (await engine.editor(path))!.file_id;
      expect(
        await engine.tool("slide_get_info", { file_id: model }),
      ).toMatchObject({ is_open: true, slide_count: 2 });
      const first = await engine.tool("slide_get_page_info", {
        file_id: model,
        page_index: 0,
      });
      const second = await engine.tool("slide_get_page_info", {
        file_id: model,
        page_index: 1,
      });
      expect(JSON.stringify(first)).toContain("修改后的标题");
      expect(JSON.stringify(second)).toContain("保留第二页");
    } finally {
      if (model) await engine.close(model, true);
      await engine.dispose();
      if (template) await rm(template, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

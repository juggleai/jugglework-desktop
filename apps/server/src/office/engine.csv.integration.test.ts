import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficeEngine } from "./engine.js";

// TIPS: 此用例执行本机 SDK，只在明确启用且具备配套资源的环境运行。
const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
nativeTest(
  "真实 SDK 导入 CSV、修改单元格后仍按 UTF-8 CSV 原路径保存，并能重新导入",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-native-csv-"));
    const path = join(root, "客户.csv");
    const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
    let fileId: string | undefined;
    try {
      await writeFile(path, '姓名,营收\n"客户,一",10\n', "utf8");
      await engine.tool("open_file", { file_path: path, wait: true });
      fileId = (await engine.editor(path))?.file_id;
      expect(fileId).toBeTruthy();
      const info = await engine.tool("sheet_get_sheet_info", {
        file_id: fileId,
      });
      const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0]!.sheet_id;
      await engine.tool("sheet_set_cell_value", {
        file_id: fileId,
        sheet_id: sheetId,
        cell: { row: 1, col: 1, value_type: "NUMBER", number_value: 20 },
      });
      expect((await engine.editor(path))?.is_dirty).toBe(true);
      await engine.save(fileId!);
      const bytes = await readFile(path);
      expect(bytes.subarray(0, 2).toString()).not.toBe("PK");
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toContain(
        '"客户,一",20',
      );
      expect((await engine.editor(path))?.is_dirty).toBe(false);
      await engine.close(fileId!);
      fileId = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      fileId = (await engine.editor(path))?.file_id;
      const reopened = await engine.tool("sheet_get_sheet_info", {
        file_id: fileId,
      });
      expect(reopened.sheets).toEqual([
        expect.objectContaining({ used_row_count: 2, used_col_count: 2 }),
      ]);
      const reopenedSheet = (reopened.sheets as Array<{ sheet_id: string }>)[0]!
        .sheet_id;
      await engine.tool("sheet_delete_dimension", {
        file_id: fileId,
        sheet_id: reopenedSheet,
        dimension_type: "row",
        index: 0,
        count: 1,
      });
      await engine.save(fileId!);
      expect((await readFile(path, "utf8")).trim()).toBe('"客户,一",20');
      await engine.close(fileId!);
      fileId = undefined;
      await engine.tool("open_file", { file_path: path, wait: true });
      fileId = (await engine.editor(path))?.file_id;
      expect(
        (await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets,
      ).toEqual([
        expect.objectContaining({ used_row_count: 1, used_col_count: 2 }),
      ]);
    } finally {
      if (fileId) await engine.close(fileId, true);
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

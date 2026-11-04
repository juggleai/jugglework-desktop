import assert from "node:assert/strict";
import { readFile, writeFile, rm, realpath } from "node:fs/promises";
import { dirname, relative, isAbsolute } from "node:path";
import JSZip from "jszip";

export function acceptanceContent(engine, filePath, format, kind, fileId) {
  const id = () => fileId();
  const sheet = async () => (await engine.tool("sheet_get_sheet_info", { file_id: id() })).sheets[0].sheet_id;
  const shape = async () => (await engine.tool("slide_get_page_info", { file_id: id(), page_index: 0 })).shapes.find((s) => s.text)?.id;
  return {
    async create() {
      if (format === "csv") return writeFile(filePath, "name,value\nsynthetic,10\n");
      const schema = (await engine.listTools()).find((tool) => tool.name === `create_${kind}`);
      if (process.argv.includes("--review-resources")) console.log(JSON.stringify({ createSchema: schema }));
      const created = await engine.tool(`create_${kind}`, {});
      try {
        const query = { doc: "doc_get_last_operable_pos", sheet: "sheet_get_sheet_info", slide: "slide_get_info" }[kind];
        const deadline = Date.now() + 20_000;
        for (;;) {
          try {
            const result = await engine.tool(query, { file_id: created.file_id });
            if (kind !== "slide" || result.is_open) break;
          } catch (error) { if (Date.now() >= deadline) throw error; }
          assert.ok(Date.now() < deadline, "SDK create readiness timed out");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (kind === "doc") await engine.tool("doc_insert_text", { file_id: created.file_id, idx: 0, text: "10" });
        if (kind === "sheet") {
          const info = await engine.tool("sheet_get_sheet_info", { file_id: created.file_id });
          await engine.tool("sheet_set_cell_value", { file_id: created.file_id, sheet_id: info.sheets[0].sheet_id,
            cell: { row: 1, col: 1, value_type: "NUMBER", number_value: 10 } });
        }
        if (kind === "slide") await engine.tool("slide_add_text", { file_id: created.file_id, page_index: 0, x: 30, y: 30, w: 300, h: 80, text: "10" });
        await engine.tool("save_file", { file_id: created.file_id, file_path: filePath });
      } finally {
        await engine.close(created.file_id, true);
        const templateParent = await realpath(dirname(created.file_path));
        const inside = relative(await realpath(process.cwd()), templateParent);
        assert.ok(!inside.startsWith("..") && !isAbsolute(inside), "SDK template escaped isolated cwd");
        if (created.file_path !== filePath) await rm(created.file_path, { force: true });
      }
    },
    async read() {
      if (kind === "sheet") return (await engine.tool("sheet_get_cell_data", { file_id: id(), sheet_id: await sheet(),
        start_row: 1, end_row: 1, start_col: 1, end_col: 1, return_csv: true })).csv_data;
      if (kind === "doc") {
        const result = await engine.tool("doc_resolve_document_structure", { file_id: id(), mode: "full", text_preview_length: 200 });
        return result.nodes.filter((node) => node.text_preview).map((node) => node.text_preview).join("").replace(/\r$/, "");
      }
      return (await engine.tool("slide_get_text", { file_id: id(), page_index: 0, shape_id: await shape() })).text.replace(/\r$/, "");
    },
    async readInputCells() {
      assert.equal(kind, "sheet");
      const sheetId = await sheet();
      const cells = {};
      for (const [name, row, col] of [["A1", 0, 0], ["B1", 0, 1], ["A2", 1, 0], ["B2", 1, 1], ["B3", 2, 1]]) {
        cells[name] = (await engine.tool("sheet_get_cell_data", { file_id: id(), sheet_id: sheetId,
          start_row: row, end_row: row, start_col: col, end_col: col, return_csv: true })).csv_data;
      }
      return { sheetId, cells };
    },
    async edit(value) {
      if (kind === "sheet") return engine.tool("sheet_set_cell_value", { file_id: id(), sheet_id: await sheet(),
        cell: { row: 1, col: 1, value_type: "NUMBER", number_value: Number(value) } });
      if (kind === "doc") return engine.tool("doc_replace_text", { file_id: id(), ranges: [{ begin: 0, end: 2 }], text: value });
      return engine.tool("slide_set_text", { file_id: id(), page_index: 0, shape_id: await shape(), text: value });
    },
    async disk(value) {
      const bytes = await readFile(filePath);
      if (format === "csv") assert.ok(bytes.toString().split(/\r?\n/).includes(`synthetic,${value}`));
      else {
        const zip = await JSZip.loadAsync(bytes);
        const target = { docx: "word/document.xml", xlsx: "xl/worksheets/sheet1.xml", pptx: "ppt/slides/slide1.xml" }[format];
        const xml = await zip.file(target).async("string");
        if (format === "xlsx") {
          const cell = xml.match(/<c\b[^>]*\br="B2"[^>]*>([\s\S]*?)<\/c>/)?.[1];
          assert.ok(cell, "Saved XLSX B2 missing");
          assert.match(cell, new RegExp(`<v>${value}</v>`), "Saved XLSX B2 value missing");
        } else assert.match(xml, new RegExp(`<(?:w|a):t(?:\\s[^>]*)?>${value}</(?:w|a):t>`), `Saved ${format} native content missing`);
      }
      return bytes;
    },
  };
}

import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { OfficeEngine } from "./engine.js";

const nativeTest =
  process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
const samples = [
  { text: "字体检查 Font check", family: "Microsoft YaHei", size: 14 },
  { text: "保留字体 Keep font", family: "Arial", size: 11 },
];
const namespaces = {
  doc: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  sheet: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  slide: "http://schemas.openxmlformats.org/drawingml/2006/main",
};

/** 按命名空间读取 OOXML 子元素，不依赖 SDK 的属性回读结果。 */
function elements(node: Document | Element, ns: string, name: string) {
  return Array.from(node.getElementsByTagNameNS(ns, name));
}

for (const [extension, kind] of [
  ["docx", "doc"],
  ["xlsx", "sheet"],
  ["pptx", "slide"],
] as const) {
  nativeTest(
    `真实 SDK ${extension} 修改字体后保存重开保留声明和非目标格式`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "jugglework-native-fonts-"));
      const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
      const path = join(root, `字体样例.${extension}`);
      let model: string | undefined;
      let template: string | undefined;
      try {
        const created = await engine.tool(`create_${kind}`, {});
        model = String(created.file_id);
        template = String(created.file_path);
        const deadline = Date.now() + 15_000;
        for (;;) {
          try {
            const info = await engine.tool(
              kind === "doc"
                ? "doc_get_last_operable_pos"
                : kind === "sheet"
                  ? "sheet_get_sheet_info"
                  : "slide_get_info",
              { file_id: model },
            );
            if (kind !== "slide" || info.is_open === true) break;
          } catch (error) {
            if (Date.now() >= deadline) throw error;
          }
          if (Date.now() >= deadline) throw new Error("字体样例导入超时");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // TIPS：只创建独占测试样例；实际修改和原路径保存发生在重开的模型上。
        if (kind === "doc") {
          await engine.tool("doc_insert_text", {
            file_id: model,
            idx: 0,
            text: samples.map((sample) => sample.text).join(" "),
          });
        } else if (kind === "sheet") {
          const info = await engine.tool("sheet_get_sheet_info", {
            file_id: model,
          });
          for (const [col, sample] of samples.entries())
            await engine.tool("sheet_set_cell_value", {
              file_id: model,
              sheet_id: (info.sheets as Array<{ sheet_id: string }>)[0]!
                .sheet_id,
              cell: {
                row: 0,
                col,
                value_type: "STRING",
                string_value: sample.text,
              },
            });
        } else {
          for (const [index, sample] of samples.entries())
            await engine.tool("slide_add_text", {
              file_id: model,
              page_index: 0,
              x: 30,
              y: 30 + index * 100,
              w: 400,
              h: 60,
              text: sample.text,
            });
        }

        /** 通过模型真实坐标修改或查询两个文本范围，不手算 DOC 坐标。 */
        async function styles(write: boolean, targetOnly = false) {
          const values: Array<{ family: unknown; size: unknown }> = [];
          for (const [index, sample] of samples.entries()) {
            if (targetOnly && index !== 0) continue;
            const family =
              write && !targetOnly && index === 0 ? "宋体" : sample.family;
            const size = write && !targetOnly && index === 0 ? 12 : sample.size;
            if (kind === "doc") {
              const found = await engine.tool("doc_find", {
                file_id: model,
                text: sample.text,
              });
              expect(found.total).toBe(1);
              const range = (
                found.locations as Array<{ begin: number; end: number }>
              )[0]!;
              if (write)
                await engine.tool("doc_update_text_property", {
                  file_id: model,
                  ranges: [{ begin: range.begin, end: range.end }],
                  font_family: family,
                  font_size: size,
                });
              const value = await engine.tool("doc_get_text_property", {
                file_id: model,
                idx: range.begin,
              });
              values.push({ family: value.font_family, size: value.font_size });
            } else if (kind === "sheet") {
              const info = await engine.tool("sheet_get_sheet_info", {
                file_id: model,
              });
              const range = {
                file_id: model,
                sheet_id: (info.sheets as Array<{ sheet_id: string }>)[0]!
                  .sheet_id,
                start_row: 0,
                end_row: 0,
                start_col: index,
                end_col: index,
              };
              if (write)
                await engine.tool("sheet_set_cell_style", {
                  ...range,
                  format: { font_family: family, font_size: size },
                });
              const value = (
                (await engine.tool("sheet_get_cell_style", range))
                  .cells as Array<Record<string, unknown>>
              )[0]!;
              values.push({ family: value.font_family, size: value.font_size });
            } else {
              const page = await engine.tool("slide_get_page_info", {
                file_id: model,
                page_index: 0,
              });
              const shape = (
                page.shapes as Array<{ id: string; text?: string }>
              ).find((item) => item.text?.trim() === sample.text)!;
              expect(shape).toBeTruthy();
              const target = {
                file_id: model,
                page_index: 0,
                shape_id: shape.id,
              };
              if (write)
                await engine.tool("slide_set_text_property", {
                  ...target,
                  index: 0,
                  count: -1,
                  font_name: family,
                  font_size: size,
                });
              const value = (
                (await engine.tool("slide_get_text", target)).runs as Array<
                  Record<string, unknown>
                >
              )[0]!;
              values.push({ family: value.font_name, size: value.font_size });
            }
          }
          return values;
        }

        await styles(true);
        await engine.tool("save_file", { file_id: model, file_path: path });
        await engine.close(model, true);
        model = undefined;
        await engine.tool("open_file", { file_path: path, wait: true });
        model = (await engine.editor(path))!.file_id;
        await styles(true, true);
        await engine.save(model);
        await engine.close(model);
        model = undefined;

        const zip = await JSZip.loadAsync(await readFile(path));
        /** 从当前保存文件读取指定 XML 部件，缺失时直接报告失败。 */
        async function xml(part: string) {
          expect(zip.file(part)).toBeTruthy();
          return new DOMParser().parseFromString(
            await zip.file(part)!.async("string"),
            "application/xml",
          );
        }
        const ns = namespaces[kind];
        if (kind === "sheet") {
          const sheet = await xml("xl/worksheets/sheet1.xml");
          const style = await xml("xl/styles.xml");
          const fonts = elements(style, ns, "font");
          const xfs = elements(elements(style, ns, "cellXfs")[0]!, ns, "xf");
          const strings = await xml("xl/sharedStrings.xml");
          const items = elements(strings, ns, "si");
          for (const [index, sample] of samples.entries()) {
            const cell = elements(sheet, ns, "c").find(
              (cell) => cell.getAttribute("r") === ["A1", "B1"][index],
            )!;
            expect(
              items[Number(elements(cell, ns, "v")[0]!.textContent)]!
                .textContent,
            ).toBe(sample.text);
            const font =
              fonts[
                Number(
                  xfs[Number(cell.getAttribute("s"))]!.getAttribute("fontId"),
                )
              ]!;
            expect(elements(font, ns, "name")[0]!.getAttribute("val")).toBe(
              sample.family,
            );
            expect(
              Number(elements(font, ns, "sz")[0]!.getAttribute("val")),
            ).toBe(sample.size);
          }
        } else {
          const document = await xml(
            kind === "doc" ? "word/document.xml" : "ppt/slides/slide1.xml",
          );
          for (const sample of samples) {
            const run = elements(document, ns, "r").find(
              (run) =>
                elements(run, ns, "t")
                  .map((text) => text.textContent)
                  .join("")
                  .trim() === sample.text,
            )!;
            expect(run).toBeTruthy();
            const props = elements(run, ns, "rPr")[0]!;
            if (kind === "doc") {
              const font = elements(props, ns, "rFonts")[0]!;
              for (const attr of ["ascii", "hAnsi", "eastAsia"])
                expect(font.getAttributeNS(ns, attr)).toBe(sample.family);
              expect(
                Number(elements(props, ns, "sz")[0]!.getAttributeNS(ns, "val")),
              ).toBe(sample.size * 2);
            } else {
              for (const tag of ["latin", "ea"])
                expect(
                  elements(props, ns, tag)[0]!.getAttribute("typeface"),
                ).toBe(sample.family);
              expect(Number(props.getAttribute("sz"))).toBe(sample.size * 100);
            }
          }
        }
        await engine.tool("open_file", { file_path: path, wait: true });
        model = (await engine.editor(path))!.file_id;
        expect(await styles(false)).toEqual(
          samples.map(({ family, size }) => ({ family, size })),
        );
      } finally {
        try {
          if (model) await engine.close(model, true);
        } finally {
          await engine.dispose();
          if (template) await rm(template, { force: true });
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    60_000,
  );
}

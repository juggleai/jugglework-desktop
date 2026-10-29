import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeDocumentSession, OfficeSelectionLocator } from "@jugglework/types/office";
import { OfficeEngine } from "./engine.js";
import { parseOfficeSelection } from "./selection.js";
import { planOfficeSelectionTool } from "./selection-tools.js";
import { officeDocRangeParts, readOfficeSelectionProof, verifyOfficeSelectionEdit } from "./selection-proof.js";
import { OfficeSelectionEdits } from "./selection-edits.js";

const nativeTest = process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;

nativeTest("真实整页图片的对象选择拒绝并引导缩略图，页引用只保留图片且无可编辑文本框", async () => {
  await withModel("slide", async (engine, fileId) => {
    await engine.tool("slide_add_image", { file_id: fileId, page_index: 0, x: 0, y: 0, w: 960, h: 540,
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=" });
    const shapes = (await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 })).shapes as Array<{ id: string; type: string }>;
    expect(shapes).toHaveLength(1);
    const image = shapes[0].id;
    await expect(readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-shapes", pageIndex: 0, shapeIds: [image] }))
      .rejects.toMatchObject({ code: "office_selection_slide_picture_selected" });
    const page = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-pages", pageIndices: [0] });
    expect(page.state.shapes).toMatchObject([{ id: image, type: "picture", editable: false }]);
    expect(page.state.texts).toEqual([]);
    await expect(readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-shapes", pageIndex: 0, shapeIds: [image] }))
      .rejects.toMatchObject({ code: "office_selection_slide_picture_selected" });
    expect((await engine.tool("slide_get_info", { file_id: fileId })).version).toBe(page.state.revision);
  });
}, 30_000);

nativeTest("真实 PPT 页引用 capture→admit→改A→新坐标样式→geometry→改B→save reopen，图片与简单表格保留", async () => {
  await withModel("slide", async (engine, fileId, path) => {
    const a = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "同文案" })).shape_id as string;
    const b = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 120, w: 200, h: 80, text: "同文案" })).shape_id as string;
    const table = (await engine.tool("slide_add_table", { file_id: fileId, page_index: 0, x: 300, y: 100, w: 200, h: 100, rows: 2, cols: 2 })).shape_id as string;
    await engine.tool("slide_set_cell_text", { file_id: fileId, page_index: 0, shape_id: table, row: 1, col: 1, text: "表格尾字😀" });
    await engine.tool("slide_set_text_property", { file_id: fileId, page_index: 0, shape_id: table, row: 1, col: 1, index: 2, count: 2, bold: true, color: "008800" });
    await engine.tool("slide_add_image", { file_id: fileId, page_index: 0, x: 600, y: 100, w: 100, h: 100,
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=" });
    const pageId = ((await engine.tool("slide_get_info", { file_id: fileId })).slide_ids as string[])[0];
    const selection = { pageIndex: [0], shapeIds: [], nativeSlideIds: [pageId] };
    const document = { documentId: "slide-page", pageId: "host-page", workspaceId: "ws", ownerSessionId: "chat", relativePath: "页.pptx", name: "页.pptx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    let writes = 0;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {}, selection: async () => selection,
      tool: async (name, args) => { if (["slide_set_text", "slide_set_text_property", "slide_set_shape_properties"].includes(name)) writes++; return engine.tool(name, args); },
      modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    await expect(edits.capture(document, "no-identity", { pageIndex: [0], shapeIds: [] })).rejects.toThrow("nativeSlideIds");
    await expect(edits.capture(document, "wrong-identity", { ...selection, nativeSlideIds: ["other"] })).rejects.toThrow("原生页身份不一致");
    const ref = await edits.capture(document, "capture");
    expect(ref.preview.range).toBe("第 1 页整页");
    const submission = { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "整页改写排版", bindingState: "bound" as const, referenceIds: [ref.referenceId] }] };
    await edits.prepareTurn("ws", "chat", "turn", submission);
    expect(edits.context("ws", "chat", "turn").pages[0]).toMatchObject({ editable: [a, b], preserved: [expect.objectContaining({ type: "table" }), expect.objectContaining({ type: "picture" })] });
    const invoke = (name: string, args: Record<string, unknown>) => edits.call("ws", "chat", "turn", "assistant", name, args, ref.referenceId);
    for (const args of [{ shape_id: a, text: "错", page_index: 1 }, { shape_id: "alien", text: "错" }, { shape_id: table, text: "错" },
      { shape_id: a, text: "" }, { shape_id: a, text: "x".repeat(4097) }, { shape_id: a, text: "错", shape_ids: [a, b] }])
      await expect(invoke("slide_set_text", args)).rejects.toThrow();
    expect(writes).toBe(0);
    const preservedBefore = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-pages", pageIndices: [0] });
    expect((await invoke("slide_set_text", { shape_id: a, text: "新标题😀\r\n\r\n正文\r" }))?.receipt?.requiresReselection).toBe(false);
    const read = await invoke("slide_get_text", { shape_id: a });
    expect(read?.output.text).toBe("新标题😀\r\r正文\r\r");
    expect((await invoke("slide_set_text_property", { shape_id: a, bold: true, italic: true, color: "#FF0000", font_size: 24 }))?.receipt?.readback).toBe("confirmed");
    edits.assertDocumentSaveAllowed("ws", document.documentId, document);
    await edits.save("ws", "chat", "turn", ref.referenceId);
    expect((await invoke("slide_set_shape_properties", { shape_id: a, x: 40, y: 30, w: 220, h: 90 }))?.receipt?.readback).toBe("confirmed");
    expect((await invoke("slide_set_text", { shape_id: b, text: "第二框新文字" }))?.receipt?.readback).toBe("confirmed");
    const after = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-pages", pageIndices: [0] });
    const preserved = (proof: typeof after) => ({ shapes: (proof.state.shapes as Array<{ editable: boolean }>).filter((s) => !s.editable),
      table: (proof.state.texts as Array<{ shapeId: string }>).find((t) => t.shapeId === table) });
    expect(preserved(after)).toEqual(preserved(preservedBefore));
    expect(writes).toBe(4);
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const saved = await readOfficeSelectionProof(engine.tool.bind(engine), reopened, { kind: "slide-pages", pageIndices: [0] });
    const texts = saved.state.texts as Array<Record<string, unknown>>;
    const title = texts.find((t) => t.text === "新标题😀\r\r正文\r\r")!;
    expect(title).toBeDefined();
    expect((title.runs as Array<Record<string, unknown>>).every((r) => r.bold && r.italic && r.color === "FF0000" && r.font_size === 24)).toBe(true);
    expect(texts.some((t) => t.text === "第二框新文字\r")).toBe(true);
    expect((saved.state.shapes as Array<{ id: string; detail: Record<string, unknown> }>).find((s) => s.id === title.shapeId)?.detail.bounds).toEqual({ x: 40, y: 30, w: 220, h: 90 });
    expect((saved.state.shapes as Array<{ type: string }>).map((s) => s.type)).toEqual(["shape", "shape", "table", "picture"]);
    const tableText = texts.find((t) => Array.isArray(t.cells))!;
    const tailCell = (tableText.cells as Array<Record<string, unknown>>)[3];
    expect(tailCell.text).toBe("表格尾字😀\r");
    expect(tailCell.runs).toEqual(expect.arrayContaining([expect.objectContaining({ start: 2, end: 4, bold: true, color: "008800" })]));
  });
}, 60_000);

nativeTest("真实 PPT 4096 UTF-16及输入末尾CR保留，多段和短文本可连续改写并按新范围局部格式化", async () => {
  await withModel("slide", async (engine, fileId) => {
    const shape = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "初始" })).shape_id as string;
    const locator: OfficeSelectionLocator = { kind: "slide-pages", pageIndices: [0] };
    for (const text of ["x".repeat(4094) + "😀", "首段\r\n\r\n末段\r", "短"]) {
      const before = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
      const plan = planOfficeSelectionTool(locator, fileId, "slide_set_text", { shape_id: shape, text }, before.state);
      const result = await engine.tool("slide_set_text", plan.args);
      expect(result.version).toBe((before.state.revision as number) + 1);
      const after = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
      verifyOfficeSelectionEdit(before, after, locator, "slide_set_text", plan.args);
      expect((after.state.texts as Array<{ text: string }>)[0].text).toBe(text.replace(/\r\n|\n/g, "\r") + "\r");
      if (text.length === 4096) {
        const selected: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 0, shapeId: shape, start: 0, count: 1 };
        const proof = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, selected);
        const style = planOfficeSelectionTool(selected, fileId, "slide_set_text_property", { bold: true });
        await engine.tool("slide_set_text_property", style.args);
        verifyOfficeSelectionEdit(proof, await readOfficeSelectionProof(engine.tool.bind(engine), fileId, selected), selected, "slide_set_text_property", style.args);
      }
    }
    const before = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    expect(() => planOfficeSelectionTool(locator, fileId, "slide_set_text_property", { shape_id: shape, index: 4, count: 1, bold: true }, before.state)).toThrow();
    const plan = planOfficeSelectionTool(locator, fileId, "slide_set_text_property", { shape_id: shape, index: 0, count: 1, italic: true, font_size: 18.25 }, before.state);
    await engine.tool("slide_set_text_property", plan.args);
    verifyOfficeSelectionEdit(before, await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator), locator, "slide_set_text_property", plan.args);
  });
}, 30_000);

for (const failure of ["lost-write", "other-box", "table-tail-style", "picture-geometry"] as const)
  nativeTest(`真实 PPT 整页 ${failure} 阻断重试及通用/选区保存，完整回读不只摘要`, async () => {
    await withModel("slide", async (engine, fileId) => {
      const a = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "目标" })).shape_id as string;
      const b = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 120, w: 200, h: 80, text: "保留" })).shape_id as string;
      const table = (await engine.tool("slide_add_table", { file_id: fileId, page_index: 0, x: 300, y: 100, w: 200, h: 100, rows: 1, cols: 1 })).shape_id as string;
      await engine.tool("slide_set_cell_text", { file_id: fileId, page_index: 0, shape_id: table, row: 0, col: 0, text: "表头末尾" });
      await engine.tool("slide_add_image", { file_id: fileId, page_index: 0, x: 600, y: 100, w: 100, h: 100,
        image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=" });
      const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
      const picture = (page.shapes as Array<{ id: string; type: string }>).find((s) => s.type === "picture")!.id;
      const document = { documentId: "failure-page", pageId: "host", workspaceId: "ws", ownerSessionId: "chat", relativePath: "页.pptx", name: "页.pptx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
      let writes = 0, saves = 0, offset = 0;
      const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
        selection: async () => ({ pageIndex: [0], shapeIds: [], nativeSlideIds: [page.page_id] }),
        tool: async (name, args) => {
          const result = await engine.tool(name, args);
          if (name === "slide_set_text") {
            writes++;
            expect(() => edits.assertDocumentSaveAllowed("ws", document.documentId, document)).toThrow("暂不能保存");
            if (failure === "lost-write") throw new Error("response lost after native application");
            if (failure === "other-box") await engine.tool("slide_set_text", { file_id: fileId, page_index: 0, shape_id: b, text: "误改" });
            if (failure === "table-tail-style") {
              const before = await engine.tool("slide_get_table_info", { file_id: fileId, page_index: 0, shape_id: table });
              await engine.tool("slide_set_text_property", { file_id: fileId, page_index: 0, shape_id: table, row: 0, col: 0, index: 3, count: 1, bold: true });
              const after = await engine.tool("slide_get_table_info", { file_id: fileId, page_index: 0, shape_id: table });
              expect(before.cells).toEqual(after.cells); // 首字符摘要无法发现此误改。
            }
            if (failure === "picture-geometry") await engine.tool("slide_set_shape_properties", { file_id: fileId, page_index: 0, shape_id: picture, x: 610 });
            offset = 1; // 隐去额外版本，保证由完整事实拒绝。
          }
          return typeof result.version === "number" && name !== "slide_set_text" ? { ...result, version: result.version - offset } : result;
        }, modified: async () => { throw new Error("不能确认"); }, save: async () => { saves++; return document; } });
      const ref = await edits.capture(document, "capture");
      await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "整页改写", bindingState: "bound", referenceIds: [ref.referenceId] }] });
      const invoke = () => edits.call("ws", "chat", "turn", "assistant", "slide_set_text", { shape_id: a, text: "新目标" }, ref.referenceId);
      await expect(invoke()).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
      await expect(invoke()).rejects.toThrow("尚待核对");
      expect(() => edits.assertDocumentSaveAllowed("ws", document.documentId, document)).toThrow("暂不能保存");
      await expect(edits.save("ws", "chat", "turn", ref.referenceId)).rejects.toThrow("暂不能保存");
      expect(writes).toBe(1); expect(saves).toBe(0);
    });
  }, 30_000);

nativeTest("真实 PPT 组内和旋转框完整读取只保留，多页/混合ref/图表明确unsupported", async () => {
  await withModel("slide", async (engine, fileId) => {
    const add = async (text: string, y: number) => (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y, w: 200, h: 60, text })).shape_id as string;
    const target = await add("普通框", 20), rotated = await add("旋转框", 100), childA = await add("组内甲", 200), childB = await add("组内乙", 300);
    await engine.tool("slide_set_shape_properties", { file_id: fileId, page_index: 0, shape_id: rotated, rotation: 30 });
    await engine.tool("slide_group_shapes", { file_id: fileId, page_index: 0, shape_ids: [childA, childB] });
    const locator: OfficeSelectionLocator = { kind: "slide-pages", pageIndices: [0] };
    const query = engine.tool.bind(engine), before = await readOfficeSelectionProof(query, fileId, locator);
    const shapes = before.state.shapes as Array<{ id: string; editable: boolean }>;
    expect(shapes.filter((s) => s.editable).map((s) => s.id)).toEqual([target]);
    expect(shapes.find((s) => s.id === rotated)?.editable).toBe(false);
    expect(shapes.find((s) => s.id === childA)?.editable).toBe(false);
    const args = planOfficeSelectionTool(locator, fileId, "slide_set_text", { shape_id: target, text: "新普通框" }, before.state).args;
    await engine.tool("slide_set_text", args);
    const after = await readOfficeSelectionProof(query, fileId, locator);
    verifyOfficeSelectionEdit(before, after, locator, "slide_set_text", args);
    const document = { documentId: "mixed-page", pageId: "host", workspaceId: "ws", ownerSessionId: "chat", relativePath: "页.pptx", name: "页.pptx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const selection = { pageIndex: [0], shapeIds: [], nativeSlideIds: [before.state.pageId] };
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {}, selection: async () => selection, tool: query, modified: async () => {}, save: async () => document });
    await expect(edits.capture(document, "multi", { pageIndex: [0, 1], shapeIds: [], nativeSlideIds: ["a", "b"] })).rejects.toThrow("单页");
    const pageRef = await edits.capture(document, "page");
    const textRef = await edits.capture(document, "text", { pageIndex: 0, shapeIds: [target], textSelection: { shapeId: target, start: 0, count: 1, selectedText: "新" } });
    const refs = [pageRef.referenceId, textRef.referenceId];
    await expect(edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: refs, officeInstructions: [{ instructionId: "i", text: "修改", bindingState: "bound", referenceIds: refs }] })).rejects.toThrow("同轮");
    await engine.tool("slide_add_chart", { file_id: fileId, page_index: 0, x: 500, y: 200, w: 200, h: 200, categories: ["a"], series: [{ values: [1] }] });
    await expect(readOfficeSelectionProof(query, fileId, locator)).rejects.toMatchObject({ code: "office_selection_slide_objects_unsupported" });
  });
}, 30_000);

nativeTest("真实 PPT Alpha CR Beta mixed runs 首字红、index1绿及首字color/fontsize成功，index3 collateral红拒绝", async () => {
  await withModel("slide", async (engine, fileId) => {
    const shapeId = (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "Alpha\rBeta" })).shape_id as string;
    const locator: OfficeSelectionLocator = { kind: "slide-pages", pageIndices: [0] };
    const read = () => readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    const style = async (input: Record<string, unknown>) => {
      const before = await read(), plan = planOfficeSelectionTool(locator, fileId, "slide_set_text_property", { shape_id: shapeId, ...input }, before.state);
      await engine.tool("slide_set_text_property", plan.args);
      const after = await read();
      verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", plan.args);
      return after;
    };
    const red = await style({ index: 0, count: 1, color: "FF0000" });
    const redRuns = (red.state.texts as Array<{ runs: Array<Record<string, unknown>> }>)[0].runs;
    expect(redRuns[0].color).toBe("FF0000");
    expect(redRuns.find((r) => r.start === 1)?.color).toBeUndefined();
    await style({ index: 1, count: 1, color: "00FF00" });
    await style({ index: 0, count: 1, color: "0000FF", font_size: 24 });
    await style({ index: 0, count: 1, bold: true, italic: true });
    await style({ index: 0, count: 1, bold: false, italic: false });
    // 重置到首字红、其余缺省。故意把额外写入的版本隐藏，防止仅靠版本差发现。
    await engine.tool("slide_set_text", { file_id: fileId, page_index: 0, shape_id: shapeId, text: "Alpha\rBeta" });
    await style({ index: 0, count: 1, color: "FF0000" });
    const before = await read(), args = planOfficeSelectionTool(locator, fileId, "slide_set_text_property", { shape_id: shapeId, index: 1, count: 1, color: "00FF00" }, before.state).args;
    await engine.tool("slide_set_text_property", args);
    await engine.tool("slide_set_text_property", { file_id: fileId, page_index: 0, shape_id: shapeId, index: 3, count: 1, color: "FF0000" });
    const after = await read(); after.state.revision = (before.state.revision as number) + 1;
    expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).toThrow("尚未确认");
  });
}, 30_000);

nativeTest("真实 PPT 顶层/组内无text body rectangle完整空读取保留，普通框编辑不受装饰影响", async () => {
  await withModel("slide", async (engine, fileId) => {
    const addBox = async (text: string, x: number) => (await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x, y: 20, w: 100, h: 80, text })).shape_id as string;
    const addRect = async (x: number) => (await engine.tool("slide_add_shape", { file_id: fileId, page_index: 0, x, y: 200, w: 100, h: 80, shape_type: "rect", fill_color: "FF0000" })).shape_id as string;
    const target = await addBox("可编辑", 20), child = await addBox("组内", 200), top = await addRect(20), nested = await addRect(200);
    await engine.tool("slide_group_shapes", { file_id: fileId, page_index: 0, shape_ids: [child, nested] });
    const locator: OfficeSelectionLocator = { kind: "slide-pages", pageIndices: [0] }, query = engine.tool.bind(engine);
    const before = await readOfficeSelectionProof(query, fileId, locator);
    for (const id of [top, nested]) {
      expect((before.state.shapes as Array<{ id: string; editable: boolean }>).find((s) => s.id === id)?.editable).toBe(false);
      expect((before.state.texts as Array<{ shapeId: string }>).find((t) => t.shapeId === id)).toMatchObject({ text: "", length: 0, runs: [], paragraphs: [], hyperlinks: [] });
    }
    const args = planOfficeSelectionTool(locator, fileId, "slide_set_text", { shape_id: target, text: "新文字" }, before.state).args;
    await engine.tool("slide_set_text", args);
    verifyOfficeSelectionEdit(before, await readOfficeSelectionProof(query, fileId, locator), locator, "slide_set_text", args);
  });
}, 30_000);

nativeTest("真实 PPT 960.5pt页使用EMU边界；公开getter整数pt与跨对象subpt盲区明确暴露", async () => {
  await withModel("slide", async (engine, fileId, path) => {
    await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20.25, y: 20.5, w: 200.25, h: 80.5, text: "目标" });
    await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 300, y: 20, w: 200, h: 80, text: "其他框" });
    await engine.save(fileId); await engine.close(fileId);
    const { readFile, writeFile } = await import("node:fs/promises"), { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(path)), xml = await zip.file("ppt/presentation.xml")!.async("string");
    const resized = xml.replace(/(<p:sldSz\b[^>]*\bcx=")\d+"/, (_match, prefix: string) => `${prefix}12198350"`);
    expect(resized).not.toBe(xml);
    zip.file("ppt/presentation.xml", resized); await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id, query = engine.tool.bind(engine);
    const locator: OfficeSelectionLocator = { kind: "slide-pages", pageIndices: [0] };
    const before = await readOfficeSelectionProof(query, reopened, locator);
    expect(before.state.size).toMatchObject({ w: 960.5, wEmu: 12198350 });
    const shapes = before.state.shapes as Array<{ id: string; detail: Record<string, unknown> }>;
    expect(shapes[0].detail.bounds).toEqual({ x: 20, y: 21, w: 200, h: 81 });
    for (const key of ["x", "y", "w", "h"]) expect(() => planOfficeSelectionTool(locator, reopened, "slide_set_shape_properties", { shape_id: shapes[0].id, [key]: 20.5 }, before.state)).toThrow("整数 pt");
    const args = planOfficeSelectionTool(locator, reopened, "slide_set_shape_properties", { shape_id: shapes[0].id, x: 40, y: 30, w: 220, h: 90 }, before.state).args;
    await engine.tool("slide_set_shape_properties", args);
    verifyOfficeSelectionEdit(before, await readOfficeSelectionProof(query, reopened, locator), locator, "slide_set_shape_properties", args);
    const previous = await readOfficeSelectionProof(query, reopened, locator);
    await engine.tool("slide_set_shape_properties", { file_id: reopened, page_index: 0, shape_id: shapes[1].id, x: 300.25 });
    const after = await readOfficeSelectionProof(query, reopened, locator);
    // 不是容差：两个独立公开getter的事实本来就完全相同，真实版本仍会识别外部写入。
    expect(after.state.shapes).toEqual(previous.state.shapes);
    expect(after.state.page).toEqual(previous.state.page);
    expect(after.state.revision).toBe((previous.state.revision as number) + 1);
    // 仅保存并检查隔离 fixture 的导出 XML，证明确有亚 pt 存储变化；不作为生产读取通道。
    await engine.save(reopened);
    const saved = await JSZip.loadAsync(await readFile(path));
    const slideXml = await saved.file("ppt/slides/slide1.xml")!.async("string");
    expect(slideXml).toContain('x="3813175"'); // 300.25 * 12700，getter 仍返回300。
  });
}, 30_000);

nativeTest("真实 PPT 单页合并表格使用对象unsupported错误码，不误报多页", async () => {
  await withModel("slide", async (engine, fileId) => {
    const shapeId = (await engine.tool("slide_add_table", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 100, rows: 2, cols: 2 })).shape_id as string;
    await engine.tool("slide_merge_table_cells", { file_id: fileId, page_index: 0, shape_id: shapeId, start_row: 0, start_col: 0, row_span: 1, col_span: 2 });
    await expect(readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "slide-pages", pageIndices: [0] }))
      .rejects.toMatchObject({ code: "office_selection_slide_objects_unsupported" });
  });
}, 30_000);

nativeTest("真实 SDK 规范化小写函数名后可确认选区修改并保存重开，未选单元格保留", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    for (const row of [0, 1]) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row, col: 0, value_type: "NUMBER", number_value: row + 1 } });
    const document = { documentId: "formula-case", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "公式.xlsx", name: "公式.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 1, endColIndex: 1 }] }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "formula-case-capture");
    await edits.prepareTurn("ws", "chat", "formula-case-turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "B1 填入求和公式", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "formula-case-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 1, value_type: "FORMULA", formula: "=sum(A1:A2)" } }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    await edits.save("ws", "chat", "formula-case-turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const cells = (await engine.tool("sheet_get_cell_data", { file_id: reopened, sheet_id: sheetId, start_row: 0, end_row: 1, start_col: 0, end_col: 1, return_csv: false, include_formula: true })).cells as Array<{ row: number; col: number; number_value?: number; formula?: string }>;
    expect(cells.find((cell) => cell.row === 0 && cell.col === 1)).toMatchObject({ number_value: 3, formula: "=SUM(A1:A2)" });
    expect(cells.filter((cell) => cell.col === 0).map((cell) => cell.number_value)).toEqual([1, 2]);
  });
}, 30_000);

nativeTest("真实 SDK 三格式选区颜色、字号、斜体按生效值回读", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后" });
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] };
    await call(engine, fileId, locator, "doc_update_text_property", { color: "FF0000", font_size: 18, italic: true });
  });
  await withModel("slide", async (engine, fileId) => {
    await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "前选中后" });
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapeId = (page.shapes as Array<{ id: string }>)[0].id;
    const locator: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 0, shapeId, start: 1, count: 2 };
    await call(engine, fileId, locator, "slide_set_text_property", { color: "FF0000", font_size: 18, italic: true });
    await call(engine, fileId, { ...locator, start: 0, count: 4 }, "slide_set_text_property", { bold: true });
  });
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await call(engine, fileId, { kind: "sheet-cells", sheetId, ranges: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 0 }] }, "sheet_set_cell_style", { format: { bold: true, italic: true, font_size: 18, font_color: "FFFF0000", background_color: "FF00FF00", wrap_text: true, horizontal_align: "center" } });
  });
}, 30_000);

nativeTest("真实 SDK 合并区保持拓扑，普通单元格编辑不受无关标题合并区影响", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_merge_cell", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 1 });
    const merges = await engine.tool("sheet_get_merged_cells", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 3, start_col: 0, end_col: 3 });
    const locator: OfficeSelectionLocator = { kind: "sheet-cells", sheetId, ranges: [{ startRow: 2, endRow: 2, startCol: 0, endCol: 0 }] };
    await call(engine, fileId, locator, "sheet_set_cell_value", { cell: { row: 2, col: 0, value_type: "STRING", string_value: "正文" } });
    expect(await engine.tool("sheet_get_merged_cells", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 3, start_col: 0, end_col: 3 })).toEqual(merges);
  });
}, 30_000);

nativeTest("真实 SDK 拒绝半个合并区和非锚点写入，不把含公式工作簿的空格样式实体化", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_merge_cell", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 1 });
    let endCol = 0, writes = 0;
    const document = { documentId: "merge", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "合并.xlsx", name: "合并.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 0, endColIndex: endCol }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_value") writes++; return engine.tool(name, args); }, modified: async () => {}, save: async () => document });
    await expect(edits.capture(document, "partial")).rejects.toThrow("完整合并单元格");
    endCol = 1;
    const ref = await edits.capture(document, "whole");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改为标题", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 1, value_type: "STRING", string_value: "错误" } }, ref.referenceId)).rejects.toThrow("左上角");
    expect(writes).toBe(0);
    expect((await edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 0, value_type: "STRING", string_value: "标题" } }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    expect(writes).toBe(1);
  });
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col: 0, value_type: "FORMULA", formula: "=COUNTA(B1)" } });
    let writes = 0;
    const document = { documentId: "formula", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "公式.xlsx", name: "公式.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 1, endColIndex: 1 }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_style") writes++; return engine.tool(name, args); }, modified: async () => {}, save: async () => document });
    const ref = await edits.capture(document, "blank");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "空格加粗", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_style", { format: { bold: true } }, ref.referenceId)).rejects.toThrow("空白单元格");
    expect(writes).toBe(0);
  });
}, 30_000);

for (const axis of ["row", "col"] as const) nativeTest(`真实 SDK 完整${axis === "row" ? "行" : "列"}删除回读全部单元格和样式，保存后旧坐标失效`, async () => {
  await withModel("sheet", async (engine, fileId) => {
    const before = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheet = (before.sheets as Array<{ sheet_id: string; row_count: number; col_count: number }>)[0];
    for (let row = 0; row < 3; row++) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheet.sheet_id, cell: { row: axis === "row" ? row : 0, col: axis === "row" ? 0 : row, value_type: "NUMBER", number_value: row + 1 } });
    const document = { documentId: "dimension", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "数据.xlsx", name: "数据.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId: sheet.sheet_id, selectionKind: axis === "row" ? "rows" : "columns", ranges: [{ sheetId: sheet.sheet_id, startRowIndex: 0, endRowIndex: axis === "row" ? 0 : sheet.row_count - 1, startColIndex: 0, endColIndex: axis === "row" ? sheet.col_count - 1 : 0 }] }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "dimension-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "dimension-request", text: "删除选择的维度", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "turn", "assistant", "sheet_delete_dimension", {}, ref.referenceId))?.receipt?.requiresReselection).toBe(true);
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_delete_dimension", {}, ref.referenceId)).rejects.toThrow("坐标");
    const after = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    expect((after.sheets as typeof before.sheets as Array<Record<string, number>>)[0][axis === "row" ? "row_count" : "col_count"]).toBe(sheet[axis === "row" ? "row_count" : "col_count"] - 1);
    const values = await engine.tool("sheet_get_cell_data", { file_id: fileId, sheet_id: sheet.sheet_id, start_row: 0, end_row: axis === "row" ? 3 : 0, start_col: 0, end_col: axis === "row" ? 0 : 3, return_csv: false });
    expect((values.cells as Array<{ number_value: number }>).map((cell) => cell.number_value)).toEqual([2, 3]);
  });
}, 30_000);

/** 测试只创建隔离模板副本；产品不新增 Agent 创建文档能力。 */
async function withModel(
  kind: "doc" | "sheet" | "slide",
  verify: (engine: OfficeEngine, fileId: string, path: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-selection-native-"));
  const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
  let path: string | undefined;
  try {
    const created = await engine.tool(`create_${kind}`, {});
    if (typeof created.file_path !== "string" || typeof created.file_id !== "string")
      throw new Error("隔离模板缺少模型身份或原路径");
    path = created.file_path;
    const fileId = created.file_id;
    const query = { doc: "doc_get_last_operable_pos", sheet: "sheet_get_sheet_info", slide: "slide_get_info" }[kind];
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const info = await engine.tool(query, { file_id: fileId });
        if (kind !== "slide" || info.is_open === true) break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline) throw new Error("隔离模型未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await verify(engine, fileId, path);
  } finally {
    // 仅处置本测试实例。先退出原生进程，再移除其模板及日志，不触及桌面正在编辑的文件。
    await engine.dispose();
    if (path) await rm(path, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

/** 用生产范围解析生成 SDK 参数；此用例核对映射，不代表浮层、消息归属或内容基线已接入。 */
async function call(
  engine: OfficeEngine,
  fileId: string,
  locator: OfficeSelectionLocator,
  name: string,
  input: Record<string, unknown>,
) {
  const plan = planOfficeSelectionTool(locator, fileId, name, input);
  const query = engine.tool.bind(engine);
  const before = await readOfficeSelectionProof(query, fileId, locator);
  const output = await engine.tool(name, plan.args);
  const after = await readOfficeSelectionProof(query, fileId, locator);
  verifyOfficeSelectionEdit(before, after, locator, name, plan.args);
  return output;
}

nativeTest("真实 SDK 按第二处 Word 原生范围替换，保存重开后第一处同文案保留", async () => {
  await withModel("doc", async (engine, fileId, path) => {
    const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
    await engine.tool("doc_insert_text", { file_id: fileId, idx: end.position, text: "同文案 间隔 同文案" });
    const found = await engine.tool("doc_find", { file_id: fileId, text: "同文案" });
    const matches = (found.locations as Array<{ begin: number; end: number }>).map(({ begin, end }) => ({ begin, end })).sort((a, b) => a.begin - b.begin);
    expect(matches).toHaveLength(2);
    const selected = matches[1];
    const locator = parseOfficeSelection("doc", {
      ranges: [{ ...selected, length: selected.end - selected.begin }], selectedText: "同文案",
    })!.locator!;
    await call(engine, fileId, locator, "doc_replace_text", { text: "新标题" });
    const unchanged = await engine.tool("doc_find", { file_id: fileId, text: "同文案" });
    expect((unchanged.locations as Array<{ begin: number; end: number }>).map(({ begin, end }) => ({ begin, end }))).toEqual([matches[0]]);
    const updated = await engine.tool("doc_find", { file_id: fileId, text: "新标题" });
    expect(updated.total).toBe(1);
    expect((updated.locations as Array<{ begin: number }>)[0].begin).toBe(selected.begin);
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    expect((await engine.tool("doc_find", { file_id: reopened, text: "同文案" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: reopened, text: "新标题" })).total).toBe(1);
  });
}, 30_000);

nativeTest("真实 SDK 含空段落的 Word 可以采集及定点改写，空段落和其他文字保留", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "选区正文" });
    for (const text of ["", "保留尾段"]) {
      const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: end.position, text, type: 0 });
    }
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "full", text_preview_length: 200 });
    expect((structure.nodes as Array<Record<string, unknown>>).some((node) => node.start_index === node.end_index && node.text_preview === undefined)).toBe(true);
    const document = { documentId: "empty-paragraph", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "正文.docx", name: "正文.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin: 0, end: 2, length: 2 }], selectedText: "选区" }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "empty-paragraph-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改成修改", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "修改" }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    await edits.save("ws", "chat", "turn", ref.referenceId);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "修改正文" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "保留尾段" })).total).toBe(1);
  });
}, 30_000);

for (const selectLong of [false, true]) nativeTest(`真实 Word ${selectLong ? "158 字中文截断段内" : "短正文"}选区可采集和确认改写，未选表格及超长段落保留`, async () => {
  await withModel("doc", async (engine, fileId) => {
    const tools = await engine.listTools();
    const tableTool = tools.find((tool) => tool.name === "doc_insert_table");
    expect(tableTool?.inputSchema.required).toEqual(["idx", "row_count", "col_count"]);
    expect(tableTool?.inputSchema.properties).toMatchObject({ idx: { type: "integer" }, row_count: { type: "integer" }, col_count: { type: "integer" } });
    const longChinese = "中文正文" + "甲".repeat(150) + "末尾保留";
    const unrelatedLong = "未选长段" + "乙".repeat(500);
    expect(longChinese).toHaveLength(158);
    expect(Buffer.byteLength(longChinese)).toBeGreaterThan(200);
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "短选区正文" });
    for (const text of [longChinese, unrelatedLong]) {
      const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: end.position, text });
    }
    const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
    await engine.tool("doc_insert_table", { file_id: fileId, idx: end.position, row_count: 1, col_count: 1 });
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "compact", text_preview_length: 200 });
    const nodes = structure.nodes as Array<{ type: string; paragraph_id?: string; table_id?: string; start_index: number; end_index: number; text_preview?: string }>;
    const longNode = nodes.find((node) => node.text_preview?.startsWith("中文正文"))!;
    expect(longNode.end_index - longNode.start_index).toBe(longChinese.length);
    expect(longNode.text_preview!.length).toBeLessThan(longChinese.length);
    const table = nodes.find((node) => node.type === "Table")!;
    expect(table.table_id).toBeDefined();
    const tableText = "未选表格" + "丙".repeat(220) + "表尾";
    await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: table.table_id, cells: [{ row: 1, col: 1, text: tableText }] });
    const selectedText = selectLong ? "末尾" : "选区";
    const found = await engine.tool("doc_find", { file_id: fileId, text: selectedText });
    expect(found.total).toBe(1);
    const { begin, end: finish } = (found.locations as Array<{ begin: number; end: number }>)[0];
    expect(finish).toBeLessThanOrEqual(256);
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin, end: finish }] };
    const proof = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    const selectedNode = selectLong ? longNode : nodes[0];
    expect((proof.state.nodes as typeof nodes).find((node) => node.paragraph_id === selectedNode.paragraph_id)?.text_preview)
      .toBe(selectLong ? longChinese : "短选区正文");
    expect((proof.state.nodes as typeof nodes).find((node) => node.text_preview?.startsWith("未选长段"))?.text_preview).toBe(unrelatedLong);
    const tableProof = (proof.state.nodes as Array<Record<string, any>>).find((node) => node.type === "Table")!;
    expect(tableProof.content.block.table.cells[0].text).toBe(tableText);
    const document = { documentId: "mixed-doc", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "混合正文.docx", name: "混合正文.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin, end: finish, length: finish - begin }], selectedText }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => document });
    const ref = await edits.capture(document, "mixed-doc-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "将所选文字改成新正文", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect(edits.context("ws", "chat", "turn").contents[0].ranges[0].paragraphs).toEqual([selectedText]);
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "新正文" }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    expect((await engine.tool("doc_find", { file_id: fileId, text: selectLong ? longChinese.replace("末尾", "新正文") : "短新正文正文" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: selectLong ? "短选区正文" : longChinese })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: unrelatedLong })).total).toBe(1);
    const after = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "compact", text_preview_length: 200 });
    expect((after.nodes as typeof nodes).find((node) => node.type === "Table")).toMatchObject({
      table_id: table.table_id, start_index: tableProof.start_index + 1, end_index: tableProof.end_index + 1,
    });
    const tableInfo = await engine.tool("doc_get_table_info", { file_id: fileId, table_id: table.table_id });
    expect((tableInfo.block as typeof tableProof.content.block).table.cells[0].text).toBe(tableText);
  });
}, 60_000);

for (const collateral of ["long-paragraph", "table", "table-tail-bold", "table-paragraph"] as const) nativeTest(`真实 Word 未选${collateral}误改即使版本符合仍拒绝确认和保存`, async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后" });
    const long = "未选长段" + "甲".repeat(500) + "尾字";
    await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: 4, text: long });
    const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
    await engine.tool("doc_insert_table", { file_id: fileId, idx: end.position, row_count: 2, col_count: 1 });
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "compact" });
    const table = (structure.nodes as Array<{ type: string; table_id: string }>).find((node) => node.type === "Table")!;
    const cellText = "未选表格" + "乙".repeat(220) + "尾字";
    await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: table.table_id, cells: [{ row: 2, col: 1, text: cellText }] });
    let injected = false, saves = 0;
    const document = { documentId: "collateral", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "回归.docx", name: "回归.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin: 1, end: 3, length: 2 }], selectedText: "选中" }),
      tool: async (name, args) => {
        const result = await engine.tool(name, args);
        if (name === "doc_replace_text" && !injected) {
          if (collateral === "table") await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: table.table_id, cells: [{ row: 2, col: 1, text: cellText.slice(0, -1) + "错" }] });
          else if (collateral === "table-tail-bold") {
            const before = await engine.tool("doc_get_table_info", { file_id: fileId, table_id: table.table_id });
            await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: table.table_id,
              cells: [{ row: 2, col: 1, runs: [{ text: cellText.slice(0, -1) }, { text: cellText.slice(-1), format: { bold: true } }] }] });
            const after = await engine.tool("doc_get_table_info", { file_id: fileId, table_id: table.table_id });
            // 证明只靠table-info首字符样式确实看不到这次尾字变化。
            expect(after.block).toEqual(before.block);
          } else if (collateral === "table-paragraph") {
            await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: table.table_id,
              cells: [{ row: 2, col: 1, horizontal_align: "right" }] });
          }
          else {
            const found = await engine.tool("doc_find", { file_id: fileId, text: long });
            const location = (found.locations as Array<{ begin: number; end: number }>)[0];
            await engine.tool("doc_replace_text", { file_id: fileId, ranges: [{ begin: location.end - 1, end: location.end }], text: "错" });
          }
          injected = true;
        }
        // 模拟一次原生写入附带误改：额外原生调用的版本不暴露，确保由完整内容而非版本差拒绝。
        return injected && typeof result.version === "number" && name !== "doc_replace_text" ? { ...result, version: result.version - 1 } : result;
      }, modified: async () => {}, save: async () => { saves++; return document; } });
    const ref = await edits.capture(document, "collateral-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "替换所选文字", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "修改" }, ref.referenceId))
      .rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    await expect(edits.save("ws", "chat", "turn", ref.referenceId)).rejects.toThrow("暂不能");
    expect(saves).toBe(0);
    expect(injected).toBe(true);
  });
}, 60_000);

nativeTest("真实 Word 中间分页无公开只读类型事实时blocked，不信任未知Paragraph", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后" + "未选尾段".repeat(10) });
    await engine.tool("doc_insert_page_break", { file_id: fileId, idx: 4 });
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "full" });
    const page = (structure.nodes as Array<Record<string, unknown>>)[1];
    expect(page).toMatchObject({ type: "Paragraph", start_index: 5, end_index: 6 });
    expect(page.text_preview).toBeUndefined();
    expect((await engine.tool("doc_find", { file_id: fileId, text: "\f" })).total).toBe(0);
    const property = await engine.tool("doc_get_paragraph_property", { file_id: fileId, idx: page.start_index });
    expect(property.type).toBeUndefined(); expect(property.page_break_before).toBe(false);
    await expect(readOfficeSelectionProof(engine.tool.bind(engine), fileId, { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] }))
      .rejects.toThrow("无法完整证明此处分页结构");
  });
}, 30_000);

nativeTest("真实 Word 全文16384边界扩写及光标插入均零写，原内容及版本不变", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "选中" });
    let last = 2;
    while (last < 16384) {
      // ASCII 段落在200字节预览内完整返回，避免重复中文候选耗尽doc_find结果预算。
      const text = "x".repeat(Math.min(199, 16384 - last - 1));
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: last, text });
      last = Number((await engine.tool("doc_get_last_operable_pos", { file_id: fileId })).position);
    }
    const before = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
    expect(before.position).toBe(16384);
    let writes = 0;
    const document = { documentId: "span", pageId: "page", workspaceId: "ws", ownerSessionId: "chat",
      relativePath: "预算.docx", name: "预算.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    for (const caret of [false, true]) {
      const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
        selection: async () => ({ ranges: [{ begin: 1, end: caret ? 1 : 2, length: caret ? 0 : 1 }], selectedText: caret ? "" : "中" }),
        tool: async (name, args) => { if (["doc_insert_text", "doc_replace_text"].includes(name)) writes++; return engine.tool(name, args); },
        modified: async () => { throw new Error("预算拒绝不应写入"); }, save: async () => document });
      const ref = await edits.capture(document, "capture");
      await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId],
        officeInstructions: [{ instructionId: "i", text: "扩写", bindingState: "bound", referenceIds: [ref.referenceId] }] });
      await expect(edits.call("ws", "chat", "turn", "assistant", caret ? "doc_insert_text" : "doc_replace_text", { text: "扩写" }, ref.referenceId))
        .rejects.toThrow("16384");
    }
    expect(writes).toBe(0);
    expect(await engine.tool("doc_get_last_operable_pos", { file_id: fileId })).toEqual(before);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "选中" })).total).toBe(1);
  });
}, 60_000);

nativeTest("真实 Word 未选分页可保留和移位核对，所选及跨越分页仍拒绝", async () => {
  await withModel("doc", async (engine, fileId, path) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后尾段" });
    await engine.tool("doc_insert_page_break", { file_id: fileId, idx: 4 });
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] };
    const before = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    const nodes = before.state.nodes as Array<Record<string, any>>;
    expect(nodes[1]).toMatchObject({ type: "Paragraph", start_index: 5, end_index: 6, content: { type: "PageBreak" } });
    expect(nodes[1].text_preview).toBeUndefined();
    for (const selection of [{ kind: "doc-caret" as const, idx: 5 },
      { kind: "doc-text" as const, ranges: [{ begin: 1, end: 8 }] }])
      await expect(readOfficeSelectionProof(engine.tool.bind(engine), fileId, selection))
        .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
    await call(engine, fileId, locator, "doc_replace_text", { text: "新正文" });
    const after = await readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    expect((after.state.nodes as typeof nodes)[1]).toEqual({ ...nodes[1], start_index: 6, end_index: 7 });
    expect((await engine.tool("doc_get_last_operable_pos", { file_id: fileId })).preceding_text)
      .toBe("前新正文后[line_break][page_break][line_break]尾段");
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const saved = await readOfficeSelectionProof(engine.tool.bind(engine), reopened, locator);
    expect((saved.state.nodes as typeof nodes)[1]).toMatchObject({ start_index: 6, end_index: 7, content: { type: "PageBreak" } });
  });
}, 30_000);

nativeTest("真实 Word 未选2×2表格含空格和emoji，前段移位可确认，多段单元格保守拒绝", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后" });
    const inserted = await engine.tool("doc_insert_table", { file_id: fileId, idx: 4, row_count: 2, col_count: 2 });
    const tableId = (inserted.table_info as { id: string }).id;
    const texts = ["表头", "", "未选长格" + "甲".repeat(220) + "尾字", "末格😀"];
    await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: tableId,
      cells: texts.map((text, index) => ({ row: Math.floor(index / 2) + 1, col: index % 2 + 1, text })) });
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] };
    const read = () => readOfficeSelectionProof(engine.tool.bind(engine), fileId, locator);
    const before = await read();
    const tableBefore = (before.state.nodes as Array<Record<string, any>>).find((node) => node.type === "Table")!;
    await call(engine, fileId, locator, "doc_replace_text", { text: "新正文" });
    const after = await read();
    const tableAfter = (after.state.nodes as Array<Record<string, any>>).find((node) => node.type === "Table")!;
    expect(tableAfter.start_index).toBe(tableBefore.start_index + 1);
    expect(tableAfter.content).toEqual(tableBefore.content);
    expect(tableAfter.content.block.table.cells.map((cell: { text: string }) => cell.text)).toEqual(texts);
    await engine.tool("doc_set_table_cells", { file_id: fileId, table_id: tableId,
      cells: [{ row: 2, col: 2, paragraphs: [{ runs: [{ text: "第一段" }] }, { runs: [{ text: "第二段" }] }] }] });
    await expect(read()).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  });
}, 60_000);

nativeTest("真实 Word 无paragraph_id的首个长中文段仍可采集、最终全文匹配及确认改写", async () => {
  await withModel("doc", async (engine, fileId, path) => {
    const text = "真实首段" + "甲".repeat(150) + "末尾保留";
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text });
    await engine.save(fileId);
    await engine.close(fileId);
    // 仅改独立模板，移除Word原生段落ID，重开后用真实SDK验证缺省身份。
    const { readFile, writeFile } = await import("node:fs/promises");
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(path));
    const xml = await zip.file("word/document.xml")!.async("string");
    const stripped = xml.replace(/\s[\w]+:(?:paraId|textId)="[^"]*"/g, "");
    expect(stripped).not.toBe(xml);
    zip.file("word/document.xml", stripped);
    await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: reopened, mode: "compact", text_preview_length: 200 });
    const first = (structure.nodes as Array<Record<string, unknown>>)[0];
    expect(first.start_index).toBe(0);
    expect(first.paragraph_id).toBeUndefined();
    expect(String(first.text_preview).length).toBeLessThan(text.length);
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] };
    let fullMatch = false;
    const proof = await readOfficeSelectionProof(async (name, args) => {
      const result = await engine.tool(name, args);
      if (name === "doc_find" && args.text === text) {
        expect(result.version).toBe(structure.version);
        expect(result.locations).toEqual([expect.objectContaining({ begin: 0, end: text.length })]);
        fullMatch = true;
      }
      return result;
    }, reopened, locator);
    expect(fullMatch).toBe(true);
    expect((proof.state.nodes as Array<Record<string, unknown>>)[0].text_preview).toBe(text);
    await call(engine, reopened, locator, "doc_replace_text", { text: "修改" });
    expect((await engine.tool("doc_find", { file_id: reopened, text: "修改" + text.slice(2) })).total).toBe(1);
  });
}, 60_000);

for (const fillEmpty of [false, true]) nativeTest(`真实 Word 跨段改写${fillEmpty ? "填入空段" : "保留空段"}和 emoji，保存重开保留首尾文字及段落属性`, async () => {
  await withModel("doc", async (engine, fileId, path) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前缀甲😀" });
    for (const text of ["", "", "乙丙后缀", "未选末段"]) {
      const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: end.position, text, paragraph_property: { spacing_after: 8 } });
    }
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "full", text_preview_length: 200 });
    const nodes = structure.nodes as Array<{ start_index: number; end_index: number; text_preview?: string }>;
    const target = nodes.find((node) => node.text_preview === "乙丙后缀")!;
    const locator = { kind: "doc-text" as const, ranges: [{ begin: 2, end: target.start_index + 2 }] };
    const selectedText = officeDocRangeParts({ nodes: nodes.map((node) => ({ ...node, text_preview: node.text_preview ?? "" })) }, locator.ranges[0]).map((part) => part.text).join("\r");
    expect(selectedText).toBe("甲😀\r\r乙丙");
    await engine.tool("doc_update_text_property", { file_id: fileId, ranges: [{ begin: 0, end: 2 }], color: "FF0000", bold: true });
    await engine.tool("doc_update_text_property", { file_id: fileId, ranges: [{ begin: target.start_index + 2, end: target.end_index }], italic: true });
    let writes = 0;
    const document = { documentId: "cross", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "跨段.docx", name: "跨段.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ ...locator.ranges[0], length: locator.ranges[0].end - 2 }], selectedText }),
      tool: async (name, args) => { if (["doc_replace_text", "doc_insert_text", "doc_update_text_property"].includes(name)) writes++; return engine.tool(name, args); },
      modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "cross");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "按段润色并加粗", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect(edits.context("ws", "chat", "turn").contents[0].ranges[0].paragraphs).toEqual(["甲😀", "", "乙丙"]);
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_update_text_property", { bold: true }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    const styleWrites = writes;
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "不能合成一段" }, ref.referenceId)).rejects.toThrow("相同段数");
    expect(writes).toBe(styleWrites);
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: `改写😀\r\n${fillEmpty ? "中段" : ""}\r\n新尾` }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    expect(writes).toBe(styleWrites + (fillEmpty ? 3 : 2));
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "重试" }, ref.referenceId)).rejects.toThrow("重新选择");
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const updated = await engine.tool("doc_resolve_document_structure", { file_id: reopened, mode: "full", text_preview_length: 200 });
    const actual = updated.nodes as typeof nodes;
    expect(actual.map((node) => node.text_preview ?? "")).toEqual(nodes.map((node, i) => i === 0 ? "前缀改写😀" : node === target ? "新尾后缀"
      : fillEmpty && node.start_index === node.end_index && node.start_index < target.start_index ? "中段" : node.text_preview ?? ""));
    expect(await engine.tool("doc_get_text_property", { file_id: reopened, idx: 0 })).toMatchObject({ bold: true, color: "FF0000" });
    const suffix = actual.find((node) => node.text_preview === "新尾后缀")!;
    expect(await engine.tool("doc_get_text_property", { file_id: reopened, idx: suffix.start_index + 2 })).toMatchObject({ italic: true });
    expect(await engine.tool("doc_get_paragraph_property", { file_id: reopened, idx: suffix.start_index })).toMatchObject({ spacing: { after_pt: 8 } });
  });
}, 30_000);

nativeTest("真实 Word 跨段改写发生部分写入后不自动重试或确认保存", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "第一段" });
    await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: 3, text: "第二段" });
    const document = { documentId: "partial", pageId: "page", workspaceId: "ws", ownerSessionId: "chat", relativePath: "跨段.docx", name: "跨段.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    let writes = 0;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin: 1, end: 6, length: 5 }], selectedText: "一段\r第二" }),
      tool: async (name, args) => { if (name === "doc_replace_text" && ++writes === 2) throw new Error("写入响应中断"); return engine.tool(name, args); },
      modified: async () => {}, save: async () => document });
    const ref = await edits.capture(document, "partial");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "逐段改写", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "改一\n改二" }, ref.referenceId)).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "改一\n改二" }, ref.referenceId)).rejects.toThrow("尚待核对");
    await expect(edits.save("ws", "chat", "turn", ref.referenceId)).rejects.toThrow("暂不能");
    expect(writes).toBe(2);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "第一段" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "改二段" })).total).toBe(1);
  });
}, 30_000);

nativeTest("真实 SDK 的本轮引用在草稿清理后仍固定原模型，漏引用拒绝，同表两个引用连续写入及保存可确认", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    for (const col of [0, 1]) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col, value_type: "NUMBER", number_value: col + 1 } });
    let col = 0, saves = 0, writes = 0;
    const document: OfficeDocumentSession = { documentId: "od_fixed", pageId: "page-fixed", artifactId: "artifact", workspaceId: "ws", ownerSessionId: "ses", relativePath: "固定.xlsx", name: "固定.xlsx", state: "ready", engineFileId: fileId, previewUrl: null, dirty: true, savedAt: null };
    const edits = new OfficeSelectionEdits({
      document: async () => structuredClone(document), prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: col, endColIndex: col }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_value") writes++; return engine.tool(name, args); },
      modified: async () => {}, save: async () => { saves++; await engine.save(fileId); return document; },
    });
    const a = await edits.capture(document, "capture-a"); col = 1;
    const b = await edits.capture(document, "capture-b");
    const submission = { officeSelectionRefs: [a.referenceId, b.referenceId], officeInstructions: [
      { instructionId: "i-a", text: "A1 改为 10", bindingState: "bound" as const, referenceIds: [a.referenceId] },
      { instructionId: "i-b", text: "B1 改为 20", bindingState: "bound" as const, referenceIds: [b.referenceId] },
    ] };
    await edits.prepareTurn("ws", "ses", "user-turn", submission);
    edits.release("ws", "ses", [a.referenceId, b.referenceId]);
    await expect(edits.call("ws", "ses", "user-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 999 } })).rejects.toThrow("selectionRef");
    await expect(edits.save("ws", "ses", "user-turn")).rejects.toThrow("selectionRef");
    expect(writes).toBe(0); expect(saves).toBe(0);
    for (const [ref, column, value] of [[a, 0, 10], [b, 1, 20]] as const) {
      const result = await edits.call("ws", "ses", "user-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: column, value_type: "NUMBER", number_value: value } }, ref.referenceId);
      expect(result?.receipt?.status).toBe("modified");
    }
    await edits.save("ws", "ses", "user-turn", a.referenceId);
    expect(writes).toBe(2); expect(saves).toBe(1);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const actualSheet = ((await engine.tool("sheet_get_sheet_info", { file_id: reopened })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    expect((await engine.tool("sheet_get_cell_data", { file_id: reopened, sheet_id: actualSheet, start_row: 0, end_row: 0, start_col: 0, end_col: 1, return_csv: true })).csv_data).toBe("10,20");
  });
}, 30_000);

nativeTest("真实 SDK 写入后响应丢失时不重复执行；失去选区的指令与旧内容不能接收为有效新任务", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 1 } });
    let writes = 0;
    const document: OfficeDocumentSession = { documentId: "od_unknown", pageId: "page-unknown", artifactId: "artifact", workspaceId: "ws", ownerSessionId: "ses", relativePath: "待核对.xlsx", name: "待核对.xlsx", state: "ready", engineFileId: fileId, previewUrl: null, dirty: true, savedAt: null };
    const edits = new OfficeSelectionEdits({
      document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 0, endColIndex: 0 }] }),
      tool: async (name, args) => { const result = await engine.tool(name, args); if (name === "sheet_set_cell_value") { writes++; throw new Error("response timed out after application"); } return result; },
      modified: async () => { throw new Error("未知效果不得确认交付"); }, save: async () => { throw new Error("未知效果不得确认保存"); },
    });
    const ref = await edits.capture(document, "capture");
    await expect(edits.prepareTurn("ws", "ses", "orphan", { officeSelectionRefs: [], officeInstructions: [{ instructionId: "i", text: "删除选中内容", referenceIds: [], bindingState: "needs-selection" }] })).rejects.toThrow("重新选择");
    const submission = { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改为 20", referenceIds: [ref.referenceId], bindingState: "bound" as const }] };
    await edits.prepareTurn("ws", "ses", "user", submission);
    const args = { cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 20 } };
    await expect(edits.call("ws", "ses", "user", "assistant", "sheet_set_cell_value", args, ref.referenceId)).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    await expect(edits.call("ws", "ses", "user", "assistant", "sheet_set_cell_value", args, ref.referenceId)).rejects.toThrow("待核对");
    await expect(edits.save("ws", "ses", "user", ref.referenceId)).rejects.toThrow("尚未确认");
    expect(writes).toBe(1);
    expect((await engine.tool("sheet_get_cell_data", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 0, return_csv: true })).csv_data).toBe("20");
    await expect(edits.prepareTurn("ws", "ses", "new-user", submission)).rejects.toMatchObject({ code: "office_selection_save_blocked" });
  });
}, 30_000);

nativeTest("真实 SDK 第二子表 A8/B8 连续范围写值，首表同名单元格与旁边数据保存后保留", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const first = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const firstId = (first.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_add_sheet", { file_id: fileId, name: "第二子表" });
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const secondId = (info.sheets as Array<{ sheet_id: string; name: string }>).find((sheet) => sheet.name === "第二子表")!.sheet_id;
    for (const [sheetId, col, value] of [[firstId, 0, 10], [secondId, 0, 10], [secondId, 1, 20], [secondId, 2, 30]] as const)
      await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 7, col, value_type: "NUMBER", number_value: value } });
    for (const [col, value] of [[0, 100], [1, 200]]) {
      const locator: OfficeSelectionLocator = { kind: "sheet-cells", sheetId: secondId, ranges: [{ startRow: 7, endRow: 7, startCol: col, endCol: col }] };
      await call(engine, fileId, locator, "sheet_set_cell_value", { cell: { row: 7, col, value_type: "NUMBER", number_value: value } });
    }
    const read = (model: string, sheetId: string, lastCol: number) => engine.tool("sheet_get_cell_data", {
      file_id: model, sheet_id: sheetId, start_row: 7, end_row: 7, start_col: 0, end_col: lastCol, return_csv: true,
    });
    expect((await read(fileId, firstId, 0)).csv_data).toBe("10");
    expect((await read(fileId, secondId, 2)).csv_data).toBe("100,200,30");
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const sheets = (await engine.tool("sheet_get_sheet_info", { file_id: reopened })).sheets as Array<{ sheet_id: string; name: string }>;
    expect((await read(reopened, sheets[0].sheet_id, 0)).csv_data).toBe("10");
    expect((await read(reopened, sheets.find((sheet) => sheet.name === "第二子表")!.sheet_id, 2)).csv_data).toBe("100,200,30");
  });
}, 30_000);

nativeTest("真实 SDK 同页同文案形状只修改第二框内两个字的加粗，邻字与第一框保存重开后保留", async () => {
  await withModel("slide", async (engine, fileId, path) => {
    for (const x of [20, 200])
      await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x, y: 20, w: 150, h: 50, text: "前选中后", font_size: 20 });
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapes = page.shapes as Array<{ id: string; x: number }>;
    const selected = shapes.find((shape) => shape.x === 200)!;
    const locator: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 0, shapeId: selected.id, start: 1, count: 2 };
    await call(engine, fileId, locator, "slide_set_text_property", { bold: true });
    const verify = async (model: string) => {
      const current = await engine.tool("slide_get_page_info", { file_id: model, page_index: 0 });
      for (const shape of current.shapes as Array<{ id: string; x: number }>) {
        const text = await engine.tool("slide_get_text", { file_id: model, page_index: 0, shape_id: shape.id });
        expect(text.text).toBe("前选中后\r");
        const runs = text.runs as Array<{ start: number; end: number; bold?: boolean }>;
        for (let offset = 0; offset < (text.length as number); offset++) {
          const run = runs.find((run) => offset >= run.start && offset < run.end)!;
          expect(run).toBeDefined();
          expect(run.bold === true).toBe(shape.x === 200 && offset >= 1 && offset < 3);
        }
      }
    };
    await verify(fileId);
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    await verify((await engine.editor(path))!.file_id);
  });
}, 30_000);

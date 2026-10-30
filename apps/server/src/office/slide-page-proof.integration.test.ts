import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { OfficeEngine } from "./engine.js";
import { OfficeSelectionEdits } from "./selection-edits.js";
import { readOfficeSelectionProof } from "./selection-proof.js";
import { slidePageScope, type SlidePageState } from "./slide-page-proof.js";

const nativeTest = process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;
const locator = { kind: "slide-pages" as const, pageIndices: [0] };
const dimensions = [{ w: 180, h: 0 }, { w: 0, h: 180 }, { w: 180, h: 180 }];

/** 独立原生进程及新建模板；不连接桌面或用户正在使用的模型。 */
async function withSlide(verify: (engine: OfficeEngine, fileId: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-slide-line-native-"));
  const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
  let path: string | undefined;
  try {
    const created = await engine.tool("create_slide", {});
    if (typeof created.file_path !== "string" || typeof created.file_id !== "string") throw new Error("隔离模板缺少身份");
    path = created.file_path;
    const deadline = Date.now() + 15_000;
    while ((await engine.tool("slide_get_info", { file_id: created.file_id })).is_open !== true) {
      if (Date.now() >= deadline) throw new Error("隔离模型未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await verify(engine, created.file_id, path);
  } finally {
    await engine.dispose();
    if (path) await rm(path, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

/** SDK 新增工具实际生成 p:sp；仅在已关闭的隔离模板内构造标准 p:cxnSp 导入样本。 */
async function importConnectors(engine: OfficeEngine, fileId: string, path: string) {
  await engine.save(fileId);
  await engine.close(fileId);
  const zip = await JSZip.loadAsync(await readFile(path));
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  let count = 0;
  const changed = xml.replace(/<p:sp>.*?<\/p:sp>/gs, (shape) => {
    if (!shape.includes('<a:prstGeom prst="line">') || /<a:t\b/.test(shape)) return shape;
    count++;
    return shape.replace(/<p:sp>/g, "<p:cxnSp>").replace(/<\/p:sp>/g, "</p:cxnSp>")
      .replace(/p:nvSpPr/g, "p:nvCxnSpPr").replace(/p:cNvSpPr/g, "p:cNvCxnSpPr")
      .replace(/<p:txBody>.*?<\/p:txBody>/gs, "");
  });
  expect(count).toBe(6);
  zip.file("ppt/slides/slide1.xml", changed);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  await engine.tool("open_file", { file_path: path, wait: true });
  return (await engine.editor(path))!.file_id;
}

function preserved(state: SlidePageState) {
  const ids = new Set(state.shapes.filter((s) => !s.editable).map((s) => s.id));
  return { shapes: state.shapes.filter((s) => ids.has(s.id)), texts: state.texts.filter((t) => ids.has(t.shapeId as string)),
    summaries: (state.page.shapes as Array<{ id: string }>).filter((s) => ids.has(s.id)) };
}

for (const type of ["shape", "connector"] as const) nativeTest(`真实 SDK ${type} 水平/垂直/斜线含组内 capture→admit→普通框编辑→save reopen，line含text仍只保留`, async () => {
  await withSlide(async (engine, originalId, path) => {
    const args = { file_id: originalId, page_index: 0 };
    await engine.tool("slide_add_text", { ...args, x: 20, y: 20, w: 200, h: 80, text: "普通框" });
    const addLine = async (x: number, y: number, w: number, h: number) => {
      await engine.tool("slide_add_line_shape", { ...args, x1: x, y1: y, x2: x + w, y2: y + h, line_type: "arrow", color: "008800" });
      // 真实新增线条只返回 ok/version，不返回 shape_id。
      const page = await engine.tool("slide_get_page_info", args);
      return (page.shapes as Array<{ id: string }>).at(-1)!.id;
    };
    for (const { w, h } of dimensions) await addLine(300, 20, w, h);
    const children: string[] = [];
    for (const { w, h } of dimensions) children.push(await addLine(550, 200, w, h));
    await engine.tool("slide_group_shapes", { ...args, shape_ids: children });
    const textLine = (await engine.tool("slide_add_shape", { ...args, x: 300, y: 400, w: 180, h: 80, shape_type: "line", border_color: "FF0000" })).shape_id;
    await engine.tool("slide_set_text", { ...args, shape_id: textLine, text: "line上的文字" });
    const fileId = type === "connector" ? await importConnectors(engine, originalId, path) : originalId;
    const query = engine.tool.bind(engine);
    const read = async () => slidePageScope((await readOfficeSelectionProof(query, fileId, locator)).state, locator);
    const before = await read();
    const target = before.shapes.find((s) => s.editable)!;
    expect(target.detail.text).toBe("普通框\r");
    expect(before.shapes.filter((s) => s.editable).map((s) => s.id)).toEqual([target.id]);
    const lines = before.shapes.filter((s) => (s.detail.style as Record<string, unknown>)?.geometry === "line");
    expect(lines).toHaveLength(7);
    const simpleLines = lines.filter((s) => s.detail.text !== "line上的文字\r");
    for (const grouped of [false, true]) {
      const groupId = before.shapes.find((s) => s.type === "group")!.id;
      const subset = simpleLines.filter((s) => (s.detail.parent_id === groupId) === grouped);
      expect(subset.map((s) => ({ type: s.type, editable: s.editable, w: (s.detail.bounds as Record<string, unknown>).w, h: (s.detail.bounds as Record<string, unknown>).h })))
        .toEqual(dimensions.map(({ w, h }) => ({ type, editable: false, w, h })));
    }
    const withText = lines.find((s) => s.detail.text === "line上的文字\r")!;
    expect(withText).toMatchObject({ type: "shape", editable: false });
    expect(before.texts.find((t) => t.shapeId === withText.id)).toMatchObject({ text: "line上的文字\r", length: 9 });
    const document = { documentId: "isolated-line-page", pageId: "host", workspaceId: "ws", ownerSessionId: "chat", relativePath: "隔离.pptx", name: "隔离.pptx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    let writes = 0;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ pageIndex: [0], shapeIds: [], nativeSlideIds: [before.pageId] }),
      tool: async (name, input) => {
        if (["slide_set_text", "slide_set_text_property", "slide_set_shape_properties"].includes(name)) writes++;
        return engine.tool(name, input);
      }, modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "修改普通框", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect(edits.context("ws", "chat", "turn").pages[0].editable).toEqual([target.id]);
    const invoke = (name: string, input: Record<string, unknown>) => edits.call("ws", "chat", "turn", "assistant", name, input, ref.referenceId);
    for (const line of lines) for (const [name, input] of [["slide_set_text", { text: "错" }], ["slide_set_text_property", { bold: true }], ["slide_set_shape_properties", { x: 30 }]] as const)
      await expect(invoke(name, { shape_id: line.id, ...input })).rejects.toThrow("只保留");
    expect(writes).toBe(0);
    for (const [name, input] of [["slide_set_text", { text: "新普通框😀" }], ["slide_set_text_property", { bold: true, color: "0000FF" }], ["slide_set_shape_properties", { x: 40, y: 30, w: 220, h: 90 }]] as const)
      expect((await invoke(name, { shape_id: target.id, ...input }))?.receipt?.readback).toBe("confirmed");
    expect(writes).toBe(3);
    expect(preserved(await read())).toEqual(preserved(before));
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const saved = slidePageScope((await readOfficeSelectionProof(query, reopened, locator)).state, locator);
    expect(saved.shapes.filter((s) => s.editable)).toMatchObject([{ detail: { text: "新普通框😀\r", bounds: { x: 40, y: 30, w: 220, h: 90 } } }]);
    const savedLines = saved.shapes.filter((s) => (s.detail.style as Record<string, unknown>)?.geometry === "line");
    expect(savedLines).toHaveLength(7);
    expect(savedLines.every((s) => !s.editable)).toBe(true);
    const facts = (items: typeof lines) => items.map((s) => ({ type: s.type, bounds: s.detail.bounds, style: s.detail.style, text: s.detail.text === "line上的文字\r" ? s.detail.text : undefined }));
    expect(facts(savedLines)).toEqual(facts(lines));
    expect(saved.shapes.filter((s) => s.type === "group")).toHaveLength(1);
  });
}, 60_000);

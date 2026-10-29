import { expect, test } from "bun:test";
import type { OfficeDocumentSession } from "@jugglework/types/office";
import { officeProofJson, readOfficeSelectionProof, verifyOfficeSelectionEdit } from "./selection-proof.js";
import { OfficeSelectionEdits } from "./selection-edits.js";
import { describeOfficeSelectionTool, planOfficeSelectionTool } from "./selection-tools.js";
import { slidePageGetter, slidePageScope } from "./slide-page-proof.js";

type Value = Record<string, any>;
const locator = { kind: "slide-pages" as const, pageIndices: [0] };
/** 真实 SDK 字段形状的隔离模型；变更注入能绕过版本差以检验完整内容比较。 */
function fixture() {
  let revision = 1;
  const summaries: Value[] = ["a", "b"].map((id, i) => ({ id, type: "shape", text: "同文案\r", x: 20, y: i * 100 + 20, w: 200, h: 80, font_size: 18 }));
  const details: Value[] = summaries.map(({ x, y, w, h, ...s }) => ({ ...s, page_id: "page", page_index: 0, parent_id: "root", name: "", is_placeholder: false, bounds: { x, y, w, h }, style: { geometry: "rect", fill_type: "none" } }));
  const texts: Value[] = summaries.map((s) => ({ ok: true, shape_id: s.id, page_index: 0, text: s.text, length: s.text.length,
    runs: [{ start: 0, end: s.text.length, font_size: 18, underline: 0 }], paragraphs: [{ start: 0, end: s.text.length }], hyperlinks: [] }));
  let writes = 0, saves = 0, afterWrite: (() => void) | undefined;
  const tool = async (name: string, args: Value): Promise<Value> => {
    const i = details.findIndex((s) => s.id === args.shape_id);
    let result: Value;
    if (name === "slide_get_info") result = { version: revision, slide_ids: ["page"], slide_count: 1, w_pt: 960, h_pt: 540, w_emu: 12192000, h_emu: 6858000 };
    else if (name === "slide_get_page_info") result = { version: revision, page_id: "page", page_index: 0, shape_count: summaries.length, shapes: summaries, animations: [], anim_count: 0 };
    else if (name === "slide_get_shape_info") result = { ...details[i], version: revision };
    else if (name === "slide_get_text") result = { ...texts[i], version: revision };
    else {
      writes++;
      if (name === "slide_set_text") {
        const text = `${args.text}\r`;
        summaries[i].text = details[i].text = text;
        Object.assign(texts[i], { text, length: text.length, runs: [{ start: 0, end: text.length, font_size: 18, underline: 0 }], paragraphs: [{ start: 0, end: text.length }] });
      } else if (name === "slide_set_shape_properties") {
        for (const key of ["x", "y", "w", "h"]) if (Object.hasOwn(args, key)) summaries[i][key] = details[i].bounds[key] = args[key];
      }
      revision++;
      afterWrite?.();
      result = { ok: true, version: revision };
    }
    return structuredClone(result);
  };
  const document = { documentId: "doc", pageId: "host", workspaceId: "ws", ownerSessionId: "chat", relativePath: "页.pptx", name: "页.pptx", state: "ready", engineFileId: "model" } as OfficeDocumentSession;
  const selection = { pageIndex: [0], shapeIds: [], nativeSlideIds: ["page"] };
  const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {}, selection: async () => selection,
    tool, modified: async () => {}, save: async () => { saves++; return document; } });
  const read = () => readOfficeSelectionProof(tool, "model", locator);
  const admit = async () => {
    const ref = await edits.capture(document, "capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改整页", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    return ref;
  };
  return { tool, summaries, details, texts, edits, document, selection, read, admit, counts: () => ({ writes, saves }), inject: (f: () => void) => { afterWrite = f; } };
}

test("页 proof 保存真实身份、完整 runs，拒绝重复/缺失 shape、runs 缺漏及未知对象", async () => {
  const f = fixture();
  const proof = await f.read();
  expect(proof.state).toMatchObject({ kind: "slide-page", revision: 1, pageIds: ["page"], pageIndex: 0, pageId: "page", shapes: [{ id: "a", editable: true }, { id: "b", editable: true }] });
  expect((proof.state.texts as Value[])[0].runs).toEqual(f.texts[0].runs);
  for (const change of [(f: ReturnType<typeof fixture>) => { f.summaries[1].id = "a"; },
    (f: ReturnType<typeof fixture>) => { delete f.summaries[0].id; },
    (f: ReturnType<typeof fixture>) => { f.texts[0].runs[0].start = 1; },
    (f: ReturnType<typeof fixture>) => { f.texts[0].runs.push({ start: 1, end: 4 }); },
    (f: ReturnType<typeof fixture>) => { f.details[0].page_id = "other"; }]) {
    const broken = fixture(); change(broken); await expect(broken.read()).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
  f.summaries[0].type = "chart";
  await expect(f.read()).rejects.toThrow("chart 对象");
});

test("页 planner 只绑定 baseline 白名单；任意对象、跨页、批量、视觉、越界及非法 geometry 零写", async () => {
  const f = fixture(), proof = await f.read();
  const plan = (name: string, args: Value) => planOfficeSelectionTool(locator, "model", name, args, proof.state);
  expect(plan("slide_set_text", { shape_id: "a", text: "甲\r\n乙\n\r" })).toMatchObject({ effect: "content", args: { text: "甲\r乙\r\r", page_index: 0, file_id: "model" } });
  expect(plan("slide_set_text_property", { shape_id: "a", bold: true }).args).toMatchObject({ index: 0, count: 4 });
  for (const args of [{ shape_id: "alien", text: "错" }, { shape_id: "a", text: "错", page_index: 1 }, { shape_id: "a", text: "错", file_id: "alien" },
    { shape_id: "a", text: "错", shapes: [] }, { shape_id: "a", text: "" }]) expect(() => plan("slide_set_text", args)).toThrow();
  for (const args of [{ x: Infinity }, { w: 0 }, { x: -1 }, { h: NaN }, { x: 900 }, { rotation: 0 }, { fill_color: "FF0000" }, { shape_ids: ["a"], x: 30 }])
    expect(() => plan("slide_set_shape_properties", { shape_id: "a", ...args })).toThrow();
  for (const args of [{ font_size: Infinity }, { font_size: 0 }, { bold: "yes" }, { color: "FFFFFFFF" }, { count: -1, bold: true }, { count: 5, bold: true }, { underline: "single" }])
    expect(() => plan("slide_set_text_property", { shape_id: "a", ...args })).toThrow();
  for (const name of ["slide_remove_shapes", "slide_add_text", "slide_set_background", "slide_set_theme"]) expect(() => plan(name, {})).toThrow();
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_text", { shape_id: "a", text: "错" })).toThrow("对象目录");
  expect(f.counts().writes).toBe(0);
});

test("整框/geometry 后页引用继续 ready，但旧 text/shape 引用混用 admission 拒绝", async () => {
  const f = fixture();
  const page = await f.edits.capture(f.document, "page");
  const text = await f.edits.capture(f.document, "text", { pageIndex: 0, shapeIds: ["a"], textSelection: { shapeId: "a", start: 0, count: 1, selectedText: "同" } });
  const refs = [page.referenceId, text.referenceId];
  await expect(f.edits.prepareTurn("ws", "chat", "mixed", { officeSelectionRefs: refs, officeInstructions: [{ instructionId: "i", text: "改写", bindingState: "bound", referenceIds: refs }] })).rejects.toThrow("同轮");
  const ref = await f.admit();
  for (const [name, args] of [["slide_set_text", { shape_id: "a", text: "扩写😀\r末尾\r" }],
    ["slide_set_shape_properties", { shape_id: "a", x: 50 }], ["slide_set_text", { shape_id: "b", text: "另一个框" }]] as const)
    expect((await f.edits.call("ws", "chat", "turn", "assistant", name, args, ref.referenceId))?.receipt?.requiresReselection).toBe(false);
  const result = await f.edits.call("ws", "chat", "turn", "assistant", "slide_get_text", { shape_id: "a" }, ref.referenceId);
  expect(result?.output.text).toBe("扩写😀\r末尾\r\r");
  expect(f.edits.context("ws", "chat", "turn").pages[0].editable).toEqual(["a", "b"]);
  await f.edits.save("ws", "chat", "turn", ref.referenceId);
  expect(f.counts()).toEqual({ writes: 3, saves: 1 });
});

for (const collateral of ["text", "tail-style", "shape-style", "geometry", "body-pr"]) test(`整页 ${collateral} collateral 不能凭相同版本和目标文字确认`, async () => {
  const f = fixture(), ref = await f.admit();
  f.inject(() => {
    if (collateral === "text") f.texts[1].text = f.details[1].text = f.summaries[1].text = "被误改\r";
    if (collateral === "tail-style") f.texts[1].runs = [{ start: 0, end: 3, font_size: 18, underline: 0 }, { start: 3, end: 4, font_size: 18, underline: 0, bold: true }];
    if (collateral === "shape-style") f.details[1].style.shadow = { color: "FF0000" };
    if (collateral === "geometry") f.details[1].bounds.x = f.summaries[1].x = 30;
    if (collateral === "body-pr") f.details[0].body_pr = { wrap: "none" };
  });
  await expect(f.edits.call("ws", "chat", "turn", "assistant", "slide_set_text", { shape_id: "a", text: "新标题" }, ref.referenceId)).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
  expect(() => f.edits.assertDocumentSaveAllowed("ws", "doc", f.document)).toThrow("暂不能保存");
  await expect(f.edits.save("ws", "chat", "turn", ref.referenceId)).rejects.toThrow();
  expect(f.counts()).toEqual({ writes: 1, saves: 0 });
});

test("running 与 lost-write 禁止所有保存入口，未知结果不重复写，ready 中间态允许保存", async () => {
  const f = fixture(), ref = await f.admit();
  expect(() => f.edits.assertDocumentSaveAllowed("ws", "doc", f.document)).not.toThrow();
  f.inject(() => {
    expect(() => f.edits.assertDocumentSaveAllowed("ws", "doc", f.document)).toThrow();
    expect(() => f.edits.assertDocumentSaveAllowed("other", "doc", f.document)).not.toThrow();
    throw new Error("applied, response lost");
  });
  const call = () => f.edits.call("ws", "chat", "turn", "assistant", "slide_set_text", { shape_id: "a", text: "已写入" }, ref.referenceId);
  await expect(call()).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
  await expect(call()).rejects.toThrow("尚待核对");
  expect(() => f.edits.assertDocumentSaveAllowed("ws", "doc", f.document)).toThrow();
  expect(f.counts().writes).toBe(1);
  expect(f.texts[0].text).toBe("已写入\r");
});

test("页 getter 从证明返回完整内容，schema 只描述可执行参数且不改原生目录", async () => {
  const f = fixture(), proof = await f.read(), state = slidePageScope(proof.state, locator);
  expect(slidePageGetter(state, "slide_get_text", { shape_id: "a" })).toMatchObject({ text: "同文案\r", runs: f.texts[0].runs, paragraphs: f.texts[0].paragraphs });
  const native = { name: "slide_set_shape_properties", description: "batch", inputSchema: { properties: { file_id: {}, page_index: {}, shape_id: {}, shapes: {}, rotation: {}, x: {}, y: {}, w: {}, h: {} }, required: ["file_id", "page_index"] } };
  const adapted = describeOfficeSelectionTool(native, locator);
  expect(Object.keys(adapted.inputSchema.properties as object)).toEqual(["file_id", "page_index", "shape_id", "x", "y", "w", "h"]);
  expect(adapted.inputSchema.required).toEqual(["shape_id"]);
  expect(adapted.description).toContain("整数 pt");
  expect(adapted.inputSchema.properties).toMatchObject({ x: { type: "integer", minimum: 0 }, w: { type: "integer", minimum: 1 } });
  expect(native.description).toBe("batch");
});

test("mixed runs 不从首字符摘要补默认；首字局部样式成功，其他位置缺省变显式须拒绝", async () => {
  const f = fixture();
  const before = await f.read(), after = structuredClone(before);
  after.state.revision = 2;
  const text = (after.state.texts as Value[])[0];
  text.runs = [{ start: 0, end: 1, font_size: 24, underline: 0, color: "FF0000" }, { start: 1, end: 4, font_size: 18, underline: 0 }];
  (after.state.shapes as Value[])[0].detail.font_color = "FF0000";
  (after.state.shapes as Value[])[0].detail.font_size = 24;
  ((after.state.page as Value).shapes as Value[])[0].font_color = "FF0000";
  ((after.state.page as Value).shapes as Value[])[0].font_size = 24;
  const args = { shape_id: "a", index: 0, count: 1, color: "FF0000", font_size: 24 };
  expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).not.toThrow();
  const next = structuredClone(after); next.state.revision = 3;
  (next.state.texts as Value[])[0].runs = [text.runs[0], { start: 1, end: 2, font_size: 18, underline: 0, color: "00FF00" },
    { start: 2, end: 4, font_size: 18, underline: 0 }];
  const green = { shape_id: "a", index: 1, count: 1, color: "00FF00" };
  expect(() => verifyOfficeSelectionEdit(after, next, locator, "slide_set_text_property", green)).not.toThrow();
  (next.state.texts as Value[])[0].runs.splice(2, 1, { start: 2, end: 3, font_size: 18, underline: 0 }, { start: 3, end: 4, font_size: 18, underline: 0, color: "FF0000" });
  expect(() => verifyOfficeSelectionEdit(after, next, locator, "slide_set_text_property", green)).toThrow("尚未确认");
  delete (next.state.texts as Value[])[0].runs[3].color;
  (next.state.texts as Value[])[0].runs[3].bold = false;
  expect(() => verifyOfficeSelectionEdit(after, next, locator, "slide_set_text_property", green)).toThrow("尚未确认");
});

test("页边界由EMU派生允许960.5pt，核对取整摘要及结束EMU；geometry只接受整数pt", async () => {
  const f = fixture();
  let reads = 0;
  const read = (endDelta = 0, summary = 961) => readOfficeSelectionProof(async (name, args) => {
    const result = await f.tool(name, args);
    return name === "slide_get_info" ? { ...result, w_emu: 12198350 + (++reads % 2 === 0 ? endDelta : 0), w_pt: summary } : result;
  }, "model", locator);
  const proof = await read();
  expect(proof.state.size).toMatchObject({ w: 960.5, wEmu: 12198350 });
  for (const key of ["x", "y", "w", "h"]) expect(() => planOfficeSelectionTool(locator, "model", "slide_set_shape_properties", { shape_id: "a", [key]: 20.5 }, proof.state)).toThrow("整数 pt");
  expect(planOfficeSelectionTool(locator, "model", "slide_set_shape_properties", { shape_id: "a", x: 760 }, proof.state).args.x).toBe(760);
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_shape_properties", { shape_id: "a", x: 761 }, proof.state)).toThrow("边界");
  await expect(read(1)).rejects.toThrow("正在变化");
  await expect(read(0, 960)).rejects.toThrow();
});

test("仅末尾CR允许已验证的邻字字体展开，不把首字摘要、其它run或显式值当等价默认", async () => {
  const f = fixture(), before = await f.read();
  (before.state.texts as Value[])[0].runs = [{ start: 0, end: 3, font_name: "+mn-lt", font_size: 18, underline: 0 }, { start: 3, end: 4, underline: 0 }];
  const after = structuredClone(before); after.state.revision = 2;
  (after.state.texts as Value[])[0].runs = [{ start: 0, end: 1, color: "FF0000", font_name: "+mn-lt", font_size: 18, underline: 0 },
    { start: 1, end: 3, font_name: "+mn-lt", font_size: 18, underline: 0 }, { start: 3, end: 4, font_name: "+mn-lt", font_size: 18, underline: 0 }];
  const args = { shape_id: "a", index: 0, count: 1, color: "FF0000" };
  expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).not.toThrow();
  (after.state.texts as Value[])[0].runs[2].font_size = 24;
  expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).toThrow("尚未确认");
  (after.state.texts as Value[])[0].runs[2].font_size = 18;
  (before.state.texts as Value[])[0].runs[1].font_size = 12;
  expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).toThrow("尚未确认");
});

test("无text body装饰形状必须有完整空读取，保持保留且不把空内容伪造为CR", async () => {
  const f = fixture();
  delete f.details[1].text; delete f.summaries[1].text;
  Object.assign(f.texts[1], { text: "", length: 0, runs: [], paragraphs: [], hyperlinks: [] });
  const proof = await f.read(), state = slidePageScope(proof.state, locator);
  expect(state.shapes[1].editable).toBe(false);
  expect(slidePageGetter(state, "slide_get_text", { shape_id: "b" })).toMatchObject({ text: "", length: 0, runs: [], paragraphs: [] });
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_text", { shape_id: "b", text: "错" }, proof.state)).toThrow("只保留");
  f.texts[1].runs = [{ start: 0, end: 1 }];
  await expect(f.read()).rejects.toThrow("完整空文字");
});

test("真实类型及line geometry允许水平/垂直/斜线；即使含text也仅保留，普通框仍可编辑", async () => {
  for (const type of ["shape", "connector"]) for (const [w, h] of [[180, 0], [0, 180], [180, 180]]) {
    const f = fixture();
    f.summaries[1].type = f.details[1].type = type;
    f.details[1].style.geometry = "line";
    Object.assign(f.summaries[1], { w, h }); Object.assign(f.details[1].bounds, { w, h });
    const proof = await f.read(), state = slidePageScope(proof.state, locator);
    expect(state.shapes.map(({ id, editable }) => ({ id, editable }))).toEqual([{ id: "a", editable: true }, { id: "b", editable: false }]);
    expect(slidePageGetter(state, "slide_get_shape_info", { shape_id: "b" })).toMatchObject({ type, editable: false, bounds: { w, h }, style: { geometry: "line" }, text: "同文案\r" });
    if (type === "shape") expect(slidePageGetter(state, "slide_get_text", { shape_id: "b" })).toMatchObject({ text: "同文案\r", runs: f.texts[1].runs });
    const ref = await f.admit(), invoke = (name: string, args: Value) => f.edits.call("ws", "chat", "turn", "assistant", name, args, ref.referenceId);
    for (const [name, input] of [["slide_set_text", { text: "错" }], ["slide_set_text_property", { bold: true }], ["slide_set_shape_properties", { x: 30 }]] as const)
      await expect(invoke(name, { shape_id: "b", ...input })).rejects.toThrow("只保留");
    expect(f.counts().writes).toBe(0);
    for (const [name, input] of [["slide_set_text", { text: "新普通框" }], ["slide_set_shape_properties", { x: 30 }]] as const)
      expect((await invoke(name, { shape_id: "a", ...input }))?.receipt?.readback).toBe("confirmed");
    const after = await f.read();
    expect((after.state.shapes as Value[])[1]).toEqual(state.shapes[1]);
    expect((after.state.texts as Value[]).filter((t) => t.shapeId === "b")).toEqual(state.texts.filter((t) => t.shapeId === "b"));
  }
});

test("零面积须由shape/connector的line geometry确认；未知几何、其他类型、负值和非法尺寸拒绝", async () => {
  for (const type of ["shape", "connector"]) for (const geometry of ["rect", "unknown", "Line", "", undefined]) for (const [w, h] of [[180, 0], [0, 180]]) {
    const f = fixture();
    f.summaries[1].type = f.details[1].type = type;
    f.details[1].style.geometry = geometry;
    Object.assign(f.summaries[1], { w, h }); Object.assign(f.details[1].bounds, { w, h });
    await expect(f.read()).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
  for (const type of ["picture", "table", "group"]) {
    const f = fixture();
    f.summaries[1].type = f.details[1].type = type;
    f.details[1].style.geometry = "line";
    f.summaries[1].h = f.details[1].bounds.h = 0;
    await expect(f.read()).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
  for (const type of ["shape", "connector"]) for (const [w, h] of [[0, 0], [-1, 180], [180, -1], [-1, -1], [0.5, 0], [0, NaN], [Infinity, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) {
    const f = fixture();
    f.summaries[1].type = f.details[1].type = type;
    f.details[1].style.geometry = "line";
    Object.assign(f.summaries[1], { w, h }); Object.assign(f.details[1].bounds, { w, h });
    await expect(f.read()).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
  const mismatch = fixture();
  mismatch.details[1].style.geometry = "line";
  mismatch.summaries[1].h = 0;
  await expect(mismatch.read()).rejects.toThrow("位置与详细读取不一致");
});

test("line完整公开事实仍受写后核对，不能隐藏为普通框编辑的collateral", async () => {
  for (const collateral of ["geometry", "style", "text"]) {
    const f = fixture();
    f.details[1].style.geometry = "line";
    f.summaries[1].h = f.details[1].bounds.h = 0;
    const ref = await f.admit();
    f.inject(() => {
      if (collateral === "geometry") f.summaries[1].x = f.details[1].bounds.x = 30;
      if (collateral === "style") f.details[1].style.border = { color: "FF0000" };
      if (collateral === "text") f.texts[1].runs[0].bold = true;
    });
    await expect(f.edits.call("ws", "chat", "turn", "assistant", "slide_set_text", { shape_id: "a", text: "新普通框" }, ref.referenceId))
      .rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    expect(f.counts().writes).toBe(1);
  }
});

test("单页对象unsupported与多页错误码分离；旧PPT proof允许4096内容及唯一尾CR", async () => {
  const f = fixture(); f.summaries[0].type = "chart";
  await expect(f.read()).rejects.toMatchObject({ code: "office_selection_slide_objects_unsupported" });
  await expect(readOfficeSelectionProof(f.tool, "model", { kind: "slide-pages", pageIndices: [0, 1] })).rejects.toMatchObject({ code: "office_selection_slide_pages_unsupported" });
  const g = fixture();
  for (const [length, cr, accepted] of [[4096, false, true], [4097, true, true], [4097, false, false], [4098, true, false]] as const) {
    const text = "a".repeat(length - Number(cr)) + (cr ? "\r" : "");
    Object.assign(g.texts[0], { text, length, runs: [{ start: 0, end: length }] });
    g.summaries[0].text = g.details[0].text = text;
    const read = readOfficeSelectionProof(g.tool, "model", { kind: "slide-text", pageIndex: 0, shapeId: "a", start: 0, count: 1 });
    if (accepted) expect((await read).state.kind).toBe("slide");
    else await expect(read).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
});

test("累计文字/shape/proof 预算写前拒绝；非旋转普通框之外保持只读", async () => {
  const f = fixture();
  f.details[0].bounds.rotation = f.summaries[0].rotation = 30;
  let proof = await f.read();
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_text", { shape_id: "a", text: "错" }, proof.state)).toThrow("只保留");
  delete f.details[0].bounds.rotation; delete f.summaries[0].rotation;
  proof = await f.read();
  const state = proof.state as Value;
  state.texts = Array.from({ length: 4 }, (_, i) => ({ ...state.texts[0], shapeId: i ? `box${i}` : "a", text: "a".repeat(4095) + "\r", length: 4096, runs: [{ start: 0, end: 4096 }] }));
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_text", { shape_id: "a", text: "a".repeat(4096) }, state)).toThrow("16384");
  state.texts = [{ ...f.texts[0], shapeId: "a", runs: [{ start: 0, end: 4, unknown_style: "x".repeat(1_100_000) }] }];
  expect(() => planOfficeSelectionTool(locator, "model", "slide_set_text_property", { shape_id: "a", bold: true }, state)).toThrow("4 MiB");
  f.summaries.push(...Array.from({ length: 127 }, (_, i) => ({ id: `extra${i}`, type: "shape" })));
  await expect(f.read()).rejects.toThrow();
  expect(f.counts().writes).toBe(0);
});

/** 全部通过公开 capture/admission 建立真实保留量，不修改 edits 私有记录或缩小生产预算。 */
async function retainedBudgetFixture() {
  const models = new Map<string, ReturnType<typeof fixture>>();
  let onWrite: (() => Promise<void>) | undefined;
  const edits = new OfficeSelectionEdits({
    document: async (_workspace, _session, id) => models.get(id)!.document,
    prepare: async () => {}, selection: async () => ({ pageIndex: [0], shapeIds: [], nativeSlideIds: ["page"] }),
    tool: async (name, args) => {
      const result = await models.get(args.file_id as string)!.tool(name, args);
      if (name === "slide_set_text") await onWrite?.();
      return result;
    }, modified: async () => {}, save: async (document) => document,
  });
  let retained = 0;
  const add = async (id: string, bytes?: number, admit = true) => {
    const f = fixture();
    Object.assign(f.document, { documentId: id, engineFileId: id });
    if (bytes) {
      const baseBytes = Buffer.byteLength(officeProofJson((await f.read()).state));
      f.details[0].name = "p".repeat(bytes - baseBytes);
    }
    models.set(id, f);
    const ref = await edits.capture(f.document, id);
    const submission = { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改整页", bindingState: "bound" as const, referenceIds: [ref.referenceId] }] };
    const prepare = () => edits.prepareTurn("ws", "chat", id, submission);
    if (admit) { await prepare(); retained += Buffer.byteLength(officeProofJson((await f.read()).state)); }
    return { f, ref, prepare, call: (name: string, args: Value) => edits.call("ws", "chat", id, "assistant", name, args, ref.referenceId) };
  };
  const fillerBytes = (64 * 1024 * 1024 - 512 * 1024) / 16;
  for (let i = 0; i < 16; i++) await add(`filler${i}`, fillerBytes);
  const target = await add("target"), other = await add("other");
  return { edits, models, add, target, other, retained, onWrite: (callback: () => Promise<void>) => { onWrite = callback; } };
}

test("正常capture/admission逼近64MiB后扩4096写前拒绝零写入，其他ref及ready不受影响，可缩小后连续成功", async () => {
  const { edits, add, target, other, retained } = await retainedBudgetFixture();
  expect(retained).toBeGreaterThan(63 * 1024 * 1024);
  expect(retained).toBeLessThan(64 * 1024 * 1024);
  await expect(target.call("slide_set_text", { shape_id: "a", text: "x".repeat(4096) })).rejects.toMatchObject({ code: "office_selection_capacity" });
  expect(target.f.counts().writes).toBe(0);
  expect((await target.call("slide_get_text", { shape_id: "a" }))?.output.text).toBe("同文案\r");
  expect((await other.call("slide_get_text", { shape_id: "b" }))?.output.text).toBe("同文案\r");
  expect(() => edits.assertDocumentSaveAllowed("ws", "target", target.f.document)).not.toThrow();
  for (const text of ["短", "再次缩小"]) expect((await target.call("slide_set_text", { shape_id: "a", text }))?.receipt?.readback).toBe("confirmed");
  expect(target.f.counts().writes).toBe(2);
  const excess = await add("excess", 1024 * 1024, false);
  await expect(excess.prepare()).rejects.toMatchObject({ code: "office_selection_capacity" });
  expect(edits.context("ws", "chat", "excess").mode).toBe("current-document");
  expect((await other.call("slide_set_text", { shape_id: "b", text: "仍可编辑" }))?.receipt?.readback).toBe("confirmed");
}, 60_000);

test("写前预算通过后若其他admission耗尽余量，写后仍needs-verification且不保留超限proof", async () => {
  const { edits, add, target, other, retained, onWrite } = await retainedBudgetFixture();
  // 模拟原生调用等待期间另一个文档正常入队：新 admission 自身未超限，但回读增长将超限。
  onWrite(async () => { await add("arrived-during-write", 64 * 1024 * 1024 - retained - 16); });
  await expect(target.call("slide_set_text", { shape_id: "a", text: "x".repeat(100) })).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
  expect(target.f.counts().writes).toBe(1);
  expect(() => edits.assertDocumentSaveAllowed("ws", "target", target.f.document)).toThrow("暂不能保存");
  await expect(target.call("slide_set_text", { shape_id: "a", text: "不重试" })).rejects.toThrow("尚待核对");
  expect((await other.call("slide_get_text", { shape_id: "a" }))?.output.text).toBe("同文案\r");
  // 独立重算长期基线：只在测试观察，不修改私有状态，确保超限 after 未替换原 proof。
  const turns = (edits as unknown as { turns: Map<string, { executions: Map<string, { baselines: Map<string, { state: Value }> }> }> }).turns;
  let bytes = 0;
  for (const turn of turns.values()) for (const execution of turn.executions.values()) for (const proof of execution.baselines.values()) bytes += Buffer.byteLength(officeProofJson(proof.state));
  expect(bytes).toBe(64 * 1024 * 1024 - 16);
}, 60_000);

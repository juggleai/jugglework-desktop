import { beforeEach, expect, test } from "bun:test";
import { createEditor, $getRoot, $createParagraphNode, $createTextNode, $getSelection, $isRangeSelection, $isTextNode,
  KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND, KEY_ARROW_LEFT_COMMAND, KEY_ARROW_RIGHT_COMMAND, INSERT_LINE_BREAK_COMMAND, UNDO_COMMAND, REDO_COMMAND, type LexicalCommand } from "lexical";
import { registerPlainText } from "@lexical/plain-text";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { $createOfficeInstructionNode, $readOfficeComposerDraft, $removeOfficeSelectionTag, ComposerOfficeInstructionNode, ComposerOfficeSelectionTagNode, registerOfficeSelectionEditing } from "../src/react-app/domains/session/surface/composer/office-selection-node";
import { getComposerOfficeGroups, useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import type { OfficeComposerGroup } from "../src/react-app/domains/session/surface/composer/office-selection-draft";
import { insertStyledPastedText } from "../src/react-app/domains/session/surface/composer/pasted-text-insertion";

// TIPS: pnpm test 使用 development 导出；Lexical 的 node 导出含延迟初始化，不能在 Bun 隔离加载时先继承尚未就绪的节点类。
const group: OfficeComposerGroup = { references: [{ referenceId: "ref", captureId: "capture", documentId: "document", workspaceId: "ws", ownerSessionId: "chat", sourcePageId: "page", modelGeneration: "page:model", contentStamp: "stamp", capturedAt: 1,
  locator: { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] }, preview: { name: "文档.docx", range: "0–2", text: "正文" } }],
  instruction: { instructionId: "instruction", text: "甲😀乙", bindingState: "bound", referenceIds: ["ref"] } };
beforeEach(() => useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, officeEpochs: {} }));

/** 使用生产节点、普通文字键盘处理及实际历史插件，不模拟删除字符串算法。 */
function harness(text = "甲😀乙") {
  const editor = createEditor({ namespace: "office-editor-regression", nodes: [ComposerOfficeInstructionNode, ComposerOfficeSelectionTagNode], onError(error) { throw error; } });
  registerHistory(editor, createEmptyHistoryState(), 0);
  registerPlainText(editor);
  registerOfficeSelectionEditing(editor);
  const initial = { ...group, instruction: { ...group.instruction, text } };
  useComposerStateStore.getState().syncOfficeEditor("chat", "上一行末尾\n[office-instruction instruction]", [initial]);
  editor.registerUpdateListener(({ editorState }) => editorState.read(() => {
    const state = useComposerStateStore.getState();
    const parsed = $readOfficeComposerDraft(getComposerOfficeGroups(state, "chat"));
    state.syncOfficeEditor("chat", parsed.draft, parsed.groups);
  }));
  editor.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode("上一行末尾")), $createOfficeInstructionNode(initial));
  }, { discrete: true, tag: "history-push" });
  const instruction = () => $getRoot().getLastChildOrThrow<ComposerOfficeInstructionNode>();
  const press = (command: LexicalCommand<KeyboardEvent | null>, event = {}) => editor.update(() => { editor.dispatchCommand(command, { preventDefault() {}, ...event } as KeyboardEvent); }, { discrete: true, tag: "history-push" });
  const content = () => getComposerOfficeGroups(useComposerStateStore.getState(), "chat")[0];
  return { editor, instruction, press, content };
}

test("文字局部选中后只删除选中文字，连续要求和原子标签不被整组删除", () => {
  const h = harness("逐字删除这段文字");
  h.editor.update(() => { const text = h.instruction().getLastChildOrThrow(); if ($isTextNode(text)) text.select(2, 4); }, { discrete: true });
  h.press(KEY_BACKSPACE_COMMAND);
  expect(h.content().instruction.text).toBe("逐字这段文字");
  expect(h.content().instruction.bindingState).toBe("bound");
});

for (const remove of ["backspace", "delete", "button"] as const) test(`${remove} 一次删除行首标签，要求文字保留，光标回上一行末尾`, () => {
  const h = harness("保留要求");
  h.editor.update(() => {
    const node = h.instruction();
    if (remove === "backspace") node.getLastChildOrThrow().selectStart();
    else if (remove === "delete") node.select(0, 0);
    else $removeOfficeSelectionTag(node.getFirstChildOrThrow<ComposerOfficeSelectionTagNode>());
  }, { discrete: true });
  if (remove === "backspace") h.press(KEY_BACKSPACE_COMMAND);
  if (remove === "delete") h.press(KEY_DELETE_COMMAND);
  expect(h.content().instruction).toMatchObject({ text: "保留要求", bindingState: "detached", referenceIds: [] });
  h.editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection)).toBe(true);
    if ($isRangeSelection(selection)) { expect(selection.anchor.getNode().getTextContent()).toBe("上一行末尾"); expect(selection.anchor.offset).toBe(5); }
    expect(h.instruction().getChildren().some((node) => node instanceof ComposerOfficeSelectionTagNode)).toBe(false);
  });
});

test("左右键跨过标签而不进入内部按钮，文字编辑位置不被重置", () => {
  const h = harness("文字");
  h.editor.update(() => h.instruction().getLastChildOrThrow().selectStart(), { discrete: true });
  h.press(KEY_ARROW_LEFT_COMMAND);
  h.editor.getEditorState().read(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) { expect(selection.anchor.getNode()).toBe(h.instruction()); expect(selection.anchor.offset).toBe(0); } });
  h.press(KEY_ARROW_RIGHT_COMMAND);
  h.editor.getEditorState().read(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) { expect(selection.anchor.getNode()).toBe(h.instruction()); expect(selection.anchor.offset).toBe(1); } });
  expect(h.content().instruction.text).toBe("文字");
});

test("范围只选中标签时仍整块移除并回上一段；没有上一段则留在当前段开头", () => {
  const h = harness("保留");
  h.editor.update(() => h.instruction().select(0, 1), { discrete: true });
  h.press(KEY_BACKSPACE_COMMAND);
  h.editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor.getNode().getTextContent()).toBe("上一行末尾");
  });
  const first = harness("保留");
  first.editor.update(() => { $getRoot().getFirstChildOrThrow().remove(); first.instruction().getLastChildOrThrow().selectStart(); }, { discrete: true });
  first.press(KEY_BACKSPACE_COMMAND);
  first.editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(0);
  });
  expect(first.content().instruction).toMatchObject({ text: "保留", bindingState: "detached" });
});

test("输入法组合中的退格不删除标签", () => {
  const h = harness();
  h.editor.update(() => h.instruction().getLastChildOrThrow().selectStart(), { discrete: true });
  h.press(KEY_BACKSPACE_COMMAND, { isComposing: true });
  expect(h.content().instruction.referenceIds).toEqual(["ref"]);
  expect(h.content().instruction.text).toBe("甲😀乙");
});

test("要求末尾换行和粘贴多行内容仍属于原选区要求，插入点后续文字不会丢失", () => {
  const h = harness("前后");
  h.editor.update(() => {
    const text = h.instruction().getLastChildOrThrow();
    if ($isTextNode(text)) text.select(1, 1);
    h.editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
  }, { discrete: true });
  expect(h.content().instruction.text).toBe("前\n后");
  h.editor.update(() => { insertStyledPastedText("新的一行\n继续"); }, { discrete: true });
  expect(h.content().instruction.text).toBe("前\n新的一行\n继续后");
  h.editor.update(() => { h.instruction().selectEnd(); h.editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false); insertStyledPastedText("末尾"); }, { discrete: true });
  expect(h.content().instruction.text).toBe("前\n新的一行\n继续后\n末尾");
  expect(h.content().instruction.referenceIds).toEqual(["ref"]);
});

test("复制得到可读标签和完整要求，内部 token 只用于草稿定位", () => {
  const h = harness("复制要求\n第二行");
  h.editor.update(() => {
    const text = $getRoot().select(0, 2).getTextContent();
    expect(text).toContain("文档选区"); expect(text).toContain("复制要求\n第二行"); expect(text).not.toContain("office-instruction");
    expect($readOfficeComposerDraft([group]).draft).toBe("上一行末尾\n[office-instruction instruction]");
  }, { discrete: true });
});

test("要求文字可撤销重做；整组删除再撤销保留原文但不恢复已释放的执行引用", async () => {
  const h = harness("原要求");
  h.editor.update(() => { const text = h.instruction().getLastChildOrThrow(); if ($isTextNode(text)) text.select(2, 3); }, { discrete: true });
  h.press(KEY_BACKSPACE_COMMAND);
  expect(h.content().instruction.text).toBe("原要");
  h.editor.dispatchCommand(UNDO_COMMAND, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.content().instruction.text).toBe("原要求");
  h.editor.dispatchCommand(REDO_COMMAND, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.content().instruction.text).toBe("原要");
  h.editor.update(() => { $getRoot().clear().append($createParagraphNode()); }, { discrete: true, tag: "history-push" });
  expect(getComposerOfficeGroups(useComposerStateStore.getState(), "chat")).toEqual([]);
  h.editor.dispatchCommand(UNDO_COMMAND, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.content().instruction).toMatchObject({ text: "原要", bindingState: "needs-selection", referenceIds: [] });
});

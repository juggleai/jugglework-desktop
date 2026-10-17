import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForSheetPageCommit,
  waitForSlidePageCommit,
  waitForWordPageCommit,
  isSlidePageComposing,
  installSlideKeyboardGuard,
} from "./office-page-commit.mjs";

function fixture() {
  const changes = {
    composeCommands: [],
    localEditCommands: [],
    inFlightCommands: new Map(),
  };
  const service = { isCommitting: false, committingQueue: [] };
  return {
    changes,
    service,
    scope: {
      App: { changesetManager: changes },
      getLocalEditManager: () => ({ getLocalEditService: () => service }),
    },
  };
}

test("Word 保存等待输入合并、待提交内容和原生确认，不主动清空队列", async () => {
  const f = fixture();
  f.changes.composeCommands.push("中文");
  let ready = false;
  const saved = waitForWordPageCommit(f.scope).then(() => {
    ready = true;
  });
  assert.equal(f.changes.composeCommands.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ready, false);
  f.changes.composeCommands.length = 0;
  f.changes.localEditCommands.push("待导入");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ready, false);
  f.changes.localEditCommands.length = 0;
  f.changes.inFlightCommands.set("revision", "中文");
  f.service.isCommitting = true;
  f.service.committingQueue.push("排队提交");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ready, false);
  f.changes.inFlightCommands.clear();
  f.service.isCommitting = false;
  f.service.committingQueue.length = 0;
  await saved;
  assert.equal(ready, true);
});

function slideFixture() {
  const editing = { hasUnsavedTextContent: true };
  const converter = { commitQueue: Promise.resolve() };
  const state = { commits: 0, gate: async () => {} };
  const editor = {
    editor: { isComposing: false },
    triggerSave() {
      if (!editing.hasUnsavedTextContent) return;
      state.commits++;
      editing.hasUnsavedTextContent = false;
      converter.commitQueue = converter.commitQueue.then(() => state.gate());
    },
  };
  const manager = {
    getEditorInstance: () => editor,
    getEditingStateManager: () => editing,
  };
  const local = {
    LocalEditManager: () => manager,
    LocalEditDataConverter: () => converter,
  };
  return {
    editor,
    editing,
    converter,
    state,
    local,
    scope: { pray: () => ({ _: { LocalEditServices: local } }) },
  };
}

test("幻灯片保存提交文字缓冲并等待原生队列，等待中新增文字需继续确认", async () => {
  const f = slideFixture();
  f.editor.editor.isComposing = true;
  let release = () => {};
  f.state.gate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let done = false;
  const pending = waitForSlidePageCommit(f.scope).then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.state.commits, 0);
  f.editor.editor.isComposing = false;
  while (!f.state.commits)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(done, false);
  f.editing.hasUnsavedTextContent = true;
  f.state.gate = async () => {};
  release();
  await pending;
  assert.equal(f.state.commits, 2);
  assert.equal(f.editing.hasUnsavedTextContent, false);
});

test("幻灯片未知契约、组合超时、提交失败和页面更换不能确认成功", async () => {
  await assert.rejects(waitForSlidePageCommit({}, 0), /提交状态不可用/);
  const composing = slideFixture();
  composing.editor.editor.isComposing = true;
  await assert.rejects(waitForSlidePageCommit(composing.scope, 0), /正在输入/);
  assert.equal(composing.editing.hasUnsavedTextContent, true);
  const failed = slideFixture();
  failed.state.gate = async () => {
    throw new Error("原生提交失败");
  };
  await assert.rejects(waitForSlidePageCommit(failed.scope), /原生提交失败/);
  const replaced = slideFixture();
  replaced.state.gate = async () => {
    Reflect.set(replaced.local, "LocalEditManager", () => ({}));
  };
  await assert.rejects(waitForSlidePageCommit(replaced.scope), /页面已失效/);
  const late = slideFixture();
  late.state.gate = () => new Promise(() => {});
  await assert.rejects(waitForSlidePageCommit(late.scope, 0), /尚未提交完成/);
});

test("PPT 页面组合保护阻止 SDK 自行保存，普通文字键及结束后的快捷键保留", () => {
  const f = slideFixture();
  assert.equal(isSlidePageComposing(f.scope), false);
  f.editor.editor.isComposing = true;
  assert.equal(isSlidePageComposing(f.scope), true);
  assert.throws(() => isSlidePageComposing({}), /输入状态不可用/);
  let handler = (_event) => { throw new Error("尚未安装键盘保护"); };
  const scope = {
    ...f.scope,
    addEventListener(name, callback, capture) {
      assert.equal(name, "keydown");
      assert.equal(capture, true);
      handler = callback;
    },
  };
  installSlideKeyboardGuard(scope);
  const blocked = [];
  for (const key of ["s", "o", "w", "a"])
    handler({
      key,
      metaKey: true,
      isComposing: false,
      preventDefault() {
        blocked.push(key);
      },
      stopImmediatePropagation() {
        blocked.push("stop");
      },
    });
  assert.deepEqual(blocked, ["s", "stop", "o", "stop", "w", "stop"]);
  f.editor.editor.isComposing = false;
  handler({
    key: "s",
    metaKey: true,
    preventDefault() {
      throw Error("不能阻止正常保存");
    },
  });
});

test("未知页面契约或未确认输入不能伪装为保存就绪", async () => {
  await assert.rejects(waitForWordPageCommit({}, 0), /提交状态不可用/);
  const f = fixture();
  f.changes.composeCommands.push("中文");
  await assert.rejects(waitForWordPageCommit(f.scope, 0), /尚未提交完成/);
});

function sheetFixture() {
  const calls = [];
  const state = {
    composing: false,
    editing: true,
    gate: async () => {},
    text: "你好",
  };
  const input = {
    isEditPending: false,
    isComposing: () => state.composing,
    isInputtingState: () => state.editing,
    async commitTableInputData() {
      calls.push("commit");
      await state.gate();
      calls.push("ack");
    },
    handleExitInput(options) {
      calls.push(options);
      state.editing = false;
    },
  };
  return {
    calls,
    state,
    input,
    scope: { SpreadsheetApp: { view: { canvas: { inputManager: input } } } },
  };
}

test("表格保存等待拼音组合及真实提交完成，仅退出一次并避免重复提交", async () => {
  const f = sheetFixture();
  f.state.composing = true;
  let release = () => {};
  f.state.gate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  let done = false;
  const pending = waitForSheetPageCommit(f.scope).then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.calls, []);
  f.state.composing = false;
  while (!f.calls.length)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(done, false);
  assert.equal(f.state.editing, true);
  release();
  await pending;
  assert.deepEqual(f.calls, ["commit", "ack", { discard: true }]);
  await waitForSheetPageCommit(f.scope);
  assert.equal(f.calls.length, 3);
});

test("表格提交失败、超时或页面变更均保留编辑状态，不能假报保存完成", async () => {
  await assert.rejects(waitForSheetPageCommit({}, 0), /提交状态不可用/);
  const composing = sheetFixture();
  composing.state.composing = true;
  await assert.rejects(waitForSheetPageCommit(composing.scope, 0), /正在输入/);
  assert.deepEqual(composing.calls, []);
  const failed = sheetFixture();
  failed.state.gate = async () => {
    throw Error("原生提交失败");
  };
  await assert.rejects(waitForSheetPageCommit(failed.scope), /原生提交失败/);
  assert.equal(failed.state.editing, true);
  const late = sheetFixture();
  late.state.gate = () => new Promise(() => {});
  await assert.rejects(waitForSheetPageCommit(late.scope, 0), /尚未提交完成/);
  assert.equal(late.state.editing, true);
  const replaced = sheetFixture();
  replaced.state.gate = async () => {
    Reflect.set(replaced.scope.SpreadsheetApp.view.canvas, "inputManager", {});
  };
  await assert.rejects(waitForSheetPageCommit(replaced.scope), /页面已失效/);
  assert.equal(replaced.state.editing, true);
});

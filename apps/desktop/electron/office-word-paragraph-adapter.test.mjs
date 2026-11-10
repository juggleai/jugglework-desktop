import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfficeWordParagraphAdapter } from "./office-word-paragraph-adapter.mjs";

/** 仅复现真实捕获的 SDK 调用形状；真实能力证据由独立双客户端 PoC 提供。 */
function fixture(initial = "甲😀乙") {
  let text = initial;
  const events = [],
    pauses = [];
  const changes = /** @type {any} */ ({
    composeCommands: [],
    localEditCommands: [],
    inFlightCommands: new Map(),
    addCommand(command) {
      return command;
    },
    applyChunkToBase() {},
  });
  const original = changes.addCommand;
  const service = {
    isCommitting: false,
    committingQueue: [],
    isGapFilling: false,
  };
  const selection = {};
  const document = /** @type {any} */ ({
    readText(start, length) {
      return text.slice(start, start + length);
    },
    getRange(begin, end) {
      return {
        setText(insert) {
          const mutations = [];
          if (end > begin) mutations.push({ ty: 2, bi: begin, ei: end });
          if (insert) mutations.push({ ty: 1, bi: begin, s: insert });
          text = text.slice(0, begin) + insert + text.slice(end);
          changes.addCommand({ mutations });
        },
      };
    },
  });
  const scope = /** @type {any} */ ({
    document: new EventTarget(),
    pad: {
      editor: {
        service: {
          getDocument: () => document,
          getSelection: () => ({ getRange: () => selection }),
        },
      },
    },
    App: {
      changesetManager: changes,
      GlobalConfig: { isLocalEditChunkFinish: true },
    },
    getLocalEditManager: () => ({ getLocalEditService: () => service }),
  });
  const adapter = createOfficeWordParagraphAdapter(
    {
      paragraphId: "553DBC6B",
      start: 0,
      text,
      onChange: (event) => events.push(event),
      onPause: (reason) => pauses.push(reason),
    },
    scope,
  );
  return {
    scope,
    changes,
    service,
    adapter,
    document,
    events,
    pauses,
    original,
    text: () => text,
    setText(value) {
      text = value;
    },
  };
}

test("远端定点回写标记 cloud；后续人工操作仍发送且原生钩子可释放", () => {
  const f = fixture();
  assert.equal(
    f.adapter.applyRemote([{ kind: "insert", index: 1, text: "远端" }]).status,
    "applied",
  );
  assert.equal(f.text(), "甲远端😀乙");
  assert.equal(f.events[0].source, "cloud");
  f.document.getRange(0, 0).setText("人工");
  assert.equal(f.events[1].source, "word");
  f.adapter.dispose();
  assert.equal(f.changes.addCommand, f.original);
  f.document.getRange(0, 0).setText("之后");
  assert.equal(f.events.length, 2);
});

test("真实 SDK 命令类先经 toJSON 标准化，不能 structuredClone 丢失转换", () => {
  const f = fixture("甲乙");
  f.setText("丙甲乙");
  f.changes.addCommand({
    mutations: [
      {
        type: 1,
        mutation: { beginIndex: 0 },
        toJSON() {
          return { ty: 1, bi: 0, s: "丙" };
        },
      },
    ],
  });
  assert.deepEqual(f.events[0].edits, [
    { kind: "insert", index: 0, text: "丙" },
  ]);
  assert.equal(f.adapter.state(), "active");
});

test("原生 AI 回传有独立来源，初始加载或重同步不能作为新增正文", () => {
  const f = fixture("甲乙");
  f.setText("AI甲乙");
  f.changes.applyChunkToBase({
    mutationWrappers: [{ ty: 1, bi: 0, s: "AI" }],
    deltaOpt: { undoOption: { fromLocalAiEdit: true } },
  });
  assert.equal(f.events[0].source, "ai");
  f.changes.applyChunkToBase({ mutationWrappers: [] });
  assert.equal(f.adapter.state(), "paused");
  assert.deepEqual(f.pauses, ["word_model_reloaded"]);
});

test("输入法及尚未提交的人工输入返回 busy，不覆盖本地、不建立重试队列", () => {
  const f = fixture();
  f.scope.document.dispatchEvent(new Event("compositionstart"));
  assert.equal(
    f.adapter.applyRemote([{ kind: "delete", index: 0, length: 1 }]).status,
    "busy",
  );
  f.scope.document.dispatchEvent(new Event("compositionend"));
  f.changes.composeCommands.push({});
  assert.equal(
    f.adapter.applyRemote([{ kind: "delete", index: 0, length: 1 }]).status,
    "busy",
  );
  f.changes.composeCommands.length = 0;
  assert.equal(f.text(), "甲😀乙");
  assert.equal(f.events.length, 0);
});

test("批内后续范围或 surrogate 边界无效时，零写入并暂停", () => {
  const f = fixture();
  const result = f.adapter.applyRemote([
    { kind: "insert", index: 0, text: "先" },
    { kind: "delete", index: 3, length: 1 },
  ]);
  assert.equal(result.status, "rejected");
  assert.equal(f.text(), "甲😀乙");
  assert.equal(f.events.length, 0);
  assert.equal(f.adapter.state(), "paused");
  const large = fixture();
  assert.equal(
    large.adapter.applyRemote([
      { kind: "insert", index: 0, text: "大".repeat(4096) },
      { kind: "delete", index: 0, length: 4096 },
    ]).status,
    "rejected",
  );
  assert.equal(large.text(), "甲😀乙");
  assert.equal(large.events.length, 0);
});

test("格式和结构超出已验证集合时暂停，不静默丢弃加粗或段落拆分", () => {
  const f = fixture();
  f.changes.addCommand({
    mutations: [{ ty: 3, mt: 101, mm: 1, pr: { run: { bold: true } } }],
  });
  assert.deepEqual(f.pauses, ["unsupported_word_format"]);
  assert.equal(f.events.length, 0);
  assert.equal(
    f.adapter.applyRemote([{ kind: "insert", index: 0, text: "改" }]).status,
    "paused",
  );
});

test("页面模型更换和 Word 自身分叉时拒绝旧绑定", () => {
  const f = fixture();
  f.scope.pad.editor = {};
  assert.equal(f.adapter.applyRemote([]).status, "paused");
  assert.deepEqual(f.pauses, ["word_model_invalidated"]);
  const other = fixture();
  other.setText("本地独立改变");
  assert.equal(
    other.adapter.applyRemote([{ kind: "insert", index: 0, text: "覆盖" }])
      .status,
    "rejected",
  );
  assert.equal(other.text(), "本地独立改变");
});

test("写入后缺少模型事件确认返回 unknown，禁止自动重放", () => {
  const f = fixture();
  f.document.getRange = (begin, end) => ({
    setText(insert) {
      f.setText(f.text().slice(0, begin) + insert + f.text().slice(end));
    },
  });
  assert.equal(
    f.adapter.applyRemote([{ kind: "insert", index: 0, text: "只写一次" }])
      .status,
    "unknown",
  );
  assert.equal(
    f.adapter.applyRemote([{ kind: "insert", index: 0, text: "只写一次" }])
      .status,
    "paused",
  );
  assert.equal(f.text(), "只写一次甲😀乙");
});

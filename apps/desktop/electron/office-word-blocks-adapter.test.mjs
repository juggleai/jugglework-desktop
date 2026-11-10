import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createOfficeWordBlocksAdapter,
  readOfficeWordBlocks,
} from "./office-word-blocks-adapter.mjs";

const clone = (value) => structuredClone(value);
const plain = (text, kind = "text") => ({
  text,
  kind,
  marks: text.length
    ? [{ index: 0, length: text.length, bold: false, italic: false }]
    : [],
});
const markCells = (block) =>
  block.marks.flatMap((mark) =>
    Array.from({ length: mark.length }, () => ({
      bold: mark.bold,
      italic: mark.italic,
    })),
  );
const compactMarks = (cells) => {
  const marks = [];
  cells.forEach((cell, index) => {
    const previous = marks.at(-1);
    if (
      previous &&
      previous.bold === cell.bold &&
      previous.italic === cell.italic
    )
      previous.length++;
    else marks.push({ index, length: 1, ...cell });
  });
  return marks;
};
const sliceBlock = (block, start, end) => ({
  text: block.text.slice(start, end),
  kind: block.kind,
  marks: compactMarks(markCells(block).slice(start, end)),
});
const mergeBlocks = (left, right) => ({
  text: left.text + right.text,
  kind: left.kind,
  marks: compactMarks(markCells(left).concat(markCells(right))),
});
/** 复现已捕获的原生命令形状，用于防止适配规则回退；不替代真实 SDK 验收。 */
function fixture() {
  const blocks = /** @type {any[]} */ ([
    { id: "553DBC6F", start: 0, ...plain("标题", "h1") },
    { id: "553DBC6B", start: 3, ...plain("甲😀乙") },
  ]);
  const events = [],
    pauses = [];
  const changes = /** @type {any} */ ({
    composeCommands: [],
    localEditCommands: [],
    inFlightCommands: new Map(),
    addCommand() {},
    applyChunkToBase() {},
  });
  const original = changes.addCommand;
  const service = {
    isCommitting: false,
    committingQueue: [],
    isGapFilling: false,
  };
  const read = () => clone(blocks);
  let writes = 0;
  const doc = /** @type {any} */ ({
    getRange(begin, end) {
      const block = blocks.find(
        (b) => begin >= b.start && end <= b.start + b.text.length,
      );
      assert.ok(block);
      return {
        setText(text) {
          writes++;
          const index = begin - block.start,
            len = end - begin,
            old = block.text.length;
          block.text =
            block.text.slice(0, index) + text + block.text.slice(index + len);
          block.marks = plain(block.text).marks;
          for (const later of blocks.slice(blocks.indexOf(block) + 1))
            later.start += block.text.length - old;
          const mutations = [];
          if (len) mutations.push({ ty: 2, bi: begin, ei: end });
          if (text) mutations.push({ ty: 1, bi: begin, s: text });
          changes.addCommand({ mutations });
        },
        getFont() {
          return {
            isBold: () => block.marks[0].bold,
            isItalic: () => block.marks[0].italic,
            setBold(value) {
              set("bold", "b", value);
            },
            setItalic(value) {
              set("italic", "i", value);
            },
          };
          function set(key, raw, value) {
            writes++;
            block.marks = block.marks.map((m) => ({ ...m, [key]: value }));
            changes.addCommand({
              mutations: [
                { ty: 3, mt: 101, pr: { run: { [raw]: { val: value } } } },
              ],
            });
          }
        },
      };
    },
  });
  const scope = /** @type {any} */ ({
    document: new EventTarget(),
    pad: { editor: { service: { getDocument: () => doc } } },
    App: {
      changesetManager: changes,
      GlobalConfig: { isLocalEditChunkFinish: true },
    },
    getLocalEditManager: () => ({ getLocalEditService: () => service }),
  });
  const adapter = createOfficeWordBlocksAdapter(
    {
      blocks: read(),
      onChange: (e) => events.push(e),
      onPause: (r) => pauses.push(r),
    },
    scope,
    read,
  );
  return {
    blocks,
    read,
    events,
    pauses,
    changes,
    original,
    service,
    scope,
    doc,
    adapter,
    writes: () => writes,
    insertFrame(i, text) {
      const { id, start, ...before } = read()[i];
      return {
        paragraphId: id,
        before,
        after: plain(text + before.text, before.kind),
        edits: [{ kind: "insert", index: 0, text }],
      };
    },
  };
}

test("前段改变后按当前 ID 和偏移回写后段，不覆盖标题", () => {
  const f = fixture();
  f.doc.getRange(0, 0).setText("前段");
  assert.equal(f.events[0].frames[0].paragraphId, "553DBC6F");
  assert.equal(f.blocks[1].start, 5);
  assert.equal(
    f.adapter.applyRemote([f.insertFrame(1, "远端")]).status,
    "applied",
  );
  assert.equal(f.blocks[0].text, "前段标题");
  assert.equal(f.blocks[1].text, "远端甲😀乙");
  assert.equal(f.events.at(-1).source, "cloud");
  f.doc.getRange(0, 0).setText("之后");
  assert.equal(f.events.at(-1).source, "word");
  f.adapter.dispose();
  assert.equal(f.changes.addCommand, f.original);
});

test("格式采用有效布尔值，空 i 属性不能翻转斜体", () => {
  const f = fixture();
  f.changes.addCommand({
    mutations: [{ ty: 3, mt: 101, pr: { run: { i: {} } } }],
  });
  assert.equal(f.events.length, 0);
  assert.equal(f.adapter.state(), "active");
  f.blocks[1].marks[0].bold = true;
  f.changes.applyChunkToBase({
    mutationWrappers: [{ ty: 3, mt: 101, pr: { run: { b: { val: true } } } }],
    deltaOpt: { undoOption: { fromLocalAiEdit: true } },
  });
  assert.equal(f.events[0].source, "ai");
  assert.equal(f.events[0].frames[0].after.marks[0].italic, false);
  const { id, start, ...before } = f.read()[1];
  const after = plain(before.text);
  assert.equal(
    f.adapter.applyRemote([{ paragraphId: id, before, after, edits: [] }])
      .status,
    "applied",
  );
  assert.equal(f.blocks[1].marks[0].bold, false);
});

test("批内后段冲突和 surrogate 切分在写入前整体拒绝", () => {
  const f = fixture();
  const invalid = f.insertFrame(1, "后");
  invalid.before.text = "分叉";
  assert.equal(
    f.adapter.applyRemote([f.insertFrame(0, "先"), invalid]).status,
    "rejected",
  );
  assert.equal(f.writes(), 0);
  const g = fixture(),
    split = g.insertFrame(1, "字");
  split.edits[0].index = 2;
  assert.equal(g.adapter.applyRemote([split]).status, "rejected");
  assert.equal(g.writes(), 0);
});

test("段落身份或类型改变时暂停，禁止继续写入", () => {
  for (const mutate of [
    (b) => (b.id = "changed"),
    (b) => (b.kind = "numbered"),
  ]) {
    const f = fixture();
    mutate(f.blocks[1]);
    f.changes.addCommand({ mutations: [] });
    assert.equal(f.adapter.state(), "paused");
    assert.equal(f.events.length, 0);
    assert.equal(f.adapter.applyRemote([]).status, "paused");
  }
});

test("输入法和未提交输入返回 busy，模型更换后暂停", () => {
  const f = fixture();
  f.scope.document.dispatchEvent(new Event("compositionstart"));
  assert.equal(f.adapter.applyRemote([f.insertFrame(1, "字")]).status, "busy");
  f.scope.document.dispatchEvent(new Event("compositionend"));
  f.service.isCommitting = true;
  assert.equal(f.adapter.applyRemote([]).status, "busy");
  assert.equal(f.writes(), 0);
  f.service.isCommitting = false;
  f.scope.pad.editor = {};
  assert.equal(f.adapter.applyRemote([]).status, "paused");
});

test("插入附属默认字体可识别，独立字号变更仍然拒绝", () => {
  const f = fixture();
  f.blocks[0].text = "字标题";
  f.blocks[0].marks = plain("字标题").marks;
  f.blocks[1].start++;
  f.changes.addCommand({
    mutations: [
      { ty: 1, bi: 0, s: "字" },
      {
        ty: 3,
        mt: 101,
        mm: 1,
        bi: 0,
        ei: 1,
        pr: {
          run: {
            rFonts: { ascii: "SimSun" },
            sz: { val: 360 },
            color: { val: "1A1A1A" },
          },
        },
      },
    ],
  });
  assert.equal(f.adapter.state(), "active");
  assert.equal(f.events.length, 1);
  f.changes.addCommand({
    mutations: [
      {
        ty: 3,
        mt: 101,
        mm: 1,
        bi: 0,
        ei: 1,
        pr: { run: { sz: { val: 360 } } },
      },
    ],
  });
  assert.deepEqual(f.pauses, ["unsupported_word_format"]);
});

test("写入缺少原生事件确认时 unknown，后续不重放", () => {
  const f = fixture();
  f.doc.getRange = () => ({
    setText() {
      f.blocks[1].text = "已写入";
    },
  });
  const frame = f.insertFrame(1, "只写一次");
  assert.equal(f.adapter.applyRemote([frame]).status, "unknown");
  assert.equal(f.adapter.applyRemote([frame]).status, "paused");
  assert.equal(f.blocks[1].text, "已写入");
});

test("读取字体以原生 false 为准并排除固定尾部标记", () => {
  const range = { begin: () => 0, end: () => 3 };
  const doc = {
    getMainStoryRange: () => ({ end: () => 5 }),
    readText: (start) => (start === 0 ? "甲乙\r" : "\x0f\x1e"),
    getParagraphs: () => ({
      count: () => 2,
      item: (i) => ({
        getRange: () => (i ? { begin: () => 3, end: () => 5 } : range),
        getFormat: () => ({
          getParaId: () => "553DBC6B",
          getAttributes: () => ({}),
          getOutlineLevel: () => 9,
        }),
      }),
    }),
    getRange: () => ({
      getSpans: () => ({
        count: () => 1,
        item: () => ({
          getRange: () => ({ begin: () => 0, end: () => 2 }),
          getFont: () => ({ isBold: () => false, isItalic: () => false }),
        }),
      }),
    }),
  };
  assert.deepEqual(
    readOfficeWordBlocks({
      pad: { editor: { service: { getDocument: () => doc } } },
    }),
    [{ id: "553DBC6B", start: 0, ...plain("甲乙") }],
  );
});

/** 复现结束符携带身份的真实 SDK 拆并形状，辅助验证来源和预校验。 */
function structureFixture(configure) {
  const f = fixture();
  f.adapter.dispose();
  f.blocks[0].kind = "text";
  configure?.(f.blocks);
  const structures = [];
  let sequence = 0,
    writes = 0;
  f.adapter = createOfficeWordBlocksAdapter(
    {
      blocks: f.read(),
      onChange: (e) => f.events.push(e),
      onStructure: (e) => structures.push(e),
      onPause: (r) => f.pauses.push(r),
    },
    f.scope,
    f.read,
  );
  const getRange = f.doc.getRange;
  const reposition = () => {
    let start = 0;
    for (const b of f.blocks) {
      b.start = start;
      start += b.text.length + 1;
    }
  };
  f.doc.getRange = (begin, end) => ({
    setText: (text) => getRange(begin, end).setText(text),
    getFont: () => getRange(begin, end).getFont(),
    insertParagraph() {
      writes++;
      const index = f.blocks.findIndex(
          (b) => begin >= b.start && begin <= b.start + b.text.length,
        ),
        old = f.blocks[index],
        offset = begin - old.start,
        id = (++sequence).toString(16).padStart(8, "0");
      f.blocks.splice(
        index,
        1,
        { id, ...sliceBlock(old, 0, offset) },
        { id: old.id, ...sliceBlock(old, offset, old.text.length) },
      );
      reposition();
      f.changes.addCommand({
        mutations: [
          { ty: 1, bi: begin, s: "\r" },
          {
            ty: 3,
            bi: begin,
            ei: begin + 1,
            mt: 101,
            pr: {
              run: { rFonts: { hint: 2 }, isPlaceholder: true, author: "p." },
            },
            mm: 1,
          },
          {
            ty: 3,
            bi: begin,
            ei: begin + 1,
            mt: 102,
            pr: { paragraph: { paraId: id, ind: {}, pStyle: {}, pBdr: {} } },
            mm: 1,
          },
          ...(offset === old.text.length
            ? [
                {
                  ty: 3,
                  mt: 102,
                  bi: begin + 1,
                  ei: begin + 2,
                  pr: { paragraph: { taskPr: {} } },
                  mm: 0,
                },
              ]
            : []),
        ],
      });
    },
    delete() {
      writes++;
      const index = f.blocks.findIndex(
          (b) => b.start + b.text.length === begin,
        ),
        left = f.blocks[index],
        right = f.blocks[index + 1];
      f.blocks.splice(index, 2, {
        id: right.id,
        ...mergeBlocks(left, right),
      });
      reposition();
      f.changes.addCommand({
        mutations: [
          { ty: 2, bi: begin, ei: end },
          {
            ty: 3,
            mt: 102,
            pr: {
              paragraph: {
                pStyleI: true,
                pBdr: { bottom: {} },
                ind: {},
                ...(right.text.length === 0 ? { taskPrI: true } : {}),
              },
            },
          },
          ...(right.text.length === 0
            ? [
                {
                  ty: 3,
                  mt: 101,
                  bi: begin,
                  ei: end,
                  pr: { run: { rFonts: {} } },
                  mm: 0,
                },
              ]
            : []),
        ],
      });
    },
  });
  return {
    ...f,
    structures,
    structureWrites: () => writes,
    identities: () => f.read().map(({ start, ...b }) => b),
  };
}

test("普通段落拆并按 SDK 右段身份重建关联，之后文本输入仍有效", () => {
  const f = structureFixture();
  const original = f.blocks[1].id;
  f.doc.getRange(4, 4).insertParagraph();
  assert.equal(f.adapter.state(), "active");
  assert.equal(f.structures[0].kind, "split");
  assert.equal(f.structures[0].after[1].id, original);
  f.doc.getRange(4, 5).delete();
  assert.equal(f.adapter.state(), "active");
  assert.equal(f.structures[1].after[0].id, original);
  f.doc.getRange(3, 3).setText("后续");
  assert.equal(f.events.at(-1).source, "word");
});

test("云端拆并仅标记本次来源，回写后人工拆段仍发送", () => {
  const f = structureFixture();
  const before = [f.identities()[1]];
  const result = f.adapter.applyRemoteStructure({
    kind: "split",
    before,
    offset: 1,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.change.source, "cloud");
  const merged = f.adapter.applyRemoteStructure({
    kind: "merge",
    before: f.identities().slice(1),
    offset: 1,
  });
  assert.equal(merged.status, "applied");
  assert.equal(merged.change.source, "cloud");
  f.doc.getRange(4, 4).insertParagraph();
  assert.equal(f.structures.at(-1).source, "word");
});

test("结构回写拒绝 surrogate、原文分叉及末段无后继，零写入", () => {
  for (const mutate of [
    (f, r) => {
      r.offset = 2;
    },
    (f, r) => {
      r.before[0].text = "分叉";
    },
    (f, r) => {
      r.kind = "merge";
      r.offset = r.before[0].text.length;
    },
  ]) {
    const f = structureFixture(),
      r = /** @type {{kind:'split'|'merge',before:any[],offset:number}} */ ({
        kind: "split",
        before: [f.identities()[1]],
        offset: 1,
      });
    mutate(f, r);
    assert.equal(f.adapter.applyRemoteStructure(r).status, "rejected");
    assert.equal(f.structureWrites(), 0);
  }
});

test("带基础字符样式的普通段落拆并保持原有 marks", () => {
  const f = structureFixture((blocks) => {
    blocks[1].marks = [
      { index: 0, length: 1, bold: true, italic: false },
      { index: 1, length: 3, bold: false, italic: true },
    ];
  });
  const before = [f.identities()[1]];
  const split = f.adapter.applyRemoteStructure({
    kind: "split",
    before,
    offset: 1,
  });
  assert.equal(split.status, "applied");
  assert.deepEqual(split.change.after[0].marks, [
    { index: 0, length: 1, bold: true, italic: false },
  ]);
  assert.deepEqual(split.change.after[1].marks, [
    { index: 0, length: 3, bold: false, italic: true },
  ]);
  const merged = f.adapter.applyRemoteStructure({
    kind: "merge",
    before: f.identities().slice(1),
    offset: 1,
  });
  assert.equal(merged.status, "applied");
  assert.deepEqual(merged.change.after[0].marks, before[0].marks);
});

test("未开启结构回调的旧组件仍拒绝拆段", () => {
  const f = fixture();
  f.blocks.splice(
    1,
    1,
    { id: "00000001", start: 3, ...plain("甲") },
    { id: "553DBC6B", start: 5, ...plain("😀乙") },
  );
  f.changes.addCommand({ mutations: [{ ty: 1, bi: 4, s: "\r" }] });
  assert.equal(f.adapter.state(), "paused");
  assert.equal(f.events.length, 0);
});

test("同次拆段夹带其他段落改动时暂停，不冒认单个结构事件", () => {
  const f = structureFixture();
  f.blocks[0].text = "另一段变化";
  f.doc.getRange(4, 4).insertParagraph();
  assert.equal(f.adapter.state(), "paused");
  assert.equal(f.structures.length, 0);
});

test("结构写入缺少原生确认返回 unknown，禁止重放", () => {
  const f = structureFixture();
  let count = 0;
  f.doc.getRange = () => ({
    insertParagraph() {
      count++;
    },
  });
  const r = /** @type {{kind:'split'|'merge',before:any[],offset:number}} */ ({
    kind: "split",
    before: [f.identities()[1]],
    offset: 1,
  });
  assert.equal(f.adapter.applyRemoteStructure(r).status, "unknown");
  assert.equal(f.adapter.applyRemoteStructure(r).status, "paused");
  assert.equal(count, 1);
});

test("空左段和空右段拆并识别 SDK 附属空 taskPr 和 taskPrI 命令", () => {
  for (const offset of [0, 4]) {
    const f = structureFixture(),
      before = [f.identities()[1]];
    assert.equal(
      f.adapter.applyRemoteStructure({ kind: "split", before, offset }).status,
      "applied",
    );
    assert.equal(
      f.adapter.applyRemoteStructure({
        kind: "merge",
        before: f.identities().slice(1),
        offset,
      }).status,
      "applied",
    );
    assert.equal(f.adapter.state(), "active");
    assert.equal(f.blocks[1].text, "甲😀乙");
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { readOfficePageText } from "./office-page-text.mjs";

test("Word 原文保留软换行且不移动真实选区，错误长度或结构占位符拒绝", async () => {
  class Range {
    constructor(begin, length) { this.start = begin; this.finish = begin + length; }
    begin() { return this.start; }
    end() { return this.finish; }
  }
  const range = new Range(2, 3), text = "标题\n副标题";
  const service = { docVersion: 6, isCommitting: false, committingQueue: [] };
  const scope = { App: { GlobalConfig: { isLocalEditChunkFinish: true }, changesetManager: { composeCommands: [], localEditCommands: [], inFlightCommands: new Map() } },
    getLocalEditManager: () => ({ getLocalEditService: () => service }),
    pad: { editor: { selection: { gcpRange: range }, getRefText: (value) => text.slice(value.begin(), value.end()) } } };
  assert.deepEqual(await readOfficePageText({ ranges: [{ begin: 0, end: text.length }], version: 7 }, scope), [text]);
  assert.deepEqual(await readOfficePageText({ ranges: [{ begin: 3, end: text.length }], version: 7 }, scope), ["副标题"]);
  assert.equal(range.begin(), 2);
  assert.equal(range.end(), 5);
  for (const invalid of [null, [{ begin: -1, end: 1 }], [{ begin: 1, end: 0 }], [{ begin: 0, end: 16385 }]])
    assert.equal(await readOfficePageText({ ranges: invalid, version: 7 }, scope), null);
  for (const invalid of ["标题副标题", "标题\r副标题", "标题\uFFFC副标题"])
    assert.equal(await readOfficePageText({ ranges: [{ begin: 0, end: text.length }], version: 7 }, { ...scope, pad: { editor: { ...scope.pad.editor, getRefText: () => invalid } } }), null);
  assert.equal(await readOfficePageText({ ranges: [{ begin: 0, end: text.length }], version: 7 }, {
    ...scope, pad: { editor: { ...scope.pad.editor, getRefText: () => { service.docVersion++; return text; } } },
  }), null, "读取期间版本变化不能返回旧原文");
});

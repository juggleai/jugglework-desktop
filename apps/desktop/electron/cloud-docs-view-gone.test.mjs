import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./cloud-docs-panel.mjs", import.meta.url), "utf8");

// 视图销毁后 Electron 会让 view.webContents 变为 undefined；退出和关闭路径不能直接调用它的方法。
test("cloud docs panel never calls webContents.isDestroyed directly on a view", () => {
  assert.equal(/view\.webContents\.isDestroyed\(\)/.test(source.replace(/const viewGone[^\n]*\n/, "")), false);
});

test("viewGone treats a missing webContents as gone", () => {
  const viewGone = new Function("item", `return ${/const viewGone = \(item\) => ([^;]+);/.exec(source)[1]}`);
  assert.equal(viewGone({ view: { webContents: undefined } }), true);
  assert.equal(viewGone({ view: { webContents: { isDestroyed: () => true } } }), true);
  assert.equal(viewGone({ view: { webContents: { isDestroyed: () => false } } }), false);
});

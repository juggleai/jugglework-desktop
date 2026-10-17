import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

mock.module("electron", () => ({ nativeImage: {} }));
const { createFileWindowDock } =
  await import("../../../desktop/electron/file-window-dock.mjs");

test("Dock 入口只传窗口摘要，激活及退出交由宿主，零窗口清理且可重新打开", async () => {
  const children: any[] = [];
  const activated: number[] = [];
  let closes = 0;
  const dock = createFileWindowDock({
    platform: "darwin",
    iconPath: "unused",
    cachePath: "unused",
    helperPath: fileURLToPath(import.meta.url),
    activate: (id: number) => activated.push(id),
    closeAll: async () => {
      closes++;
      return false;
    },
    spawnHelper: (() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        killed: false,
        kill() {
          this.killed = true;
        },
      });
      children.push(child);
      return child;
    }) as any,
  });
  dock.update([]);
  expect(children).toHaveLength(0);
  dock.update([{ id: 42, title: "报告.docx" }]);
  expect(children).toHaveLength(1);
  expect(JSON.parse(children[0].stdin.read().toString())).toEqual({
    windows: [{ id: 42, title: "报告.docx" }],
  });
  // 管道分块、连续事件都必须正确处理，取消退出不能先结束入口。
  children[0].stdout.write('{"action":"acti');
  children[0].stdout.write('vate","windowId":42}\n{"action":"close"}\n');
  await Promise.resolve();
  expect(activated).toEqual([42]);
  expect(closes).toBe(1);
  expect(children[0].killed).toBe(false);
  dock.update([]);
  expect(children[0].killed).toBe(true);
  dock.update([{ id: 43, title: "新文档.docx" }]);
  expect(children).toHaveLength(2);
  children[0].emit("exit");
  dock.update([{ id: 43, title: "已保存.docx" }]);
  expect(children).toHaveLength(2);
  dock.dispose();
  expect(children[1].killed).toBe(true);
});

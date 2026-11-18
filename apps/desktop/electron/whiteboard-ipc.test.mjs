import test from "node:test";
import assert from "node:assert/strict";
import { registerWhiteboardIpc } from "./whiteboard-ipc.mjs";

function fixture({ canceled = false } = {}) {
  const handlers = {}, listeners = {}, writes = [], dialogs = [];
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { listeners[c] = fn; } };
  const whiteboard = {
    window: () => "win",
    context: (event) => { if (event !== "board" && event?.sender !== "board") throw new Error("仅白板窗口可执行该操作"); return { title: "周会/复盘" }; },
    save: async () => {}, saveSync: (event) => { if (event.sender !== "board") throw new Error("no"); },
  };
  const dialog = { showSaveDialog: async (win, options) => { dialogs.push([win, options]); return { canceled, filePath: canceled ? undefined : "/tmp/out" }; } };
  registerWhiteboardIpc({ ipcMain, dialog, whiteboard, write: async (file, data) => { writes.push([file, data]); } });
  return { handlers, listeners, writes, dialogs };
}

test("export decodes PNG base64, sanitizes the default name and writes the chosen path", async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers["jugglework:whiteboard:export"]("board", "png", Buffer.from("PNGDATA").toString("base64")), { saved: true });
  assert.equal(f.dialogs[0][1].defaultPath, "周会 复盘.png");
  assert.deepEqual(f.writes, [["/tmp/out", Buffer.from("PNGDATA")]]);
});

test("export rejects unknown kinds, non-string data and callers other than the whiteboard", async () => {
  const f = fixture();
  await assert.rejects(f.handlers["jugglework:whiteboard:export"]("board", "exe", "x"), /无效/);
  await assert.rejects(f.handlers["jugglework:whiteboard:export"]("board", "png", 7), /无效/);
  await assert.rejects(async () => f.handlers["jugglework:whiteboard:export"]("meeting", "png", "x"), /白板窗口/);
  assert.equal(f.writes.length, 0);
});

test("cancelled dialog writes nothing", async () => {
  const f = fixture({ canceled: true });
  assert.deepEqual(await f.handlers["jugglework:whiteboard:export"]("board", "excalidraw", "{}"), { saved: false });
  assert.equal(f.writes.length, 0);
});

test("sync save sets returnValue before returning", () => {
  const f = fixture();
  const ok = { sender: "board" }, bad = { sender: "other" };
  f.listeners["jugglework:whiteboard:save-sync"](ok, "{}");
  f.listeners["jugglework:whiteboard:save-sync"](bad, "{}");
  assert.equal(ok.returnValue, true);
  assert.equal(bad.returnValue, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createWhiteboardCommands } from "./whiteboard-ipc.mjs";

function fixture({ canceled = false } = {}) {
  const mainFrame = {};
  const main = { isDestroyed: () => false, webContents: { mainFrame } };
  const meeting = { isDestroyed: () => false };
  const writes = [], dialogs = [], calls = [];
  const store = {
    open: async (meetingId) => { calls.push(["open", meetingId]); return { whiteboardId: "wb_1", scene: null }; },
    save: async (...args) => { calls.push(["save", ...args]); },
  };
  const dialog = { showSaveDialog: async (...args) => { dialogs.push(args); return { canceled, filePath: canceled ? undefined : "/tmp/out" }; } };
  const commands = createWhiteboardCommands({ store, dialog, getMainWindow: () => main, getMeetingWindow: () => meeting,
    write: async (file, data) => { writes.push([file, data]); } });
  const fromMain = { sender: main.webContents, senderFrame: mainFrame };
  return { commands, fromMain, main, meeting, writes, dialogs, calls };
}

test("open and save go to the store only for the main window main frame", async () => {
  const f = fixture();
  assert.deepEqual(await f.commands.open(f.fromMain, { meetingId: "m1" }), { whiteboardId: "wb_1", scene: null });
  await f.commands.save(f.fromMain, { meetingId: "m1", whiteboardId: "wb_1", content: "{}" });
  assert.deepEqual(f.calls, [["open", "m1"], ["save", "m1", "wb_1", "{}"]]);
  for (const event of [{ sender: {}, senderFrame: f.main.webContents.mainFrame }, { sender: f.main.webContents, senderFrame: {} }]) {
    await assert.rejects(f.commands.open(event, { meetingId: "m1" }), /会议窗口/);
    await assert.rejects(f.commands.save(event, { meetingId: "m1", whiteboardId: "wb_1", content: "{}" }), /会议窗口/);
    await assert.rejects(f.commands.exportFile(event, { kind: "png", data: "" }), /会议窗口/);
  }
  assert.equal(f.calls.length, 2);
});

test("export decodes PNG base64, sanitizes the default name and parents the dialog to the meeting window", async () => {
  const f = fixture();
  const data = Buffer.from("PNGDATA").toString("base64");
  assert.deepEqual(await f.commands.exportFile(f.fromMain, { title: "周会/复盘", kind: "png", data }), { saved: true });
  assert.equal(f.dialogs[0][0], f.meeting);
  assert.equal(f.dialogs[0][1].defaultPath, "周会 复盘.png");
  assert.deepEqual(f.writes, [["/tmp/out", Buffer.from("PNGDATA")]]);
});

test("export rejects unknown kinds and non-string data", async () => {
  const f = fixture();
  await assert.rejects(f.commands.exportFile(f.fromMain, { kind: "exe", data: "x" }), /无效/);
  await assert.rejects(f.commands.exportFile(f.fromMain, { kind: "toString", data: "x" }), /无效/);
  await assert.rejects(f.commands.exportFile(f.fromMain, { kind: "png", data: 7 }), /无效/);
  assert.equal(f.writes.length, 0);
});

test("cancelled dialog writes nothing and an empty title falls back to the default name", async () => {
  const f = fixture({ canceled: true });
  assert.deepEqual(await f.commands.exportFile(f.fromMain, { title: " / ", kind: "excalidraw", data: "{}" }), { saved: false });
  assert.equal(f.dialogs[0][1].defaultPath, "会议白板.excalidraw");
  assert.equal(f.writes.length, 0);
});

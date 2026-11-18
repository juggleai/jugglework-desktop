import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMeetingWhiteboardWindow } from "./meeting-whiteboard-window.mjs";

function fakeWindow() {
  const handlers = {};
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false,
    setWindowOpenHandler: (fn) => { handlers.open = fn; },
    session: { setPermissionRequestHandler: (fn) => { handlers.request = fn; }, setPermissionCheckHandler: (fn) => { handlers.check = fn; } },
  });
  let destroyed = false;
  const win = Object.assign(new EventEmitter(), {
    webContents, handlers, focusCount: 0,
    isDestroyed: () => destroyed,
    isMinimized: () => false, restore() {}, show() {}, focus() { win.focusCount++; },
    close() { if (destroyed) return; destroyed = true; win.emit("closed"); },
  });
  return win;
}

function fixture(overrides = {}) {
  /** @type {any[]} */
  const created = [], loads = [], saved = [];
  const meeting = Object.assign(new EventEmitter(), { webContents: { mainFrame: {}, isDestroyed: () => false }, isDestroyed: () => false });
  let meetingOpen = true;
  const main = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { mainFrame: {} }), isDestroyed: () => false });
  const store = {
    open: async (meetingId) => ({ whiteboardId: `wb_${meetingId}`, scene: null }),
    save: async (...args) => { saved.push(args); },
  };
  /** @type {any} */
  const BrowserWindow = function (options) { const w = /** @type {any} */ (fakeWindow()); w.options = options; created.push(w); return w; };
  const board = createMeetingWhiteboardWindow({
    BrowserWindow, store, preloadPath: "/preload.mjs",
    loadPage: async (w) => { loads.push(w); },
    getMeetingWindow: () => (meetingOpen ? meeting : null), getMainWindow: () => main,
    ...overrides,
  });
  // Meeting UI is a portal of the main renderer: its IPC comes from the main window.
  const meetingEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  return { board, created, loads, saved, meeting, main, meetingEvent, closeMeeting: () => { meetingOpen = false; } };
}

test("only the main renderer can open the whiteboard, only during a meeting; context is bound to that meeting", async () => {
  const f = fixture();
  await assert.rejects(f.board.open({ sender: f.meeting.webContents, senderFrame: f.meeting.webContents.mainFrame }, { meetingId: "m1" }), /主窗口/);
  await assert.rejects(f.board.open({ sender: f.main.webContents, senderFrame: {} }, { meetingId: "m1" }), /主窗口/);
  const g = fixture(); g.closeMeeting();
  await assert.rejects(g.board.open(g.meetingEvent, { meetingId: "m1" }), /会议窗口已关闭/);
  await assert.rejects(f.board.open(f.meetingEvent, { meetingId: "../m1" }), /无效/);
  await f.board.open(f.meetingEvent, { meetingId: "m1", title: "周会", theme: "dark" });
  const win = f.created[0];
  assert.equal(win.options.webPreferences.preload, "/preload.mjs");
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.partition, "meeting-whiteboard");
  const ctx = f.board.context({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  assert.deepEqual(ctx, { meetingId: "m1", whiteboardId: "wb_m1", title: "周会", theme: "dark", scene: null });
  assert.throws(() => f.board.context(f.meetingEvent), /白板窗口/);
});

test("opening again focuses the existing window instead of creating another", async () => {
  const f = fixture();
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  assert.equal(f.created.length, 1);
  assert.ok(f.created[0].focusCount >= 2);
});

test("the window denies popups, navigation and every permission", async () => {
  const f = fixture();
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  const win = f.created[0];
  assert.deepEqual(win.handlers.open({ url: "https://example.com" }), { action: "deny" });
  let prevented = false;
  win.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "https://example.com");
  assert.equal(prevented, true);
  let granted;
  win.handlers.request(win.webContents, "media", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(win.handlers.check(win.webContents, "clipboard-read"), false);
});

test("save is only accepted from the whiteboard frame and for its own whiteboard", async () => {
  const f = fixture();
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  const win = f.created[0];
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  await f.board.save(event, "{}");
  assert.deepEqual(f.saved, [["m1", "wb_m1", "{}"]]);
  await assert.rejects(f.board.save(f.meetingEvent, "{}"), /白板窗口/);
  assert.throws(() => f.board.saveSync(f.meetingEvent, "{}"), /白板窗口/);
});

test("meeting window close, main navigation and explicit close all close the whiteboard", async () => {
  for (const trigger of ["meetingClosed", "mainNavigated", "explicit"]) {
    const f = fixture();
    await f.board.open(f.meetingEvent, { meetingId: "m1" });
    if (trigger === "meetingClosed") f.meeting.emit("closed");
    if (trigger === "mainNavigated") f.main.webContents.emit("did-start-navigation", {}, "x", false, true);
    if (trigger === "explicit") f.board.close(f.meetingEvent);
    assert.equal(f.created[0].isDestroyed(), true, trigger);
    assert.equal(f.board.window(), null, trigger);
  }
});

test("in-page hash navigation of the main window keeps the whiteboard open", async () => {
  const f = fixture();
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  f.main.webContents.emit("did-start-navigation", {}, "x#/a", true, true);
  assert.equal(f.created[0].isDestroyed(), false);
});

test("a different meeting replaces the old whiteboard window", async () => {
  const f = fixture();
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  await f.board.open(f.meetingEvent, { meetingId: "m2" });
  assert.equal(f.created.length, 2);
  assert.equal(f.created[0].isDestroyed(), true);
  assert.equal(f.board.window(), f.created[1]);
});

test("open resolves when navigation commits, before the page finishes loading", async () => {
  /** @type {any} */
  let finish;
  const f = fixture({ loadPage: (w) => { setImmediate(() => w.webContents.emit("did-navigate")); return new Promise((r) => { finish = r; }); } });
  await f.board.open(f.meetingEvent, { meetingId: "m1" });
  assert.equal(f.board.window(), f.created[0]);
  finish();
});

test("a failed page load closes the window and rejects open", async () => {
  const f = fixture({ loadPage: async () => { throw new Error("load failed"); } });
  await assert.rejects(f.board.open(f.meetingEvent, { meetingId: "m1" }), /load failed/);
  assert.equal(f.board.window(), null);
});

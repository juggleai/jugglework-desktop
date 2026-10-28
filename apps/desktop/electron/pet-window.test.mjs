import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopPet, petViewportBounds } from "./pet-window.mjs";

function fixture(loadPage = async () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "juggle-pet-test-"));
  const instances = [], handlers = new Map();
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) });
  let cursor = { x: 0, y: 0 };
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => display,
    getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => cursor,
  });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.bounds = options; this.webContents = Object.assign(new EventEmitter(), { send: () => {}, focus: () => {}, setZoomFactor: (value) => { this.zoomFactor = value; } }); instances.push(this); }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.resizes = (this.resizes ?? 0) + 1; this.bounds = bounds; }
    setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
    setAlwaysOnTop() {} showInactive() { this.shown = true; }
    setFocusable(value) { this.focusable = value; }
    focus() { this.focuses = (this.focuses ?? 0) + 1; this.focused = true; } isFocused() { return this.focused === true; } setIgnoreMouseEvents(value) { this.passthrough = value; }
  }
  const main = { shows: 0, focuses: 0, show() { this.shows += 1; }, focus() { this.focuses += 1; }, isDestroyed: () => false, webContents: { send() {} } };
  const pref = join(dir, "pet.json");
  const pet = createDesktopPet({ BrowserWindow: Window, screen, ipcMain, Menu: { buildFromTemplate: () => ({ popup() {} }) }, preferencesPath: pref, preloadPath: "/pet-preload", loadPage, getMainWindow: () => main });
  return { pet, screen, instances, ipcMain, handlers, main, pref, move: (point) => { cursor = point; }, cleanup: () => { pet.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("stable viewport spans work area height and clamps negative-origin displays", () => {
  const area = { x: -1100, y: 50, width: 1000, height: 800 };
  assert.deepEqual(petViewportBounds({ x: -800, y: 200 }, area), { x: -948, y: 50, width: 400, height: 800 });
  assert.deepEqual(petViewportBounds({ x: -9999, y: -9999 }, area), { x: -1100, y: 50, width: 400, height: 800 });
  assert.deepEqual(petViewportBounds({ x: 9999, y: 9999 }, area), { x: -500, y: 50, width: 400, height: 800 });
});

test("opening, folding and growing panels never resize the native canvas", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true); const win=f.instances[0], before={...win.getBounds()};
    const getViewport=f.handlers.get("jugglework:pet:viewport");
    const original=getViewport().character;
    for(const height of [200, 500, 320, 200, 650]) f.ipcMain.emit("jugglework:pet:layout", {sender:win.webContents}, {width:400,height,character:{x:148,y:28},regions:[]});
    assert.deepEqual(win.getBounds(), before); assert.equal(win.resizes ?? 0, 0);
    assert.deepEqual(getViewport().character, original);
    f.move({x:800,y:500});f.ipcMain.emit("jugglework:pet:drag",{sender:win.webContents},true);
    f.move({x:500,y:100});await new Promise(resolve=>setTimeout(resolve,45));
    assert.equal(win.getBounds().height,before.height); assert.equal(win.resizes ?? 0,0);
    assert.notDeepEqual(getViewport().character,original);
    f.ipcMain.emit("jugglework:pet:drag",{sender:win.webContents},false);
  } finally { f.cleanup(); }
});

test("rapid repeated show creates a unique passive transparent window", async () => {
  const f = fixture();
  try {
    await Promise.all([f.pet.setVisible(true), f.pet.setVisible(true)]);
    assert.equal(f.instances.length, 1); assert.equal(f.instances[0].options.transparent, true);
    assert.equal(f.instances[0].options.focusable, false); assert.equal(f.instances[0].options.parent, undefined);
    assert.equal(f.instances[0].options.webPreferences.partition, "desktop-pet");
    assert.equal(f.instances[0].zoomFactor, 1);
    assert.equal(JSON.parse(readFileSync(f.pref, "utf8")).enabled, true);
    await f.pet.setVisible(false); assert.equal(f.instances[0].destroyed, true);
    assert.equal(JSON.parse(readFileSync(f.pref, "utf8")).enabled, false);
    assert.equal(f.screen.listenerCount("display-removed"), 1);
  } finally { f.cleanup(); }
  assert.equal(f.screen.listenerCount("display-removed"), 0);
});

test("releasing a drag between pointer ticks applies and persists the final cursor position", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true);
    const win = f.instances[0], event = { sender: win.webContents };
    const viewport = f.handlers.get("jugglework:pet:viewport");
    const before = viewport();
    f.move({ x: 0, y: 0 }); f.ipcMain.emit("jugglework:pet:drag", event, true);
    f.move({ x: -100, y: -80 }); f.ipcMain.emit("jugglework:pet:drag", event, false);
    const after = viewport();
    assert.equal(after.screenX + after.character.x - before.screenX - before.character.x, -100);
    assert.equal(after.character.y - before.character.y, -80);
    assert.deepEqual(JSON.parse(readFileSync(f.pref, "utf8")).position, { x: after.screenX + after.character.x, y: after.workArea.y + after.character.y });
  } finally { f.cleanup(); }
});

test("show then hide during load cannot resurrect an old window; a later show works", async () => {
  /** @type {() => void} */
  let finish = () => { throw new Error("Window load has not started"); };
  const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
  try {
    const first = f.pet.setVisible(true);
    await f.pet.setVisible(false);
    const second = f.pet.setVisible(true);
    finish(); await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.instances.length, 2); assert.equal(f.instances[0].shown, undefined);
    finish(); assert.equal((await second).visible, true);
    assert.equal(f.instances[1].shown, true);
  } finally { f.cleanup(); }
});

test("layout accepts only current pet sender; host close preserves enabled preference", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true); const win = f.instances[0]; const original = win.getBounds();
    f.ipcMain.emit("jugglework:pet:layout", { sender: {} }, { width: 900, height: 900, regions: [] });
    assert.equal(win.getBounds(), original);
    f.pet.closeHost(); assert.equal(JSON.parse(readFileSync(f.pref, "utf8")).enabled, true);
    await f.pet.restore(); assert.equal(f.instances.length, 2);
    f.ipcMain.emit("jugglework:pet:keyboard", { sender: f.instances[1].webContents }, true);
    assert.equal(f.instances[1].focusable, true);
    assert.equal(f.pet.isKeyboardActive(), true);
    f.ipcMain.emit("jugglework:pet:keyboard", { sender: f.instances[1].webContents }, false);
    assert.equal(f.instances[1].focusable, false);
    assert.equal(f.pet.isKeyboardActive(), false);
  } finally { f.cleanup(); }
});

test("editor focus handoff activates the native window once before accepting text", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true);
    const win = f.instances[0], handoff = f.handlers.get("jugglework:pet:focus-editor");
    await handoff({ sender: {} });
    assert.equal(win.focusable, undefined);
    await handoff({ sender: win.webContents });
    await handoff({ sender: win.webContents });
    assert.equal(win.focusable, true);
    assert.equal(win.focuses, 1);
  } finally { f.cleanup(); }
});

test("successful navigation and character activation raise the main window; input controls stay silent", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true);
    const win = f.instances[0];
    f.ipcMain.emit("jugglework:pet:publish", { sender: f.main.webContents }, { contextKey: "test", ready: true });
    f.main.webContents.send = (channel, request) => {
      if (channel === "jugglework:pet:host-action") f.ipcMain.emit("jugglework:pet:host-reply", { sender: f.main.webContents }, { requestId: request.requestId, result: {} });
    };
    const act = f.handlers.get("jugglework:pet:action");
    for (const action of [{ type: "latest" }, { type: "send", target: {}, text: "follow-up" }, { type: "stop", key: "task" }]) await act({ sender: win.webContents }, action);
    assert.equal(f.main.shows, 0); assert.equal(f.main.focuses, 0);
    for (const action of [{ type: "open", key: "task" }, { type: "open-target", target: {} }, { type: "open-app" }]) await act({ sender: win.webContents }, action);
    assert.equal(f.main.shows, 3); assert.equal(f.main.focuses, 3);
    await act({ sender: win.webContents }, { type: "activate-app" });
    assert.equal(f.main.shows, 4); assert.equal(f.main.focuses, 4);
  } finally { f.cleanup(); }
});

test("failed navigation does not raise the main window", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true);
    f.ipcMain.emit("jugglework:pet:publish", { sender: f.main.webContents }, { contextKey: "test", ready: true });
    f.main.webContents.send = (channel, request) => {
      if (channel === "jugglework:pet:host-action") f.ipcMain.emit("jugglework:pet:host-reply", { sender: f.main.webContents }, { requestId: request.requestId, error: "目标项目不可用" });
    };
    await assert.rejects(f.handlers.get("jugglework:pet:action")({ sender: f.instances[0].webContents }, { type: "open", key: "task" }), /目标项目不可用/);
    assert.equal(f.main.shows, 0);
  } finally { f.cleanup(); }
});

test("account changes reject delayed interaction writes from the same pet window", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true);
    const interaction = { drafts: { __quick__: "旧账号草稿" }, selectedCapabilities: { __quick__: [{ id: "skill:old", group: "skills", kind: "skill", name: "Old skill" }] }, targets: {}, dismissed: {}, target: { key: "old:root" } };
    const remember = (contextKey) => f.ipcMain.emit("jugglework:pet:remember", { sender: f.instances[0].webContents }, { contextKey, interaction });
    const publish = (contextKey) => f.ipcMain.emit("jugglework:pet:publish", { sender: f.main.webContents }, { contextKey, ready: true });
    publish("old"); remember("old");
    assert.equal(f.handlers.get("jugglework:pet:state")().interaction.drafts.__quick__, "旧账号草稿");
    publish("new"); remember("old");
    assert.deepEqual(f.handlers.get("jugglework:pet:state")().interaction, { drafts: {}, targets: {}, dismissed: {}, target: null });
    remember("new");
    assert.equal(f.handlers.get("jugglework:pet:state")().interaction.drafts.__quick__, "旧账号草稿");
  } finally { f.cleanup(); }
});

test("Electron aborted load after hide does not break a subsequent show", async () => {
  const loads = [];
  const f = fixture(() => new Promise((resolve, reject) => loads.push({ resolve, reject })));
  try {
    const first = f.pet.setVisible(true); await f.pet.setVisible(false);
    const second = f.pet.setVisible(true); loads[0].reject(new Error("ERR_ABORTED")); await first;
    await new Promise((resolve) => setImmediate(resolve));
    loads[1].resolve(); assert.equal((await second).visible, true);
  } finally { f.cleanup(); }
});

test("transparent perimeter passes through while stable character regions accept input", async () => {
  const f = fixture();
  try {
    await f.pet.setVisible(true); const win = f.instances[0];
    assert.equal(win.passthrough, true);
    const bounds = win.getBounds(); f.move({ x: bounds.x + 280, y: bounds.y + 100 });
    await new Promise((resolve) => setTimeout(resolve, 70)); assert.equal(win.passthrough, false);
    f.move({ x: bounds.x + 20, y: bounds.y + 20 });
    await new Promise((resolve) => setTimeout(resolve, 70)); assert.equal(win.passthrough, true);
    f.ipcMain.emit("jugglework:pet:keyboard", { sender: win.webContents }, true); assert.equal(win.passthrough, true);
    f.ipcMain.emit("jugglework:pet:keyboard", { sender: win.webContents }, false); assert.equal(win.passthrough, true);
  } finally { f.cleanup(); }
});

/** 准备真实IPC入口的延迟发送，回执时机由用例控制。 */
async function submissionFixture() {
  const f = fixture();
  await f.pet.setVisible(true);
  const target = { key: "workspace:root", workspaceId: "workspace", sessionId: "root", project: "项目", title: "会话" };
  const getState = f.handlers.get("jugglework:pet:state");
  f.ipcMain.emit("jugglework:pet:publish", { sender: f.main.webContents }, { contextKey: "test", ready: true });
  const remember = (text, capabilities = []) => f.ipcMain.emit("jugglework:pet:remember", { sender: f.instances.at(-1).webContents }, { contextKey: "test", interaction: { drafts: { __quick__: text }, selectedCapabilities: { __quick__: capabilities }, targets: {}, dismissed: {}, target } });
  remember("本次发送");
  let request;
  f.main.webContents.send = (channel, value) => { if (channel === "jugglework:pet:host-action") request = value; };
  const send = (text = "本次发送", capabilities = []) => f.handlers.get("jugglework:pet:action")({ sender: f.instances.at(-1).webContents }, { type: "send", draftKey: "__quick__", target, text, capabilities });
  const reply = (value) => f.ipcMain.emit("jugglework:pet:host-reply", { sender: f.main.webContents }, { requestId: request.requestId, ...value });
  return { ...f, getState, remember, send, reply, target };
}

test("a hidden submission stays pending after reopening and clears its accepted draft", async () => {
  const f = await submissionFixture();
  try {
    const result = f.send();
    await f.pet.setVisible(false);
    await f.pet.setVisible(true);
    assert.deepEqual(f.getState().submitting, [f.target.key]);
    assert.throws(f.send, /尚未确认/);
    f.reply({ result: { delivery: "sent" } });
    assert.equal((await result).draftCleared, true);
    assert.equal(f.getState().interaction.drafts.__quick__, "");
    assert.deepEqual(f.getState().submitting, []);
  } finally { f.cleanup(); }
});

test("accepted submissions preserve newer draft text instead of clearing it", async () => {
  const f = await submissionFixture();
  try {
    const result = f.send();
    f.remember("请求期间继续编辑的文字");
    f.reply({ result: { delivery: "queued" } });
    assert.notEqual((await result).draftCleared, true);
    assert.equal(f.getState().interaction.drafts.__quick__, "请求期间继续编辑的文字");
  } finally { f.cleanup(); }
});

const selectedSkill = { id: "skill:guide", group: "skills", kind: "skill", name: "Guide" };
const selectedMcp = { id: "mcp:calendar", group: "mcp", kind: "mcp", name: "Calendar" };

for (const text of ["", "本次发送"]) test(`complete capability drafts survive hide/reopen and clear on hidden acceptance (${text || "capability-only"})`, async () => {
  const f = await submissionFixture();
  try {
    f.remember(text, [selectedSkill]);
    await f.pet.setVisible(false); await f.pet.setVisible(true);
    assert.deepEqual(f.getState().interaction.selectedCapabilities.__quick__, [selectedSkill]);
    assert.equal(f.getState().interaction.drafts.__quick__, text);
    assert.deepEqual(f.getState().interaction.target, f.target);
    const result = f.send(text, [selectedSkill]);
    await f.pet.setVisible(false);
    f.reply({ result: { delivery: "sent" } });
    assert.equal((await result).draftCleared, true);
    await f.pet.setVisible(true);
    assert.deepEqual(f.getState().interaction.selectedCapabilities.__quick__, []);
    assert.equal(f.getState().interaction.drafts.__quick__, "");
  } finally { f.cleanup(); }
});

for (const selection of [[], [selectedSkill, selectedMcp], [selectedMcp]]) test(`acceptance preserves changed capability selection: ${selection.map(item => item.id).join(",") || "removed"}`, async () => {
  const f = await submissionFixture();
  try {
    f.remember("本次发送", [selectedSkill]);
    const result = f.send("本次发送", [selectedSkill]);
    f.remember("本次发送", selection);
    await f.pet.setVisible(false);
    f.reply({ result: { delivery: "queued" } });
    assert.notEqual((await result).draftCleared, true);
    await f.pet.setVisible(true);
    assert.deepEqual(f.getState().interaction.selectedCapabilities.__quick__, selection);
    assert.equal(f.getState().interaction.drafts.__quick__, "本次发送");
  } finally { f.cleanup(); }
});

test("text-only acceptance preserves capabilities added during the pending send", async () => {
  const f = await submissionFixture();
  try {
    const result = f.send();
    f.remember("本次发送", [selectedSkill]);
    f.reply({ result: { delivery: "sent" } });
    assert.notEqual((await result).draftCleared, true);
    assert.deepEqual(f.getState().interaction.selectedCapabilities.__quick__, [selectedSkill]);
    assert.equal(f.getState().interaction.drafts.__quick__, "本次发送");
  } finally { f.cleanup(); }
});

test("acceptance clears only the submitted draft key's capabilities", async () => {
  const f = await submissionFixture();
  try {
    f.remember("本次发送", [selectedSkill]);
    const current = f.getState().interaction;
    f.ipcMain.emit("jugglework:pet:remember", { sender: f.instances.at(-1).webContents }, {
      contextKey: "test", interaction: { ...current, drafts: { ...current.drafts, other: "other draft" }, selectedCapabilities: { ...current.selectedCapabilities, other: [selectedMcp] } },
    });
    const result = f.send("本次发送", [selectedSkill]);
    f.reply({ result: { delivery: "sent" } });
    assert.equal((await result).draftCleared, true);
    assert.deepEqual(f.getState().interaction.selectedCapabilities, { __quick__: [], other: [selectedMcp] });
    assert.equal(f.getState().interaction.drafts.other, "other draft");
  } finally { f.cleanup(); }
});

test("hidden submissions keep unconfirmed results blocked on reopening", async () => {
  const f = await submissionFixture();
  try {
    const result = f.send();
    await f.pet.setVisible(false);
    f.reply({ error: "发送结果待确认，请先核对原任务" });
    await assert.rejects(result, /结果待确认/);
    await f.pet.setVisible(true);
    assert.equal(f.getState().interaction.uncertain[f.target.key], true);
    assert.equal(f.getState().interaction.drafts.__quick__, "本次发送");
    assert.throws(f.send, /尚未确认/);
  } finally { f.cleanup(); }
});

test("host reload preserves an unconfirmed draft even when the pet is hidden", async () => {
  const f = await submissionFixture();
  try {
    const result = f.send();
    await f.pet.setVisible(false);
    f.pet.resetHost();
    await assert.rejects(result, /结果待确认/);
    assert.equal(f.getState().interaction.uncertain[f.target.key], true);
    assert.equal(f.getState().interaction.drafts.__quick__, "本次发送");
    assert.deepEqual(f.getState().submitting, []);
  } finally { f.cleanup(); }
});

test("pending and unconfirmed submissions protect the same task across editor changes", async () => {
  const f = await submissionFixture();
  try {
    const event = { sender: f.instances.at(-1).webContents }, action = f.handlers.get("jugglework:pet:action");
    const fromCard = () => action(event, { type: "send", target: f.target, draftKey: f.target.key, text: "本次发送" });
    const result = f.send();
    assert.throws(fromCard, /尚未确认/);
    f.reply({ error: "发送结果待确认，请先打开原任务核对" });
    await assert.rejects(result, /待确认/);
    assert.throws(fromCard, /尚未确认/);
    // 旧页面的草稿快照不能覆盖原生回执刚记录的未知状态。
    f.remember("请求失败后的草稿");
    assert.equal(f.getState().interaction.uncertain[f.target.key], true);
    assert.throws(fromCard, /尚未确认/);
    await action(event, { type: "confirm-send", key: f.target.key });
    const retry = fromCard();
    f.reply({ result: { delivery: "sent" } });
    assert.equal((await retry).delivery, "sent");
  } finally { f.cleanup(); }
});

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMeetingAnnotationRouter } from "../../desktop/electron/meeting-annotation-router.mjs";
import { createMeetingSemanticAnnotation } from "../../desktop/electron/meeting-semantic-annotation.mjs";
import { createWindowsSemanticOverlay } from "../../desktop/electron/meeting-semantic-overlay-windows.mjs";
import { attachMeetingSemanticAnnotation } from "../src/react-app/domains/meeting/meeting-semantic-annotation-events";
import { createWindowAnnotationReceiver } from "../src/react-app/domains/meeting/window-annotation-events";

if (process.platform !== "win32") throw new Error("Windows smoke only");

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../desktop");
const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until<T>(read: () => T | undefined | false, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = read(); if (value) return value; await delay(10); }
  throw new Error("timeout");
}

type ProcessRecord = { role: string; child: ChildProcessWithoutNullStreams; lines: any[]; closed: boolean; code: number | null; forced: boolean };
const records: ProcessRecord[] = [];
function start(role: string, exe: string, args: string[]) {
  const child = spawn(exe, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: false });
  const record: ProcessRecord = { role, child, lines: [], closed: false, code: null, forced: false };
  records.push(record); child.stdin.on("error", () => {});
  createInterface({ input: child.stdout }).on("line", line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on("close", code => { record.closed = true; record.code = code; });
  return record;
}
async function ready(record: ProcessRecord) { return until(() => record.lines.find(line => line.type === "ready") || (record.closed && false)); }
async function command(record: ProcessRecord, action: string) {
  const mark = record.lines.length; record.child.stdin.write(`${action}\n`);
  return until(() => record.lines.slice(mark).find(line => line.type === "ack" && line.action === action));
}
function run(exe: string, args: string[]) {
  const result = spawnSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
  let value; try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!); } catch {}
  return { status: result.status, value, stdout: result.stdout, stderr: result.stderr };
}

class FakeWindow extends EventEmitter {
  destroyed = false; visible = false; contentProtected = false; bounds: any;
  webContents: any;
  constructor(public options: any) {
    super(); this.bounds = { ...options };
    const contents = Object.assign(new EventEmitter(), { mainFrame: {}, session: { setPermissionRequestHandler() {} },
      setWindowOpenHandler() {}, send: (_channel: string, _value: unknown) => {} });
    this.webContents = contents;
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.visible = false; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  getBounds() { return this.bounds; }
  setBounds(value: any) { this.bounds = value; }
  setContentProtection(value: boolean) { this.contentProtected = value; }
  setAlwaysOnTop() {}
}

const evidence: globalThis.Record<string, unknown> = {};
let failed: unknown, stage = "bootstrap";
try {
  const bootstrap = createWindowsSemanticOverlay({ desktopRoot, parentProcessStartedAt: "1" });
  const exe = bootstrap.helperPath;
  assert.equal(run(exe, ["layout"]).status, 0, "real helper layout");
  const parent = run(exe, ["process-fixture", String(process.pid)]).value;
  assert(parent?.started, "parent identity");

  let nativeChild: ChildProcessWithoutNullStreams | null = null;
  const adapter = createWindowsSemanticOverlay({ desktopRoot, parentProcessStartedAt: parent.started, timeoutMs: 3000,
    spawnHelper(helperPath, args, options) {
      assert.equal(helperPath, exe);
      const child = spawn(helperPath, args, options) as ChildProcessWithoutNullStreams;
      child.stdin.on("error", () => {});
      const record: ProcessRecord = { role: "helper", child, lines: [], closed: false, code: null, forced: false };
      child.on("close", code => { record.closed = true; record.code = code; }); records.push(record); nativeChild = child;
      return child;
    } });

  const eventTarget = new EventTarget() as EventTarget & { __JUGGLEWORK_ELECTRON__?: any };
  Object.assign(globalThis, { window: eventTarget, CustomEvent: globalThis.CustomEvent ?? class<T> extends Event { detail: T; constructor(type: string, init: { detail: T }) { super(type); this.detail = init.detail; } } });
  const media = { startShare: 1, publish: 1, stopShare: 0 };
  const compositor = { overlays: [] as unknown[], sizes: [] as unknown[], pending: [] as boolean[], paused: [] as boolean[],
    setOverlay(value: unknown) { this.overlays.push(value); }, confirmSize(width: number, height: number) { this.sizes.push({ width, height }); },
    setGeometryPending(value: boolean) { this.pending.push(value); }, setPaused(value: boolean) { this.paused.push(value); } };
  const closeReasons: string[] = [];
  const windowScenes: any[] = [];
  let semanticOpened: any = null;
  const receiveCompositor = createWindowAnnotationReceiver("capture", compositor, reason => { closeReasons.push(reason); if (reason === "target-closed") media.stopShare++; });
  eventTarget.addEventListener("jugglework:meeting:window-annotation", event => receiveCompositor((event as CustomEvent).detail));

  const main = new FakeWindow({});
  const mainEvent = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const ipcHandlers: globalThis.Record<string, Function> = {}, ipcListeners: globalThis.Record<string, Function> = {};
  const ipcMain = { handle(channel: string, fn: Function) { ipcHandlers[channel] = fn; }, on(channel: string, fn: Function) { ipcListeners[channel] = fn; } };
  const displays = [{ scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 }, workArea: { x: 0, y: 0, width: 1920, height: 1160 } }];
  let target: any = null;
  const samples: Function[] = [];
  const toolbars: FakeWindow[] = [];
  const semantic = createMeetingSemanticAnnotation({
    BrowserWindow: function (options: any) { const win = new FakeWindow(options); toolbars.push(win); return win; },
    screen: { getAllDisplays: () => displays }, ipcMain, preloadPath: "semantic-annotation-preload.cjs", loadPage: async () => {},
    getMainWindow: () => main, getMeetingWindow: () => null, getSharedWindow: () => target,
    watchWindow: (_target: unknown, callback: Function) => { samples.push(callback); return () => {}; },
    openNative: async (value: any) => await adapter.open(value), clearShared() {}, enabled: true,
  });
  const legacyCalls: string[] = [];
  const legacy = { state: () => ({ available: true }), open: async () => legacyCalls.push("open"), close: async () => legacyCalls.push("close"),
    windowShareReady: () => legacyCalls.push("ready"), write: async () => legacyCalls.push("write") };
  const router = createMeetingAnnotationRouter({ legacy, semantic });
  eventTarget.__JUGGLEWORK_ELECTRON__ = { invokeDesktop: async (name: string, input: unknown) => {
    assert.equal(name, "meetingSemanticAnnotationWrite"); return router.writeSemantic(mainEvent, input);
  } };
  const detachSemantic = attachMeetingSemanticAnnotation("capture");
  main.webContents.send = (channel: string, value: unknown) => {
    if (channel === "jugglework:meeting:semantic-annotation" && (value as any)?.kind === "opened") semanticOpened = value;
    if (channel === "jugglework:meeting:window-annotation" && (value as any)?.kind === "scene") windowScenes.push((value as any).scene);
    const domChannel = channel === "jugglework:meeting:semantic-annotation" ? "jugglework:meeting:semantic-annotation" : "jugglework:meeting:window-annotation";
    eventTarget.dispatchEvent(new CustomEvent(domChannel, { detail: value }));
  };

  async function makeTarget() {
    const fixture = start("target", exe, ["target", "100", "100", "640", "420"]);
    const id = await ready(fixture);
    // This fixed fixture's 640x420 outer frame has a 626x413 DWM capture frame.
    // The real helper independently rejects non-96-DPI or mismatched geometry.
    const frame = { dpi: 96, dwm: { x: 107, y: 100, width: 626, height: 413 } };
    target = { kind: "window", platform: "win32", captureId: "capture", sourceId: `window:${id.hwnd}:0`, windowId: id.hwnd,
      pid: Number(id.pid), processStartedAt: id.started };
    return { fixture, id, frame };
  }
  async function arm(value: Awaited<ReturnType<typeof makeTarget>>) {
    router.windowShareReady(mainEvent, { captureId: "capture", ready: true, pixelSize: value.frame.dwm });
    const readiness = samples.at(-1)!;
    readiness({ status: "visible", bounds: value.frame.dwm, actualSize: { width: value.frame.dwm.width, height: value.frame.dwm.height } });
    assert.equal(router.state(mainEvent).available, true);
  }
  async function open(value: Awaited<ReturnType<typeof makeTarget>>) {
    await arm(value); const before = toolbars.length; await router.open(mainEvent);
    await until(() => toolbars.length === before + 1 && toolbars.at(-1)!.visible);
    assert.equal(toolbars.at(-1)!.contentProtected, true); assert.equal(toolbars.at(-1)!.options.parent, undefined);
    assert.equal(toolbars.length, before + 1, "toolbar only");
    return { toolbar: toolbars.at(-1)!, helper: nativeChild! };
  }
  async function closeTarget(value: Awaited<ReturnType<typeof makeTarget>>) { if (!value.fixture.closed) { await command(value.fixture, "exit"); await until(() => value.fixture.closed); } }

  stage = "gates"; const gate = await makeTarget();
  displays.push({ ...displays[0] });
  router.windowShareReady(mainEvent, { captureId: "capture", ready: true, pixelSize: gate.frame.dwm });
  assert.equal(router.state(mainEvent).available, false, "single-screen gate"); displays.pop();
  displays[0].scaleFactor = 1.25; assert.equal(router.state(mainEvent).available, false, "DPI96 gate"); displays[0].scaleFactor = 1;
  await arm(gate); assert.deepEqual(router.state(mainEvent), { selected: true, available: true, active: false, preparing: false });
  assert.deepEqual(legacyCalls.filter(call => call !== "close"), [], "semantic flag selects only semantic backend");

  stage = "open"; const first = await open(gate);
  assert(await until(() => first.helper.pid && true), "real helper hello");
  const toolbarEvent = { sender: first.toolbar.webContents, senderFrame: first.toolbar.webContents.mainFrame };
  stage = "shape-native-ack";
  assert(semanticOpened, "semantic opened event");
  const shapeResult = await router.writeSemantic(mainEvent, { captureId: semanticOpened.captureId, annotationId: semanticOpened.annotationId,
    nativeSessionId: semanticOpened.nativeSessionId, generation: semanticOpened.generation, command: "apply-scene", sceneRevision: 1,
    scene: { size: { width: gate.frame.dwm.width, height: gate.frame.dwm.height }, elements: [{ type: "shape", id: "smoke_rectangle", kind: "rectangle", color: "#ef4444", size: 4,
      x1: .2, y1: .2, x2: .8, y2: .8 }], lasers: [] }, history: { canUndo: true, canClear: true } });
  assert.deepEqual(shapeResult, { ok: true }, "real native shape ACK");
  stage = "shape-compositor"; await until(() => compositor.overlays.some(Boolean));
  await delay(150);
  assert.equal(compositor.overlays.some(Boolean), true, "renderer scene reached compositor callback");
  const committedScene: any = compositor.overlays.find(Boolean);
  assert.equal(typeof committedScene, "function", "native ACK publishes compositor callback");

  stage = "laser-fade";
  ipcListeners["jugglework:semantic-annotation:command"](toolbarEvent, { type: "tool", tool: { tool: "laser", color: "#ef4444", size: 4 } });
  await delay(150);
  const overlayProcess = run(exe, ["process-fixture", String(first.helper.pid)]).value;
  const laserProbe = run(exe, ["probe", "420", "300", "drag", "target", gate.id.hwnd, String(gate.id.pid), gate.id.started,
    "overlay", "hit", overlayProcess.pid, overlayProcess.started]);
  assert.equal(laserProbe.value?.role, "overlay");
  await until(() => windowScenes.some(scene => scene.lasers?.length > 0));
  await until(() => windowScenes.at(-1)?.lasers?.length === 0, 4000);

  ipcListeners["jugglework:semantic-annotation:command"](toolbarEvent, { type: "tool", tool: { tool: "pointer", color: "#ef4444", size: 4 } });
  await delay(150);
  const beforeClicks = (await command(gate.fixture, "query"), gate.fixture.lines.findLast(line => line.type === "counts").clicks);
  const pointer = run(exe, ["probe", "420", "300", "click", "target", gate.id.hwnd, String(gate.id.pid), gate.id.started]);
  await delay(100); await command(gate.fixture, "query");
  assert.equal(pointer.value?.role, "target"); assert.equal(gate.fixture.lines.findLast(line => line.type === "counts").clicks, beforeClicks + 1);

  stage = "occluder"; const occluder = start("occluder", exe, ["occluder-topmost", "260", "210", "220", "150", gate.id.hwnd, String(gate.id.pid), gate.id.started]);
  await ready(occluder);
  try { await until(() => compositor.pending.includes(true)); }
  catch { throw new Error(`occluder-timeout:${JSON.stringify({ pending: compositor.pending, toolbarVisible: first.toolbar.visible, state: router.state(mainEvent), closeReasons })}`); }
  await command(occluder, "exit"); await until(() => occluder.closed);
  try { await until(() => first.toolbar.visible); }
  catch { throw new Error(`occluder-restore-timeout:${JSON.stringify({ pending: compositor.pending, toolbarVisible: first.toolbar.visible, state: router.state(mainEvent), closeReasons })}`); }
  await router.close(mainEvent, {}); await closeTarget(gate);

  stage = "minimize"; const minimized = await makeTarget(); const minimizedSession = await open(minimized);
  await command(minimized.fixture, "minimize"); await until(() => compositor.paused.includes(true) && !minimizedSession.toolbar.visible);
  stage = "restore"; await command(minimized.fixture, "restore");
  try { await until(() => compositor.paused.includes(false) && minimizedSession.toolbar.visible); }
  catch { throw new Error(`restore-timeout:${JSON.stringify({ paused: compositor.paused, visible: minimizedSession.toolbar.visible, state: router.state(mainEvent) })}`); }
  await router.close(mainEvent, {}); await closeTarget(minimized);

  stage = "resize"; const resized = await makeTarget(); const resizedSession = await open(resized);
  await delay(150);
  await command(resized.fixture, "resize");
  try { await until(() => closeReasons.includes("resized") && resizedSession.toolbar.destroyed); }
  catch { throw new Error(`resize-timeout:${JSON.stringify({ closeReasons, toolbarDestroyed: resizedSession.toolbar.destroyed, state: router.state(mainEvent) })}`); }
  assert.equal(media.stopShare, 0, "resize keeps share");
  await closeTarget(resized);

  stage = "target-close"; const targetClose = await makeTarget(); const targetCloseSession = await open(targetClose);
  await command(targetClose.fixture, "close"); await until(() => targetClose.fixture.closed && targetCloseSession.toolbar.destroyed);
  assert.equal(closeReasons.filter(reason => reason === "target-closed").length, 1); assert.equal(media.stopShare, 1);

  stage = "helper-crash"; const crash = await makeTarget(); const crashSession = await open(crash); crashSession.helper.kill();
  await until(() => crashSession.toolbar.destroyed && router.state(mainEvent).lastExitReason === "tracking-lost");
  assert.equal(media.stopShare, 1); await closeTarget(crash);

  stage = "manual-close"; const manual = await makeTarget(); const manualSession = await open(manual); await router.close(mainEvent, {});
  assert.equal(manualSession.toolbar.destroyed, true); assert.equal(media.stopShare, 1); await closeTarget(manual);

  stage = "rapid-reopen"; const rapid = await makeTarget(); const oldSession = await open(rapid);
  const oldOpened: any = { captureId: "capture", annotationId: "old", nativeSessionId: "old_session_123456", generation: 1, seq: 99,
    kind: "pointer", batch: { sessionId: "old_session_123456", epoch: 1, inputSeq: 1, phase: "down", points: [{ x: .1, y: .1 }] } };
  await router.close(mainEvent, {}); const newSession = await open(rapid); const overlayCount = compositor.overlays.length;
  eventTarget.dispatchEvent(new CustomEvent("jugglework:meeting:semantic-annotation", { detail: oldOpened }));
  eventTarget.dispatchEvent(new CustomEvent("jugglework:meeting:window-annotation", { detail: { captureId: "capture", annotationId: "retired", seq: 100, kind: "scene",
    scene: { size: rapid.frame.dwm, elements: [], lasers: [] } } }));
  await delay(50); assert.equal(compositor.overlays.length, overlayCount, "old messages isolated after rapid reopen");
  await router.close(mainEvent, {}); assert.equal(oldSession.toolbar.destroyed && newSession.toolbar.destroyed, true); await closeTarget(rapid);

  assert.deepEqual(media, { startShare: 1, publish: 1, stopShare: 1 }, "annotation never starts or republishes media");
  detachSemantic();
  evidence.result = "pass"; evidence.toolbars = toolbars.length; evidence.compositorCallbacks = compositor.overlays.length;
  evidence.laserPublished = windowScenes.some(scene => scene.lasers?.length > 0); evidence.compositorFinalLasers = windowScenes.at(-1)?.lasers?.length;
  evidence.closeReasons = closeReasons; evidence.media = media; evidence.legacyCalls = legacyCalls;
} catch (error) { failed = error; evidence.result = "fail"; evidence.stage = stage; evidence.reason = error instanceof Error ? error.message : String(error); }
finally {
  for (const record of records) if (!record.closed) { try { record.child.stdin.end("exit\n"); } catch {} }
  const end = Date.now() + 4000; while (records.some(record => !record.closed) && Date.now() < end) await delay(20);
  for (const record of records) if (!record.closed) { record.forced = true; record.child.kill(); }
  evidence.cleanup = { total: records.length, closed: records.filter(record => record.closed).length, forced: records.filter(record => record.forced).length };
  console.log(JSON.stringify(evidence));
}
if (failed || records.some(record => record.forced || !record.closed)) throw failed ?? new Error("cleanup failed");

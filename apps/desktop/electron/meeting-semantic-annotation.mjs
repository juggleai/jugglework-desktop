import { randomUUID } from 'node:crypto';

const initialState = () => ({ mode: 'pointer', tool: { tool: 'pointer', color: '#ef4444', size: 4 }, history: { canUndo: false, canClear: false },
  windowShare: true, capabilities: { backend: 'windows-semantic', selected: true, tools: ['pointer', 'laser', 'pen', 'highlighter', 'ellipse', 'rectangle', 'arrow', 'eraser'], history: ['undo', 'clear'] } });
const exactKey = (value, current) => value?.captureId === current.target.captureId && value.annotationId === current.annotationId &&
  value.nativeSessionId === current.native.sessionId && value.generation === current.generation;
const validSize = value => Number.isInteger(value?.width) && value.width > 0 && value.width <= 16384 && Number.isInteger(value?.height) && value.height > 0 && value.height <= 16384;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const normalized = value => Number.isFinite(value) && value >= 0 && value <= 1;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validStyle = value => /^#[0-9a-f]{6}$/i.test(value?.color) && Number.isFinite(value.size) && value.size > 0 && value.size <= 32;
const validElement = item => item?.type === 'stroke'
  ? exact(item, ['type', 'id', 'color', 'size', 'highlight', 'points']) && validId(item.id) && validStyle(item) && typeof item.highlight === 'boolean' &&
    Array.isArray(item.points) && item.points.length >= 4 && item.points.length <= 512 && item.points.length % 2 === 0 && item.points.every(normalized)
  : item?.type === 'shape' && exact(item, ['type', 'id', 'kind', 'color', 'size', 'x1', 'y1', 'x2', 'y2']) && validId(item.id) && validStyle(item) &&
    ['rectangle', 'ellipse', 'arrow'].includes(item.kind) && [item.x1, item.y1, item.x2, item.y2].every(normalized);
const validScene = scene => exact(scene, ['size', 'elements', 'lasers']) && exact(scene.size, ['width', 'height']) && validSize(scene.size) &&
  Array.isArray(scene.elements) && scene.elements.length <= 128 && Array.isArray(scene.lasers) && scene.lasers.length === 0 && scene.elements.every(validElement) &&
  new Set(scene.elements.map(item => item.id)).size === scene.elements.length &&
  scene.elements.reduce((total, item) => total + (item.type === 'stroke' ? item.points.length / 2 : 2), 0) <= 4096 &&
  Buffer.byteLength(JSON.stringify(scene), 'utf8') <= 65536;
const validLaser = item => exact(item, ['stroke', 'opacity']) && validElement(item.stroke) && item.stroke.type === 'stroke' && item.stroke.highlight === false &&
  Number.isFinite(item.opacity) && item.opacity >= 0 && item.opacity <= 1;
const validLasers = lasers => Array.isArray(lasers) && lasers.length <= 32 && lasers.every(validLaser) &&
  new Set(lasers.map(item => item.stroke.id)).size === lasers.length &&
  lasers.reduce((total, item) => total + item.stroke.points.length / 2, 0) <= 4096 && Buffer.byteLength(JSON.stringify(lasers), 'utf8') <= 65536;
const validTool = command => exact(command, ['type', 'tool']) && command.type === 'tool' && exact(command.tool, ['tool', 'color', 'size']) &&
  ['pointer', 'laser', 'pen', 'highlighter', 'rectangle', 'ellipse', 'arrow', 'eraser'].includes(command.tool.tool) && validStyle(command.tool);
const validMode = input => input?.command === 'mode' && (input.mode === 'pointer'
  ? exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command', 'mode'])
  : input.mode === 'draw' && exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command', 'mode', 'style']) &&
     exact(input.style, ['tool', 'color', 'size', 'highlight']) && ['laser', 'pen', 'highlighter', 'rectangle', 'ellipse', 'arrow', 'eraser'].includes(input.style.tool) &&
    validStyle(input.style) && typeof input.style.highlight === 'boolean' && input.style.highlight === (input.style.tool === 'highlighter'));

export const semanticToolbarWidth = toolCount => 16 + 20 + (toolCount * 30 + Math.max(0, toolCount - 1)) + 5 * 22 + 3 * 7 + 3 * 30 + 8 * 4;

export function createMeetingSemanticAnnotation({ BrowserWindow, screen, ipcMain, preloadPath, loadPage, getMainWindow, getMeetingWindow,
  getSharedWindow, watchWindow, openNative, clearShared, enabled }) {
  /** @type {{captureId: string, pixelSize: {width: number, height: number}, verified: boolean, actualSize?: {width: number, height: number}} | null} */
  let ready = null;
  let readinessStop = null, current = null, generation = 0, lastExitReason;
  const live = win => win && !win.isDestroyed();
  const mainEvent = (session, kind, data = {}) => {
    const main = getMainWindow();
    if (current !== session || !live(main)) return;
    main.webContents.send('jugglework:meeting:window-annotation', { captureId: session.target.captureId, annotationId: session.annotationId,
      seq: ++session.annotationSeq, kind, ...data });
  };
  const semanticEvent = (session, kind, data = {}) => {
    const main = getMainWindow();
    if (current !== session || !live(main)) return;
    main.webContents.send('jugglework:meeting:semantic-annotation', { captureId: session.target.captureId, annotationId: session.annotationId,
      nativeSessionId: session.native.sessionId, generation: session.generation, seq: ++session.nativeSeq, kind, ...data });
  };
  async function teardown(reason = 'manual', shareStopped = false) {
    readinessStop?.(); readinessStop = null;
    const session = current;
    if (reason !== 'manual') lastExitReason = reason;
    if (!session) { if (shareStopped) { ready = null; clearShared(); } return; }
    if (session.teardown) return session.teardown;
    session.teardown = (async () => {
    session.stop(); session.offInput(); session.offState(); session.offExit(); session.offLifecycle();
    mainEvent(session, 'closed', { reason });
    semanticEvent(session, 'closed', { reason });
    current = null;
    if (live(session.toolbar)) session.toolbar.destroy();
    await Promise.race([session.native.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    await session.native.dispose();
    if (shareStopped) { ready = null; clearShared(); }
    })();
    return session.teardown;
  }
  function assertMain(event) {
    const main = getMainWindow();
    if (!live(main) || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) throw new Error('仅主窗口可操作标注');
  }
  ipcMain.handle('jugglework:semantic-annotation:init', event => {
    if (!current || event.sender !== current.toolbar.webContents || event.senderFrame !== current.toolbar.webContents.mainFrame) throw new Error('标注已结束');
    return current.state;
  });
  ipcMain.on('jugglework:semantic-annotation:command', (event, command) => {
    const session = current;
    if (!session || event.sender !== session.toolbar.webContents || event.senderFrame !== session.toolbar.webContents.mainFrame) return;
    if (command?.type === 'exit') { void teardown(); return; }
    if (command?.type === 'move' && Number.isFinite(command.dx) && Number.isFinite(command.dy)) {
      const bounds = session.toolbar.getBounds(), area = session.display.bounds;
      session.toolbar.setBounds({ ...bounds, x: Math.round(Math.max(area.x, Math.min(bounds.x + command.dx, area.x + area.width - bounds.width))),
        y: Math.round(Math.max(area.y, Math.min(bounds.y + command.dy, area.y + area.height - bounds.height))) });
      return;
    }
    const exactHistory = command && typeof command === 'object' && Object.keys(command).length === 1 && ['undo', 'clear'].includes(command.type);
    if (validTool(command) || exactHistory) {
      if (command.type === 'tool') {
        session.state = { ...session.state, mode: command.tool.tool === 'pointer' ? 'pointer' : 'draw', tool: command.tool };
        session.toolbar.webContents.send('jugglework:semantic-annotation:state', session.state);
      }
      semanticEvent(session, 'toolbar', { command });
    }
  });
  return {
    state(event) {
      assertMain(event);
      const target = getSharedWindow?.(), displays = screen.getAllDisplays();
      const eligible = enabled && typeof watchWindow === 'function' && typeof openNative === 'function' && target?.platform === 'win32' && ready?.captureId === target.captureId && ready.verified && validSize(ready.pixelSize) &&
        displays.length === 1 && displays[0].scaleFactor === 1;
      const selected = enabled && target?.platform === 'win32';
      return { selected, available: Boolean(eligible), active: Boolean(current), preparing: Boolean(selected && !eligible && !current),
        ...(lastExitReason ? { lastExitReason } : {}) };
    },
    async open(event) {
      assertMain(event); lastExitReason = undefined;
      const target = getSharedWindow?.(), display = screen.getAllDisplays()[0];
      if (!enabled || typeof watchWindow !== 'function' || typeof openNative !== 'function' || target?.platform !== 'win32' || ready?.captureId !== target.captureId || !ready.verified || !validSize(ready.pixelSize) ||
          screen.getAllDisplays().length !== 1 || display?.scaleFactor !== 1) throw new Error('当前窗口不满足语义标注条件');
      if (current?.target.captureId === target.captureId) return;
      await teardown();
      const native = await openNative(target);
       if (!native || !await native.hello) {
         const detail = native?.getFailureReason?.();
         // Development-only backend diagnostics are deliberately finite and
         // identity-free so the launcher log can be inspected without window
         // titles, handles, process ids, or document content.
         console.warn('[meeting-semantic] open-refused', detail ?? 'hello-unconfirmed');
         await native?.dispose();
         throw new Error(`语义标注助手不可用，窗口共享仍在继续。${detail ? `（${detail}）` : ''}`);
       }
      const annotationId = randomUUID(), sessionGeneration = ++generation;
      const common = { show: false, frame: false, hasShadow: false, skipTaskbar: true, resizable: false, movable: false,
        minimizable: false, maximizable: false, fullscreenable: false, transparent: true, backgroundColor: '#00000000', focusable: true,
        webPreferences: { preload: preloadPath, partition: 'meeting-annotation', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } };
       const width = Math.min(semanticToolbarWidth(initialState().capabilities.tools.length), display.workArea.width);
      const toolbar = new BrowserWindow({ ...common, x: Math.round(display.workArea.x + (display.workArea.width - width) / 2), y: display.workArea.y + 12, width, height: 52 });
      toolbar.setContentProtection(true); toolbar.setAlwaysOnTop(true, 'screen-saver', 1);
      toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      toolbar.webContents.on('will-navigate', event => { event.preventDefault(); if (current?.toolbar === toolbar) void teardown('toolbar-gone'); });
      toolbar.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      const session = { target, display, native, toolbar, generation: sessionGeneration, annotationId, annotationSeq: 0, nativeSeq: 0,
        state: initialState(), initialSize: ready.actualSize, minimized: false, currentEpoch: 0, lastSceneRevision: 0, lastPreviewRevision: 0, lastLaserRevision: 0,
        committedScene: { size: ready.pixelSize, elements: [], lasers: [] }, currentLasers: [], sceneWrites: Promise.resolve(), laserWrites: Promise.resolve(), teardown: null,
        stop: () => {}, offInput: () => {}, offState: () => {}, offExit: () => {}, offLifecycle: () => {} };
      current = session;
      const lifecycle = () => { if (current === session) void teardown('toolbar-gone'); };
      const rendererGone = () => { if (current === session) void teardown('renderer-gone'); };
      const mainContents = getMainWindow()?.webContents;
      toolbar.once('closed', lifecycle); toolbar.webContents.once('render-process-gone', lifecycle);
      mainContents?.once('destroyed', rendererGone); mainContents?.once('render-process-gone', rendererGone);
      mainContents?.once('did-start-navigation', rendererGone);
      session.offLifecycle = () => {
        toolbar.removeListener('closed', lifecycle); toolbar.webContents.removeListener('render-process-gone', lifecycle);
        mainContents?.removeListener('destroyed', rendererGone); mainContents?.removeListener('render-process-gone', rendererGone);
        mainContents?.removeListener('did-start-navigation', rendererGone);
      };
      session.offInput = native.onInput(batch => { session.currentEpoch = Math.max(session.currentEpoch, batch.epoch); semanticEvent(session, 'pointer', { batch }); });
      session.offExit = native.onExit(() => { if (current === session) void teardown('tracking-lost'); });
      session.offState = native.onState(value => {
        if (current !== session) return;
        session.currentEpoch = Math.max(session.currentEpoch, value.epoch);
        semanticEvent(session, 'state', { state: value.state, epoch: value.epoch, input: value.input, visible: value.visible });
        if (value.state !== 'active') session.currentLasers = [];
        if (value.state === 'minimized') { session.minimized = true; toolbar.hide(); mainEvent(session, 'scene', { scene: session.committedScene, committed: false }); mainEvent(session, 'paused'); }
        else if (value.state === 'active') { if (session.minimized) mainEvent(session, 'resumed'); session.minimized = false; toolbar.showInactive(); }
        else if (value.state === 'unknown') { toolbar.hide(); mainEvent(session, 'scene', { scene: session.committedScene, committed: false }); mainEvent(session, 'geometry-pending'); }
        else if (value.state === 'resized') void teardown('resized');
        else if (value.state === 'closed') void teardown('target-closed');
        else if (value.state === 'unsupported-dpi') void teardown('unsupported-dpi');
      });
      session.stop = watchWindow(target, sample => {
        if (current !== session) return;
        if (sample.status === 'closed') { void teardown('target-closed'); return; }
        if (sample.status === 'unavailable') { void teardown('tracking-lost'); return; }
        if (sample.status === 'minimized' || sample.status === 'hidden' || sample.status === 'geometry-pending') return;
        if (sample.status === 'visible') {
          if (!session.initialSize) session.initialSize = sample.actualSize;
          else if (sample.actualSize.width !== session.initialSize.width || sample.actualSize.height !== session.initialSize.height) void teardown('resized');
        }
      });
      await loadPage(toolbar, 'toolbar');
      if (current !== session || !live(toolbar)) return;
      toolbar.showInactive();
      mainEvent(session, 'opened'); mainEvent(session, 'geometry', ready.pixelSize);
       semanticEvent(session, 'opened', { size: ready.pixelSize, capabilities: session.state.capabilities });
    },
    close(event, { shareStopped = false } = {}) { assertMain(event); return teardown('manual', shareStopped); },
    windowShareReady(event, input) {
      assertMain(event);
      if (getSharedWindow?.()?.captureId !== input.captureId) return;
      readinessStop?.(); readinessStop = null;
      ready = input.ready === true && validSize(input.pixelSize) ? { captureId: input.captureId, pixelSize: input.pixelSize, verified: false } : null;
      const target = getSharedWindow?.();
      if (ready && typeof watchWindow === 'function' && typeof openNative === 'function' && target?.platform === 'win32' && screen.getAllDisplays().length === 1 && screen.getAllDisplays()[0].scaleFactor === 1) {
        const candidate = ready;
        readinessStop = watchWindow(target, sample => {
          if (ready !== candidate) return;
          if (sample.status === 'visible') {
            // Capture output may be scaled independently from the physical DWM
            // frame. Both use normalized annotation coordinates; native owns
            // physical identity/geometry safety while pixelSize belongs only to
            // the compositor. Never hide the entry because the two resolutions
            // differ.
            candidate.verified = validSize(sample.bounds) && validSize(sample.actualSize);
            if (candidate.verified) candidate.actualSize = sample.actualSize;
            readinessStop?.(); readinessStop = null;
          } else if (sample.status === 'closed' || sample.status === 'unavailable') {
            ready = null; readinessStop?.(); readinessStop = null;
          }
        });
      }
      if (!ready && current?.target.captureId === input.captureId) void teardown();
    },
    async write(event, input) {
      assertMain(event);
      const session = current;
      if (!session || !exactKey(input, session)) return { ok: false, reason: 'stale-session' };
       if (input.command === 'mode' || input.command === 'abort') {
         if ((input.command === 'mode' && !validMode(input)) || (input.command === 'abort' && !exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command'])))
           return { ok: false, reason: 'invalid-command' };
         const result = input.command === 'abort' ? await session.native.abort() : input.mode === 'pointer' ? await session.native.setMode('pointer') : await session.native.setMode('draw', input.style);
          if (!result.ok && current === session) await teardown('native-write-failed');
          else if (current === session) mainEvent(session, 'scene', { scene: session.committedScene, committed: false });
          return result;
        }
       if (input.command === 'apply-preview') {
         if (!exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command', 'previewRevision', 'epoch', 'hiddenElementIds', 'scene']) ||
             !validScene(input.scene) || input.scene.size.width !== ready?.pixelSize.width || input.scene.size.height !== ready?.pixelSize.height ||
             !Number.isSafeInteger(input.previewRevision) || input.previewRevision <= session.lastPreviewRevision ||
             !Number.isSafeInteger(input.epoch) || input.epoch < 0 || input.epoch !== session.currentEpoch ||
             !Array.isArray(input.hiddenElementIds) || input.hiddenElementIds.length > 128 || input.hiddenElementIds.some(id => !validId(id)) ||
             new Set(input.hiddenElementIds).size !== input.hiddenElementIds.length)
           return { ok: false, reason: 'stale-preview' };
         const retainedIds = new Set(session.committedScene.elements.map(item => item.id));
         if (input.hiddenElementIds.some(id => !retainedIds.has(id)) || input.scene.elements.some(item => input.hiddenElementIds.includes(item.id)))
           return { ok: false, reason: 'invalid-preview' };
         session.lastPreviewRevision = input.previewRevision;
         const result = await session.native.setPreview({ previewRevision: input.previewRevision, epoch: input.epoch, hiddenElementIds: input.hiddenElementIds });
         if (current !== session) return { ok: false, reason: 'stale-session' };
         if (!result.ok) { if (result.reason !== 'wrong-epoch') await teardown('native-write-failed'); return { ok: false, reason: result.reason ?? 'native-write-failed' }; }
         mainEvent(session, 'scene', { scene: input.scene, previewRevision: input.previewRevision, committed: false });
         return { ok: true };
       }
       if (input.command === 'apply-lasers') {
         if (!exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command', 'laserRevision', 'epoch', 'lasers']) ||
             !Number.isSafeInteger(input.laserRevision) || input.laserRevision <= session.lastLaserRevision ||
             !Number.isSafeInteger(input.epoch) || input.epoch < 0 || input.epoch !== session.currentEpoch || !validLasers(input.lasers))
           return { ok: false, reason: 'stale-laser' };
         session.lastLaserRevision = input.laserRevision;
         const laserSession = session;
         const apply = async () => {
           if (current !== laserSession || input.epoch !== laserSession.currentEpoch) return { ok: false, reason: 'stale-session' };
           const nativeLasers = input.lasers.map(({ stroke, opacity }) => ({ opacity, stroke: { id: stroke.id, color: stroke.color, size: stroke.size,
             highlight: false, points: Array.from({ length: stroke.points.length / 2 }, (_, index) => [stroke.points[index * 2], stroke.points[index * 2 + 1]]) } }));
           const result = await laserSession.native.setLasers({ laserRevision: input.laserRevision, epoch: input.epoch, lasers: nativeLasers });
           if (current !== laserSession || input.epoch !== laserSession.currentEpoch) return { ok: false, reason: 'stale-session' };
           if (!result.ok) { if (!['wrong-epoch', 'stale-laser-revision'].includes(result.reason)) await teardown('native-write-failed'); return { ok: false, reason: result.reason ?? 'native-write-failed' }; }
           laserSession.currentLasers = input.lasers;
           mainEvent(laserSession, 'scene', { scene: { ...laserSession.committedScene, lasers: input.lasers }, laserRevision: input.laserRevision, committed: false });
           return { ok: true };
         };
         session.laserWrites = session.laserWrites.then(apply, apply);
         return session.laserWrites;
       }
       if (input.command === 'apply-scene') {
         if (!exact(input, ['captureId', 'annotationId', 'nativeSessionId', 'generation', 'command', 'sceneRevision', 'scene', 'history']) ||
             !validScene(input.scene) || input.scene.size.width !== ready?.pixelSize.width || input.scene.size.height !== ready?.pixelSize.height)
           return { ok: false, reason: 'invalid-scene' };
         if (!Number.isSafeInteger(input.sceneRevision) || input.sceneRevision <= session.lastSceneRevision ||
             !input.history || Object.keys(input.history).length !== 2 || typeof input.history.canUndo !== 'boolean' || typeof input.history.canClear !== 'boolean')
           return { ok: false, reason: 'stale-scene-revision' };
         session.lastSceneRevision = input.sceneRevision;
         const committedSession = session;
         const apply = async () => {
           if (current !== committedSession) return { ok: false, reason: 'stale-session' };
           const nativeScene = { elements: input.scene.elements.map(item => item.type === 'stroke'
             ? { type: 'stroke', id: item.id, color: item.color, size: item.size, highlight: item.highlight,
               points: Array.from({ length: item.points.length / 2 }, (_, index) => [item.points[index * 2], item.points[index * 2 + 1]]) }
             : { type: 'shape', id: item.id, kind: item.kind, color: item.color, size: item.size, x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 }) };
           let result = await committedSession.native.setScene(nativeScene);
           if (!result.ok && result.retryable === true && current === committedSession) result = await committedSession.native.setScene(nativeScene);
           if (current !== committedSession) return { ok: false, reason: 'stale-session' };
            if (!result.ok) { await teardown('native-write-failed'); return { ok: false, reason: result.reason ?? 'native-write-failed' }; }
            committedSession.committedScene = input.scene;
           committedSession.state = { ...committedSession.state, history: input.history };
           if (live(committedSession.toolbar)) committedSession.toolbar.webContents.send('jugglework:semantic-annotation:state', committedSession.state);
           mainEvent(committedSession, 'scene', { scene: input.scene, sceneRevision: input.sceneRevision });
           return { ok: true };
         };
         session.sceneWrites = session.sceneWrites.then(apply, apply);
         return session.sceneWrites;
      }
      return { ok: false, reason: 'invalid-command' };
    },
  };
}

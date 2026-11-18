import { isSafeWhiteboardSegment } from "./whiteboard-store.mjs";

const THEMES = new Set(["light", "dark"]);

/**
 * Owns the single meeting whiteboard window. The page is a dedicated renderer
 * entry (not a portal): Excalidraw binds drawing events to its own global
 * window/document, which a portal child window would route to the main window.
 */
export function createMeetingWhiteboardWindow({ BrowserWindow, store, preloadPath, loadPage, getMeetingWindow, getMainWindow }) {
  let win = null;
  let ctx = null;
  let opening = null;
  let detach = () => {};

  const live = () => (win && !win.isDestroyed() ? win : null);
  // The meeting UI is a portal of the main renderer, so its IPC arrives from
  // the main window; a live meeting window is still required.
  function assertMeeting(event) {
    const main = getMainWindow();
    const meeting = getMeetingWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw new Error("仅主窗口可操作会议白板");
    if (!meeting || meeting.isDestroyed()) throw new Error("会议窗口已关闭");
  }
  function assertWhiteboard(event) {
    const current = live();
    if (!current || event.sender !== current.webContents || event.senderFrame !== current.webContents.mainFrame)
      throw new Error("仅白板窗口可执行该操作");
  }
  function focus(target) {
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }
  function close() {
    const current = live();
    detach(); detach = () => {};
    win = null; ctx = null;
    current?.close();
  }

  async function create(meetingId, title, theme) {
    const opened = await store.open(meetingId);
    const next = new BrowserWindow({
      width: 1280, height: 820, minWidth: 720, minHeight: 480, show: false,
      title: title ? `白板 · ${title}` : "会议白板", autoHideMenuBar: true,
      backgroundColor: theme === "dark" ? "#121212" : "#ffffff",
      webPreferences: {
        preload: preloadPath, partition: "meeting-whiteboard",
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false, spellcheck: false,
      },
    });
    win = next;
    ctx = { meetingId, whiteboardId: opened.whiteboardId, title: title || "", theme, scene: opened.scene };
    next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    next.webContents.on("will-navigate", (event) => event.preventDefault());
    next.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    next.webContents.session.setPermissionCheckHandler(() => false);
    next.on("closed", () => { if (win === next) { detach(); detach = () => {}; win = null; ctx = null; } });
    next.webContents.on("render-process-gone", () => { if (win === next) close(); });

    const meeting = getMeetingWindow();
    const main = getMainWindow();
    const onMeetingClosed = () => close();
    const onMainNavigate = (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) close(); };
    meeting?.once("closed", onMeetingClosed);
    main?.webContents.on("did-start-navigation", onMainNavigate);
    main?.once("closed", onMeetingClosed);
    detach = () => {
      meeting?.removeListener("closed", onMeetingClosed);
      main?.webContents.removeListener("did-start-navigation", onMainNavigate);
      main?.removeListener("closed", onMeetingClosed);
    };

    // Return once the page navigation commits (its final main frame exists) so
    // the meeting window can still start capture within its user activation;
    // the rest of the page keeps loading in the background.
    const committed = new Promise((resolve) => next.webContents.once("did-navigate", resolve));
    const loading = loadPage(next).then(() => true, (error) => {
      if (win === next) close();
      throw error;
    });
    // A load failure before commit must reject open; after commit it closes the window.
    await Promise.race([committed, loading]);
    loading.catch(() => {});
    if (win !== next || next.isDestroyed()) throw new Error("白板窗口已关闭");
    focus(next);
  }

  return {
    window: live,
    async open(event, input) {
      assertMeeting(event);
      const meetingId = input?.meetingId;
      if (!isSafeWhiteboardSegment(meetingId)) throw new Error("会议标识无效");
      const title = typeof input?.title === "string" ? input.title.slice(0, 200) : "";
      const theme = THEMES.has(input?.theme) ? input.theme : "light";
      if (opening) await opening.catch(() => {});
      const current = live();
      if (current && ctx?.meetingId === meetingId) { focus(current); return { whiteboardId: ctx.whiteboardId }; }
      if (current) close();
      opening = create(meetingId, title, theme).finally(() => { opening = null; });
      await opening;
      return { whiteboardId: ctx.whiteboardId };
    },
    close(event) {
      assertMeeting(event);
      close();
    },
    context(event) {
      assertWhiteboard(event);
      return { ...ctx };
    },
    async save(event, content) {
      assertWhiteboard(event);
      await store.save(ctx.meetingId, ctx.whiteboardId, content);
    },
    saveSync(event, content) {
      assertWhiteboard(event);
      store.saveSync(ctx.meetingId, ctx.whiteboardId, content);
    },
    destroy: close,
  };
}

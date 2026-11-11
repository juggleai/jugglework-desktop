import { createHash, randomUUID } from "node:crypto";

// Own the pending Chromium request, not an independently armed source ID.
// Confirming a thumbnail resolves this exact request; closing never captures.
export function createMeetingScreenPicker({ desktopCapturer, getMainWindow, getMeetingWindow, timeoutMs = 120_000 }) {
  let pending = null;
  function notify(channel, requestId) {
    const main = getMainWindow();
    if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) main.webContents.send(channel, { requestId });
  }
  function finish(current, source = null) {
    if (pending !== current) return;
    pending = null;
    clearTimeout(current.timer);
    current.owner.removeListener("closed", current.cancel);
    current.owner.webContents.removeListener("render-process-gone", current.cancel);
    current.main.webContents.removeListener("did-start-navigation", current.cancel);
    current.main.webContents.removeListener("render-process-gone", current.cancel);
    current.main.removeListener("closed", current.cancel);
    notify("jugglework:meeting:screen-picker-closed", current.id);
    try { current.callback(source ? { video: source } : null); }
    catch { /* The requesting frame may already have been destroyed. */ }
  }
  function assertCaller(event) {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw new Error("仅主窗口可操作共享选择器");
  }
  function currentRequest(event, requestId) {
    assertCaller(event);
    if (!pending || pending.id !== requestId || pending.owner.isDestroyed()
      || pending.frame !== pending.owner.webContents.mainFrame) throw new Error("共享选择已失效，请重新点击共享屏幕。");
    return pending;
  }
  return {
    handle(request, callback) {
      const main = getMainWindow();
      const owner = [main, getMeetingWindow()].find(w => w && !w.isDestroyed() && request.frame === w.webContents.mainFrame);
      if (!owner || !main || !request.userGesture || pending) { callback(null); return; }
      const current = { id: randomUUID(), owner, main, frame: request.frame, callback, allowed: new Set(), selecting: false, timer: null, cancel: null };
      current.cancel = () => finish(current);
      pending = current;
      current.timer = setTimeout(current.cancel, timeoutMs);
      owner.once("closed", current.cancel);
      owner.webContents.once("render-process-gone", current.cancel);
      main.webContents.once("did-start-navigation", current.cancel);
      if (main !== owner) {
        main.webContents.once("render-process-gone", current.cancel);
        main.once("closed", current.cancel);
      }
      notify("jugglework:meeting:screen-picker", current.id);
    },
    /** @returns {Promise<import("@jugglework/types/desktop-ipc").MeetingScreenSource[]>} */
    async list(event, requestId) {
      const current = currentRequest(event, requestId);
      let sources;
      try {
        sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: true });
      } catch {
        throw new Error("无法获取共享画面。请检查系统屏幕录制权限，开启后重新启动应用。");
      }
      if (pending !== current) throw new Error("共享选择已关闭。");
      current.allowed = new Set(sources.map(s => s.id));
      let screenIndex = 0;
      return [...sources].sort((a, b) => Number(b.id.startsWith("screen:")) - Number(a.id.startsWith("screen:"))).map(source => {
        const kind = source.id.startsWith("screen:") ? "screen" : "window";
        const appIcon = kind === "window" && source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL({ scaleFactor: Math.max(1, ...(source.appIcon.getScaleFactors?.() || [1])) }) : "";
        return { id: source.id, kind, name: kind === "screen" ? `桌面 ${++screenIndex}` : source.name,
          thumbnail: source.thumbnail?.isEmpty() === false ? source.thumbnail.toDataURL() : "",
          appIcon, appKey: appIcon ? createHash("sha256").update(appIcon).digest("hex").slice(0, 16) : "" };
      });
    },
    async choose(event, requestId, sourceId) {
      const current = currentRequest(event, requestId);
      if (sourceId === null) { finish(current); return true; }
      if (current.selecting) return false;
      if (!current.allowed.has(sourceId)) throw new Error("请选择列表中的屏幕或窗口。");
      current.selecting = true;
      try {
        // Recheck availability rather than reusing a thumbnail's stale source.
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        if (pending !== current) return false;
        const source = sources.find(s => s.id === sourceId);
        if (!source) throw new Error("所选窗口已关闭，请刷新列表后重新选择。");
        if (current.owner.isDestroyed() || current.frame !== current.owner.webContents.mainFrame) { finish(current); return false; }
        finish(current, source);
        return true;
      } finally { current.selecting = false; }
    },
  };
}

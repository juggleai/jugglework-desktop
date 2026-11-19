import { writeFile } from "node:fs/promises";

// PNG data arrives as base64 (no binary IPC); source files are Excalidraw JSON.
const EXPORTS = {
  png: { name: "PNG 图片", extensions: ["png"], decode: (data) => Buffer.from(data, "base64") },
  excalidraw: { name: "Excalidraw 文件", extensions: ["excalidraw"], decode: (data) => data },
};
const MAX_EXPORT_BYTES = 60 * 1024 * 1024;

/**
 * Whiteboard commands for the meeting UI. The meeting window is a portal of the
 * main renderer, so every call must come from the main window's main frame.
 * @param {{ store: Pick<ReturnType<typeof import("./whiteboard-store.mjs").createWhiteboardStore>, "open" | "save">, dialog: any,
 *   getMainWindow: () => any, getMeetingWindow: () => any, write?: typeof writeFile }} options
 */
export function createWhiteboardCommands({ store, dialog, getMainWindow, getMeetingWindow, write = writeFile }) {
  function assertCaller(event) {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw new Error("仅会议窗口可操作白板");
  }
  return {
    /** @returns {Promise<{ whiteboardId: string, scene: string | null }>} */
    async open(event, input) {
      assertCaller(event);
      return store.open(input?.meetingId);
    },
    async save(event, input) {
      assertCaller(event);
      await store.save(input?.meetingId, input?.whiteboardId, input?.content);
    },
    /** @returns {Promise<{ saved: boolean }>} */
    async exportFile(event, input) {
      assertCaller(event);
      const kind = input?.kind, data = input?.data;
      const format = typeof kind === "string" && Object.hasOwn(EXPORTS, kind) ? EXPORTS[kind] : null;
      if (!format || typeof data !== "string" || data.length > MAX_EXPORT_BYTES) throw new Error("导出内容无效");
      const title = typeof input?.title === "string" ? input.title : "";
      const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "会议白板";
      const meeting = getMeetingWindow();
      const options = {
        title: "导出白板",
        defaultPath: `${base}.${format.extensions[0]}`,
        filters: [{ name: format.name, extensions: format.extensions }],
      };
      const result = meeting && !meeting.isDestroyed() ? await dialog.showSaveDialog(meeting, options) : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return { saved: false };
      await write(result.filePath, format.decode(data));
      return { saved: true };
    },
  };
}

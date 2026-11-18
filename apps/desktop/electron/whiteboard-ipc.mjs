import { writeFile } from "node:fs/promises";

// PNG data arrives as base64 (no binary IPC); source files are Excalidraw JSON.
const EXPORTS = {
  png: { name: "PNG 图片", extensions: ["png"], decode: (data) => Buffer.from(data, "base64") },
  excalidraw: { name: "Excalidraw 文件", extensions: ["excalidraw"], decode: (data) => data },
};
const MAX_EXPORT_BYTES = 60 * 1024 * 1024;

export function registerWhiteboardIpc({ ipcMain, dialog, whiteboard, write = writeFile }) {
  ipcMain.handle("jugglework:whiteboard:context", (event) => whiteboard.context(event));
  ipcMain.handle("jugglework:whiteboard:save", (event, content) => whiteboard.save(event, content));
  // pagehide cannot await async IPC; returnValue must be set before returning.
  ipcMain.on("jugglework:whiteboard:save-sync", (event, content) => {
    try { whiteboard.saveSync(event, content); event.returnValue = true; }
    catch { event.returnValue = false; }
  });
  ipcMain.handle("jugglework:whiteboard:export", async (event, kind, data) => {
    const ctx = whiteboard.context(event);
    const format = Object.hasOwn(EXPORTS, kind) ? EXPORTS[kind] : null;
    if (!format || typeof data !== "string" || data.length > MAX_EXPORT_BYTES) throw new Error("导出内容无效");
    const base = (ctx.title || "会议白板").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "会议白板";
    const result = await dialog.showSaveDialog(whiteboard.window(), {
      title: "导出白板",
      defaultPath: `${base}.${format.extensions[0]}`,
      filters: [{ name: format.name, extensions: format.extensions }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await write(result.filePath, format.decode(data));
    return { saved: true };
  });
}

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { app, dialog, shell } from "electron";

const formats = {
  pdf: { name: "PDF", mime: "application/pdf" },
  docx: { name: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
};

/** 为受管导出打开系统保存窗口，并在下载完成后签发当前原生页的文件定位凭据。 */
export function createCloudDocsExports() {
  const activeWindows = new WeakSet();
  const savedFiles = new WeakMap();

  return {
    /**
     * @param item 当前已授权的前台 Docs 视图
     * @param input 视图内生成的文件
     * @param isCurrent 文件是否仍属于当前页
     */
    async save(item, input, isCurrent) {
      const format = input?.format;
      if (
        (format !== "pdf" && format !== "docx") ||
        typeof input?.blobUrl !== "string" ||
        !input.blobUrl.startsWith(`blob:${item.origin}/`) ||
        !/^[0-9a-f-]{36}$/i.test(input.blobUrl.slice(item.origin.length + 6)) ||
        typeof input.fileName !== "string"
      ) throw new Error("docs_export_invalid");

      const win = item.ownerWindow;
      if (activeWindows.has(win)) return { status: "cancelled" };
      activeWindows.add(win);
      try {
        const contents = item.view.webContents;
        const route = contents.getURL();
        const name = input.fileName.replace(/\.[^.]+$/, "")
          .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_").trim().slice(0, 120);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          defaultPath: path.join(app.getPath("downloads"), `${name || "Untitled"}.${format}`),
          filters: [{ name: formats[format].name, extensions: [format] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        if (canceled || !filePath || !isCurrent() || contents.getURL() !== route)
          return { status: "cancelled" };

        // TIPS: 只接管本次同源 Blob，Electron 直写文件，不在 IPC 中传文件内容。
        const completed = await new Promise((resolve, reject) => {
          const nativeSession = item.nativeSession;
          const cleanup = () => {
            clearTimeout(timer);
            nativeSession.removeListener("will-download", onDownload);
          };
          const onDownload = (event, download, source) => {
            if (source !== contents || download.getURL() !== input.blobUrl) return;
            cleanup();
            if (!isCurrent() || contents.getURL() !== route) {
              event.preventDefault();
              resolve(null);
              return;
            }
            if (download.getMimeType() !== formats[format].mime) {
              event.preventDefault();
              reject(new Error("docs_export_invalid"));
              return;
            }
            download.once("done", (_event, state) => {
              if (state === "cancelled") resolve(null);
              else if (state === "completed" && download.getReceivedBytes() > 0) resolve(download.getSavePath());
              else reject(new Error("docs_export_save_failed"));
            });
            try {
              download.setSavePath(filePath);
            } catch (error) {
              event.preventDefault();
              reject(error);
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("docs_export_start_failed"));
          }, 10_000);
          nativeSession.on("will-download", onDownload);
          try {
            contents.downloadURL(input.blobUrl);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
        if (!completed || !isCurrent() || contents.getURL() !== route)
          return { status: "cancelled" };

        const revealId = randomUUID();
        const files = savedFiles.get(item) ?? new Map();
        if (files.size >= 8) files.delete(files.keys().next().value);
        files.set(revealId, completed);
        savedFiles.set(item, files);
        return { status: "saved", fileName: path.basename(completed), revealId };
      } finally {
        activeWindows.delete(win);
      }
    },

    /** 只定位由同一 Docs 视图刚刚保存的文件，页面不接触磁盘路径。 */
    async reveal(item, revealId, isCurrent) {
      const file = savedFiles.get(item)?.get(revealId);
      if (!file || !(await stat(file)).isFile() || !isCurrent())
        throw new Error("docs_export_file_unavailable");
      shell.showItemInFolder(file);
    },
  };
}

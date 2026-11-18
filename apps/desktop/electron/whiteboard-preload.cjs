const { contextBridge, ipcRenderer } = require("electron");

// The whiteboard page only reads its meeting context, saves its own scene and
// exports files through native dialogs. No general desktop IPC is exposed.
contextBridge.exposeInMainWorld("__JUGGLEWORK_WHITEBOARD__", {
  getContext: () => ipcRenderer.invoke("jugglework:whiteboard:context"),
  save: (content) => ipcRenderer.invoke("jugglework:whiteboard:save", content),
  // Synchronous variant for pagehide, when async IPC may not complete.
  saveNow: (content) => ipcRenderer.sendSync("jugglework:whiteboard:save-sync", content),
  exportFile: (kind, data) => ipcRenderer.invoke("jugglework:whiteboard:export", kind, data),
});

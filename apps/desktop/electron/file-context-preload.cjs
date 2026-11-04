const { contextBridge, ipcRenderer } = require("electron");

// TIPS: 初始化页与主窗口使用同一存储，但只开放初始化所需的只读请求及非凭据结果。
contextBridge.exposeInMainWorld("__JUGGLEWORK_ELECTRON__", {
  invokeDesktop: (command, ...args) => ipcRenderer.invoke("jugglework:file-context:request", command, ...args),
});
contextBridge.exposeInMainWorld("__JUGGLEWORK_FILE_CONTEXT__", {
  complete: (result) => ipcRenderer.invoke("jugglework:file-context:complete", result),
});

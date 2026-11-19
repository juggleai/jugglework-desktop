const { contextBridge, ipcRenderer } = require("electron");

// Narrow bridge for the annotation canvas and toolbar pages only.
contextBridge.exposeInMainWorld("__JUGGLEWORK_ANNOTATION__", {
  init: () => ipcRenderer.invoke("jugglework:annotation:init"),
  onState(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("jugglework:annotation:state", listener);
    return () => ipcRenderer.removeListener("jugglework:annotation:state", listener);
  },
  onAction(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("jugglework:annotation:action", listener);
    return () => ipcRenderer.removeListener("jugglework:annotation:action", listener);
  },
  command: (command) => ipcRenderer.send("jugglework:annotation:command", command),
  history: (history) => ipcRenderer.send("jugglework:annotation:history", history),
});

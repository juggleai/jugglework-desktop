import { contextBridge, ipcRenderer } from "electron";

/** 订阅宠物专用事件，页面卸载时由调用方释放。 */
function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("__JUGGLEWORK_PET__", {
  getViewport: () => ipcRenderer.invoke("jugglework:pet:viewport"),
  onViewport: (callback) => subscribe("jugglework:pet:viewport-changed", callback),
  getState: () => ipcRenderer.invoke("jugglework:pet:state"),
  onState: (callback) => subscribe("jugglework:pet:state-changed", callback),
  action: (action) => ipcRenderer.invoke("jugglework:pet:action", action),
  layout: (layout) => ipcRenderer.send("jugglework:pet:layout", layout),
  keyboard: (active) => ipcRenderer.send("jugglework:pet:keyboard", active),
  drag: (active) => ipcRenderer.send("jugglework:pet:drag", active),
  remember: (value, contextKey) => ipcRenderer.send("jugglework:pet:remember", { interaction: value, contextKey }),
  hide: () => ipcRenderer.invoke("jugglework:pet:visible", false),
  onFocus: (callback) => subscribe("jugglework:pet:focus-controls", callback),
});

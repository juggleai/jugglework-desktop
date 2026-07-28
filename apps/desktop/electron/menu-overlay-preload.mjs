import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("jugglework:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

contextBridge.exposeInMainWorld("__JUGGLEWORK_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("jugglework:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("jugglework:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("jugglework:menu-overlay:close", { requestId });
  },
});

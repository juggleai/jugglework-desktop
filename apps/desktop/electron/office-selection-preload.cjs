const { contextBridge, ipcRenderer } = require("electron");

// TIPS: 编辑页只获得冻结、添加/发送和取消能力；身份由实际 IPC sender 决定。
contextBridge.exposeInMainWorld("juggleworkOfficeSelection", {
  async capture(captureId, expectedSelection) {
    const result = await ipcRenderer.invoke("jugglework:office:selection-capture", { captureId, expectedSelection });
    if (result.error) throw new Error(result.error.message);
    return result;
  },
  submit(input) { return ipcRenderer.invoke("jugglework:office:selection-submit", input); },
  cancel(captureId) { return ipcRenderer.invoke("jugglework:office:selection-cancel", { captureId }); },
  // 只读通知；回调不能向 main 确认核对或调用任意命令。
  onReview(callback) {
    if (typeof callback !== "function") return;
    const listener = (_event, value) => {
      if (typeof value?.captureId === "string" && typeof value.pending === "boolean")
        callback({ captureId: value.captureId, pending: value.pending });
    };
    ipcRenderer.on("jugglework:office:selection-review-pending", listener);
    return () => ipcRenderer.removeListener("jugglework:office:selection-review-pending", listener);
  },
});

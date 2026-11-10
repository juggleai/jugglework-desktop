const { contextBridge, ipcRenderer } = require("electron");

// TIPS: Word 页面只上报固定对象事件；文件、组织、页面及关联身份均由主进程持有。
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== "jugglework-office-word-cloud"
  )
    return;
  const message = event.data.message;
  if (
    !/^[a-f0-9-]{36}$/i.test(message?.bridgeId ?? "") ||
    !["word.changed", "word.structure", "word.paused"].includes(message?.type)
  )
    return;
  try {
    if (JSON.stringify(message).length > 1024 * 1024) return;
  } catch {
    return;
  }
  ipcRenderer.send("jugglework:office:word-cloud-event", message);
});

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

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
});

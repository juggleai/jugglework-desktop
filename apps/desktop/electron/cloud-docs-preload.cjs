const { ipcRenderer, contextBridge } = require("electron");

// TIPS: 只声明原生展示环境，不向远端页面开放宿主方法。
contextBridge.exposeInMainWorld("juggleworkDocsDesktop", true);
ipcRenderer.on("jugglework:docs:layout-command", (_event, message) => {
  window.postMessage({ channel: "jugglework-docs-layout-command", message }, location.origin);
});

// TIPS: 原生宿主到页面只允许外观消息，不开放通用 IPC 调用。
ipcRenderer.on("jugglework:docs:appearance", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-appearance", message },
    location.origin,
  );
});

// TIPS: 编辑桥只转发固定业务消息，实际文件、账号与视图身份由主进程关联，不接受页面选择。
ipcRenderer.on("jugglework:docs:editor-command", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-editor-command", message },
    location.origin,
  );
});

// TIPS: 产品页只接收已保存的 Word 原件和基础对象，文件路径和源登录令牌不进入远程页面。
ipcRenderer.on("jugglework:docs:word-intake-command", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-word-intake-command", message },
    location.origin,
  );
});
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== "jugglework-docs-word-intake"
  )
    return;
  const message = event.data.message;
  if (
    !/^[a-f0-9-]{36}$/i.test(message?.requestId ?? "") ||
    !/^[a-f0-9-]{36}$/i.test(message?.instanceId ?? "")
  )
    return;
  try {
    if (JSON.stringify(message).length > 1024 * 1024) return;
  } catch {
    return;
  }
  ipcRenderer.send("jugglework:docs:word-intake", message);
});
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== "jugglework-docs-editor"
  )
    return;
  const message = event.data.message;
  if (
    ![
      "editor.ready",
      "editor.response",
      "editor.pending",
      "editor.structure",
      "editor.paused",
    ].includes(message?.type)
  )
    return;
  try {
    if (JSON.stringify(message).length > 1024 * 1024) return;
  } catch {
    return;
  }
  ipcRenderer.send("jugglework:docs:editor-message", message);
});

// TIPS: 远程页面只上报状态，不暴露 Node、文件系统或任意宿主调用。
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin)
    return;
  const envelope = event.data;
  if (envelope?.channel !== "jugglework-docs-host") return;
  const message = envelope.message;
  if (
    !["docs.ready", "docs.error", "docs.session-expired", "docs.layout"].includes(
      message?.type,
    )
  )
    return;
  ipcRenderer.send("jugglework:docs:message", {
    type: message.type,
    contractVersion: message.contractVersion,
    instanceId: message.instanceId,
    tenantId: message.tenantId,
    workspaceId: message.workspaceId,
    ...(message.type === "docs.layout" ? { layout: message.layout } : {}),
  });
});

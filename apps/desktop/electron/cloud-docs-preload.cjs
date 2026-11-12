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

// TIPS: 产品页只接收已保存的文件内容，文件路径和源登录令牌不进入远程页面。
ipcRenderer.on("jugglework:docs:file-intake-command", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-file-intake-command", message },
    location.origin,
  );
});
ipcRenderer.on("jugglework:docs:api-command", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-api-command", message },
    location.origin,
  );
});
ipcRenderer.on("jugglework:docs:highlight-blocks", (_event, message) => {
  window.postMessage(
    { channel: "jugglework-docs-highlight-command", message },
    location.origin,
  );
});
window.addEventListener("message", (event) => {
  if (
    event.source !== window ||
    event.origin !== location.origin ||
    event.data?.channel !== "jugglework-docs-file-intake"
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
  ipcRenderer.send("jugglework:docs:file-intake", message);
});

// TIPS: 远程页面只上报状态，不暴露 Node、文件系统或任意宿主调用。
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin)
    return;
  const envelope = event.data;
  if (envelope?.channel !== "jugglework-docs-host") return;
  const message = envelope.message;
  if (
    ![
      "docs.ready",
      "docs.error",
      "docs.session-expired",
      "docs.layout",
      "docs.open-attachment",
      "docs.ai-reference",
    ].includes(message?.type)
  )
    return;
  ipcRenderer.send("jugglework:docs:message", {
    type: message.type,
    contractVersion: message.contractVersion,
    instanceId: message.instanceId,
    tenantId: message.tenantId,
    workspaceId: message.workspaceId,
    ...(typeof message.reason === "string" && message.reason.length < 64 ? { reason: message.reason } : {}),
    ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}),
    ...(message.type === "docs.layout" ? { layout: message.layout } : {}),
    ...(message.type === "docs.open-attachment"
      ? { docId: message.docId, blobId: message.blobId, name: message.name, mimeType: message.mimeType, size: message.size }
      : {}),
    ...(message.type === "docs.ai-reference"
      ? { docId: message.docId, title: message.title, action: message.action, blockIds: message.blockIds }
      : {}),
  });
});

// 关闭前仅请求原生本地持久化状态，不允许执行任意脚本或文件操作。
ipcRenderer.on("jugglework:docs:prepare-close", (_event, message) => { window.postMessage({ channel: "jugglework-docs-prepare-close-command", message }, window.location.origin); });

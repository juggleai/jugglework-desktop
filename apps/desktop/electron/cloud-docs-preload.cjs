const { ipcRenderer, contextBridge } = require("electron");

// TIPS: 仅开放明确的原生能力，不暴露通用 IPC 或本机文件路径。
contextBridge.exposeInMainWorld("juggleworkDocsDesktop", true);
contextBridge.exposeInMainWorld("juggleworkDocsDetachedTab", true);
contextBridge.exposeInMainWorld("juggleworkDocsExport", {
  inFinder: process.platform === "darwin",
  save: (input) => ipcRenderer.invoke("jugglework:docs:save-export", input),
  reveal: (revealId) => ipcRenderer.invoke("jugglework:docs:reveal-export", revealId),
});
// TIPS: 仅由真实的菜单激活事件授权同一任务里的单次剪贴板命令。
let clipboardGesture;
window.addEventListener("click", (event) => {
  if (!event.isTrusted || !navigator.userActivation.isActive) return;
  const action = event.target instanceof Element
    ? event.target.closest("[data-jw-clipboard-action]")?.getAttribute("data-jw-clipboard-action")
    : undefined;
  if (!["copy", "cut", "paste"].includes(action)) return;
  const gesture = { action };
  clipboardGesture = gesture;
  setTimeout(() => {
    if (clipboardGesture === gesture) clipboardGesture = undefined;
  }, 0);
}, true);
contextBridge.exposeInMainWorld("juggleworkDocsClipboard", {
  run: (action) => {
    if (!clipboardGesture || clipboardGesture.action !== action)
      return Promise.reject(new Error("Clipboard action requires the menu gesture"));
    clipboardGesture = undefined;
    return ipcRenderer.invoke("jugglework:docs:clipboard-command", action);
  },
});
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

// The window owns the label and its accessibility tree. The native page
// only paints a passive copy on top of its content.
let railHint;
let railHintLabel;
function hideRailHint() {
  railHint?.remove();
}
window.addEventListener("pointermove", hideRailHint, { capture: true, passive: true });
ipcRenderer.on("jugglework:docs:rail-hint", (_event, hint) => {
  if (!hint) {
    hideRailHint();
    return;
  }
  if (!railHint) {
    railHint = document.createElement("div");
    railHint.setAttribute("data-jugglework-rail-hint", "");
    railHint.setAttribute("aria-hidden", "true");
    Object.assign(railHint.style, {
      all: "initial",
      position: "fixed",
      left: "6px",
      top: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
    });
    railHintLabel = document.createElement("span");
    Object.assign(railHintLabel.style, {
      display: "block",
      font: "400 12px/16px system-ui, sans-serif",
      padding: "6px 12px",
      borderRadius: "12px",
      boxShadow: "0 4px 14px rgba(0, 0, 0, .22)",
      maxWidth: "min(320px, calc(100vw - 36px))",
      overflowWrap: "anywhere",
    });
    railHint.attachShadow({ mode: "closed" }).append(railHintLabel);
  }
  railHintLabel.textContent = hint.label;
  railHintLabel.style.backgroundColor = hint.dark ? "#edeef0" : "#1c2024";
  railHintLabel.style.color = hint.dark ? "#111113" : "#ffffff";
  if (!railHint.isConnected) document.documentElement.append(railHint);
  const height = railHint.offsetHeight;
  const top = Math.max(4, Math.min(innerHeight - height - 4, hint.centerY - height / 2));
  railHint.style.top = `${top}px`;
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
// 会议视口命令：只中继固定动作和受限载荷，宿主校验实例后才交给页面。
ipcRenderer.on("jugglework:docs:meeting-command", (_event, message) => {
  window.postMessage({ channel: "jugglework-docs-meeting-command", message }, location.origin);
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

const MEETING_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 会议消息只保留固定字段，其余内容一律丢弃。 */
function safeMeeting(type, value) {
  const num = (n) => (Number.isFinite(n) ? n : null);
  if (type === "docs.sharer-relation") {
    return {
      direction: ["above", "below", "visible", "missing"].includes(value?.direction) ? value.direction : "missing",
      heading: typeof value?.heading === "string" ? value.heading.slice(0, 80) : "",
    };
  }
  if (!MEETING_ID.test(value?.workspaceId ?? "") || !MEETING_ID.test(value?.docId ?? "") ||
    !["page", "edgeless"].includes(value?.mode)) return null;
  const out = { workspaceId: value.workspaceId, docId: value.docId, mode: value.mode, userInput: value.userInput === true };
  const a = value.anchor;
  if (a && typeof a.blockId === "string" && a.blockId.length <= 128 && num(a.offset) !== null)
    out.anchor = { blockId: a.blockId, offset: Math.min(1, Math.max(-20, a.offset)) };
  const e = value.edgeless;
  if (e && num(e.centerX) !== null && num(e.centerY) !== null && num(e.zoom) !== null)
    out.edgeless = { centerX: e.centerX, centerY: e.centerY, zoom: e.zoom };
  return out;
}

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
      "docs.content-state",
      "docs.error",
      "docs.session-expired",
      "docs.layout",
      "docs.open-attachment",
      "docs.ai-reference",
      "docs.open-in-new-tab",
      "docs.viewport",
      "docs.sharer-relation",
    ].includes(message?.type)
  )
    return;
  if (message.type === "docs.content-state" && (
    typeof message.contextId !== "string" || message.contextId.length > 128 ||
    typeof message.instanceId !== "string" || message.instanceId.length > 128 ||
    typeof message.tenantId !== "string" || message.tenantId.length > 128 ||
    typeof message.workspaceId !== "string" || message.workspaceId.length > 128 ||
    !["home", "document"].includes(message.targetKind) ||
    (message.docId !== null && (typeof message.docId !== "string" || message.docId.length > 128)) ||
    typeof message.observationId !== "string" || message.observationId.length !== 36 ||
    !["loading", "presentable", "error"].includes(message.state) ||
    (message.format !== undefined && !["home", "document", "sheet", "presentation"].includes(message.format))
  )) return;
  ipcRenderer.send("jugglework:docs:message", {
    type: message.type,
    contractVersion: message.contractVersion,
    instanceId: message.instanceId,
    tenantId: message.tenantId,
    workspaceId: message.workspaceId,
    ...(typeof message.reason === "string" && message.reason.length < 64 ? { reason: message.reason } : {}),
    ...(typeof message.contextId === "string" ? { contextId: message.contextId } : {}),
    ...(message.type === "docs.ready" ? { capabilities: {
      ...(message.capabilities?.contentState === 1 ? { contentState: 1 } : {}),
      ...(message.capabilities?.resume === 1 ? { resume: 1 } : {}),
      ...(message.capabilities?.meetingViewport === 1 ? { meetingViewport: 1 } : {}),
    } } : {}),
    ...(message.type === "docs.viewport" || message.type === "docs.sharer-relation"
      ? { meeting: safeMeeting(message.type, message.meeting) }
      : {}),
    ...(message.type === "docs.content-state" ? {
      targetKind: message.targetKind,
      docId: message.docId,
      observationId: message.observationId,
      state: message.state,
      format: message.format,
    } : {}),
    ...(message.type === "docs.layout" ? { layout: message.layout } : {}),
    ...(message.type === "docs.open-attachment"
      ? { docId: message.docId, blobId: message.blobId, name: message.name, mimeType: message.mimeType, size: message.size }
      : {}),
    ...(message.type === "docs.ai-reference"
      ? { docId: message.docId, title: message.title, action: message.action, blockIds: message.blockIds }
      : {}),
    ...(message.type === "docs.open-in-new-tab" ? { docId: message.docId } : {}),
  });
});

// 关闭前仅请求原生本地持久化状态，不允许执行任意脚本或文件操作。
ipcRenderer.on("jugglework:docs:prepare-close", (_event, message) => { window.postMessage({ channel: "jugglework-docs-prepare-close-command", message }, window.location.origin); });
ipcRenderer.on("jugglework:docs:request-content-state", (_event, message) => {
  window.postMessage({ channel: "jugglework-docs-content-state-command", message }, window.location.origin);
});

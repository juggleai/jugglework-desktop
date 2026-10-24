/**
 * 在配套页面绘制本地选区入口和输入浮层。只有宿主冻结成功后才建立输入焦点。
 * @param {string} kind 当前文档类型
 * @param {Function} readSelection 已适配的原生选择读取函数
 * @param {any} scope 配套页面对象及有限 preload 桥；供隔离页面回归使用
 */
export function installOfficeSelectionUi(kind, readSelection, scope = window) {
  const bridge = scope.juggleworkOfficeSelection;
  if (!bridge || scope.document.getElementById("juggle-office-selection-ui")) return;
  const doc = scope.document;
  const root = doc.createElement("div");
  root.id = "juggle-office-selection-ui";
  root.style.cssText = "position:fixed;z-index:2147483646;left:16px;top:90px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#181818;line-height:1.5";
  const style = doc.createElement("style");
  style.textContent = `
    #juggle-office-selection-ui button{font:inherit;cursor:pointer;border:0}
    #juggle-office-selection-ui button:focus-visible,#juggle-office-selection-ui textarea:focus-visible{outline:2px solid #3183ff;outline-offset:2px}
    #juggle-office-selection-ui button:disabled{opacity:.5;cursor:wait}
    #juggle-office-selection-ui .selection-actions{position:relative;flex:none;align-self:flex-end}
    #juggle-office-selection-ui .selection-choices{display:none;position:absolute;right:-8px;bottom:100%;padding-bottom:8px}
    #juggle-office-selection-ui .selection-actions:hover .selection-choices,
    #juggle-office-selection-ui .selection-actions:focus-within .selection-choices{display:block}
    #juggle-office-selection-ui .selection-choices>div{min-width:116px;padding:4px;border:1px solid #eee;border-radius:12px;background:#fff;box-shadow:0 4px 20px #0002}
    #juggle-office-selection-ui .selection-choices button{display:flex;width:100%;justify-content:space-between;gap:12px;padding:5px 7px;border-radius:7px;background:#fff;text-align:left;white-space:nowrap}
    #juggle-office-selection-ui .selection-choices button:hover{background:#f4f4f4}
    #juggle-office-selection-ui kbd{padding:0 4px;border-radius:4px;background:#f4f4f4;color:#777;font:inherit;font-size:12px}
  `;
  root.append(style);
  const entry = doc.createElement("button");
  entry.type = "button";
  entry.setAttribute("data-jugglework-office-action", "request-edits");
  if (kind === "slide") {
    const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("data-jugglework-office-icon", "presentation");
    icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("width", "16"); icon.setAttribute("height", "16");
    icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round"); icon.setAttribute("aria-hidden", "true");
    for (const pathData of ["M2 3h20", "M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3", "m7 21 5-5 5 5"]) {
      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", pathData); icon.append(path);
    }
    const label = doc.createElement("span"); label.textContent = "Slides · Request edits / 请求修改";
    entry.append(icon, label); entry.setAttribute("aria-label", label.textContent);
    entry.style.cssText = "display:none;align-items:center;gap:7px;padding:8px 13px;border:1px solid #f5d08a;border-radius:12px;background:#fffbeb;box-shadow:0 3px 12px #92400e24;color:#92400e;font-weight:600;white-space:nowrap";
  } else {
    entry.textContent = "✦ AI 编辑"; entry.setAttribute("aria-label", "AI 编辑选区");
    entry.style.cssText = "display:none;padding:8px 13px;border:1px solid #e1e1e1;border-radius:12px;background:#fff;box-shadow:0 3px 12px #0002;color:#181818;white-space:nowrap";
  }
  root.append(entry); doc.body.append(root);
  let composing = false, pending = false, submitting = false, frozen = null, panel = null, candidateSelection = null, captureRequest = null;
  let handleInputKey = null;
  let point = { x: 24, y: 120 };
  const place = (width = 150, height = 40) => {
    root.style.left = `${Math.max(8, Math.min(point.x, scope.innerWidth - width - 12))}px`;
    root.style.top = `${Math.max(12, Math.min(point.y + 8, scope.innerHeight - height - 12))}px`;
  };
  const candidate = () => {
    if (composing || pending || submitting || panel) return;
    let selection;
    try { selection = readSelection(kind, scope); } catch { selection = null; }
    const usable = kind === "doc" ? selection?.ranges?.some((range) => range.length > 0)
      : kind === "sheet" ? selection?.ranges?.length
        : selection?.shapeIds?.length && (!selection.textSelection || selection.textSelection.count > 0);
    candidateSelection = usable ? JSON.stringify(selection) : null;
    entry.style.display = usable ? (kind === "slide" ? "flex" : "block") : "none";
    place(kind === "slide" ? Math.min(280, scope.innerWidth - 24) : 150);
  };
  const cancel = () => {
    const previous = captureRequest; captureRequest = null; frozen = null;
    panel?.remove(); panel = null;
    handleInputKey = null; entry.style.display = "none";
    // TIPS: 已提交的添加/发送由宿主完成；关闭外观不能在接收途中释放其引用。
    if (previous && !submitting) void bridge.cancel(previous).catch(() => {});
  };
  const showError = (message) => {
    panel?.remove(); panel = null;
    const error = doc.createElement("div");
    error.setAttribute("role", "status"); error.textContent = message;
    error.style.cssText = "max-width:360px;background:#fff;padding:10px 14px;border:1px solid #ddd;border-radius:12px;box-shadow:0 4px 16px #0002";
    root.append(error);
    scope.setTimeout(() => error.remove(), 6000);
  };
  const capture = async (event) => {
    event.preventDefault(); event.stopPropagation();
    if (pending || submitting || composing) return;
    pending = true; entry.disabled = true;
    const captureId = scope.crypto.randomUUID();
    captureRequest = captureId;
    try {
      const expectedSelection = readSelection(kind, scope);
      if (!candidateSelection || JSON.stringify(expectedSelection) !== candidateSelection) throw new Error("选区已变化，请重新选择内容");
      const captured = await bridge.capture(captureId, expectedSelection);
      // TIPS: 点击外部可以取消尚未返回的采集，迟到回复只清理引用，不能重新弹出浮窗。
      if (captureRequest !== captureId) { void bridge.cancel(captureId).catch(() => {}); return; }
      frozen = { ...captured, captureId };
      entry.style.display = "none";
      panel = doc.createElement("div");
      panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "编辑所选内容");
      panel.style.cssText = "box-sizing:border-box;display:flex;gap:8px;align-items:center;width:min(280px,calc(100vw - 24px));padding:4px 8px 4px 12px;border:1px solid #dedede;border-radius:12px;background:#fff;box-shadow:0 4px 16px #0002";
      const input = doc.createElement("textarea");
      input.placeholder = "说说你想怎么修改"; input.setAttribute("aria-label", input.placeholder); input.rows = 1;
      input.style.cssText = "box-sizing:border-box;flex:1;min-width:0;height:26px;resize:none;border:0;outline:0;padding:2px 0;background:transparent;font:inherit;font-size:14px;line-height:22px;color:#181818;max-height:92px";
      input.oninput = () => { input.style.height = "26px"; input.style.height = `${Math.min(input.scrollHeight, 92)}px`; place(Math.min(280, scope.innerWidth - 24), panel?.offsetHeight); };
      const actions = doc.createElement("div"); actions.className = "selection-actions";
      const add = doc.createElement("button"); add.type = "button"; add.textContent = "✓"; add.setAttribute("aria-label", "添加选区与要求");
      add.style.cssText = "display:block;width:24px;height:24px;margin:1px 0;padding:0;border-radius:50%;background:#181818;color:#fff;font-size:18px;line-height:24px";
      const menu = doc.createElement("div"); menu.className = "selection-choices"; menu.setAttribute("aria-label", "添加或发送");
      const choices = doc.createElement("div");
      const send = doc.createElement("button"); send.type = "button"; send.textContent = "发送";
      const sendKey = doc.createElement("kbd"); sendKey.textContent = /Mac/.test(scope.navigator.platform) ? "⌘↵" : "Ctrl+↵"; send.append(sendKey);
      const addChoice = doc.createElement("button"); addChoice.type = "button"; addChoice.textContent = "添加";
      const addKey = doc.createElement("kbd"); addKey.textContent = "↵"; addChoice.append(addKey);
      choices.append(addChoice, send); menu.append(choices);
      actions.append(add, menu); panel.append(input, actions); root.append(panel); place(Math.min(280, scope.innerWidth - 24), panel.offsetHeight);
      if (parseFloat(root.style.top) < 86) menu.style.cssText = "top:100%;bottom:auto;padding-top:8px;padding-bottom:0";
      const submit = async (mode) => {
        if (!frozen || input.matches(":disabled") || composing) return;
        if (mode === "send" && !input.value.trim()) { input.focus(); return; }
        input.disabled = add.disabled = send.disabled = true;
        addChoice.disabled = true; submitting = true;
        try {
          await bridge.submit({ captureId, referenceId: frozen.reference.referenceId, text: input.value, mode });
          captureRequest = null; frozen = null; panel?.remove(); panel = null; handleInputKey = null; entry.style.display = "none";
        } catch (error) {
          if (captureRequest !== captureId) { void bridge.cancel(captureId).catch(() => {}); return; }
          input.disabled = add.disabled = send.disabled = false;
          addChoice.disabled = false;
          input.setAttribute("aria-invalid", "true"); input.title = error.message;
          const notice = doc.createElement("div"); notice.setAttribute("role", "alert"); notice.textContent = error.message;
          notice.style.cssText = "position:absolute;top:100%;left:0;background:#fff;border-radius:8px;padding:8px;color:#b42318";
          panel?.append(notice); input.focus();
        } finally { submitting = false; }
      };
      add.onclick = addChoice.onclick = () => void submit("add"); send.onclick = () => void submit("send");
      handleInputKey = (key) => {
        if (input.disabled) return;
        if (key.isComposing || key.keyCode === 229 || composing) return;
        if (key.key === "Escape") { key.preventDefault(); cancel(); }
        if (key.key === "Enter" && !key.shiftKey) { key.preventDefault(); key.stopPropagation(); void submit(key.metaKey || key.ctrlKey ? "send" : "add"); }
      };
      // 宿主已经冻结范围及同状态证明，此时才允许新输入框改变文档焦点。
      input.focus();
    } catch (error) { if (captureRequest === captureId) { captureRequest = null; showError(error.message); } }
    finally { pending = false; entry.disabled = false; }
  };
  // TIPS: SDK 在 document 捕获阶段处理画布点击；宿主浮层先在 window 截止，避免采集前被收回选区。
  scope.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) {
      if (captureRequest) cancel();
      return;
    }
    event.stopPropagation();
    if (entry.contains(event.target)) void capture(event);
  }, true);
  scope.addEventListener("keydown", (event) => {
    if (!root.contains(event.target)) return;
    event.stopPropagation();
    if (panel && event.key === "Escape" && !event.isComposing && !composing) { event.preventDefault(); cancel(); }
    else if (entry.contains(event.target) && (event.key === "Enter" || event.key === " ") && !event.isComposing) void capture(event);
    else if (event.target.tagName === "TEXTAREA") handleInputKey?.(event);
  }, true);
  scope.addEventListener("keyup", (event) => { if (root.contains(event.target)) event.stopPropagation(); }, true);
  for (const name of ["focus", "focusin", "blur", "focusout"]) scope.addEventListener(name, (event) => {
    if (root.contains(event.target)) event.stopPropagation();
  }, true);
  scope.addEventListener("compositionstart", (event) => { composing = true; if (root.contains(event.target)) event.stopPropagation(); }, true);
  scope.addEventListener("compositionend", (event) => { composing = false; if (root.contains(event.target)) event.stopPropagation(); }, true);
  let candidateFrame = null;
  const scheduleCandidate = () => {
    if (candidateFrame !== null) return;
    candidateFrame = scope.requestAnimationFrame(() => { candidateFrame = null; candidate(); });
  };
  // TIPS: PPT 画布会消费 document 上的事件；在 window 捕获输入，并在原生文字选区变化后重新采样。
  scope.addEventListener("pointerup", (event) => {
    if (root.contains(event.target)) return;
    point = { x: event.clientX, y: event.clientY };
    scheduleCandidate();
  }, true);
  scope.addEventListener("keyup", (event) => { if (!root.contains(event.target)) scheduleCandidate(); }, true);
  doc.addEventListener("selectionchange", () => {
    if (!root.contains(doc.activeElement)) scheduleCandidate();
  });
  // 点击聊天输入栏或宿主工具栏时，事件不经过编辑页 DOM，通过页面失焦统一收起。
  scope.addEventListener("blur", (event) => { if (event.target === scope && captureRequest) cancel(); });
  scope.addEventListener("pagehide", cancel);
}

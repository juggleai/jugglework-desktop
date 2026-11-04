// Passive DOM observation only: never dispatch an event or invoke an SDK handler.
// Installed only in the isolated synthetic sheet, never the user's page.
export function observeSyntheticInput() {
  const events = [];
  window.officeAcceptanceInputEvents = events;
  for (const type of ["keydown", "keyup", "beforeinput", "input", "focus", "blur", "focusin", "focusout", "visibilitychange"]) {
    window.addEventListener(type, (event) => {
      if ((type === "keydown" || type === "keyup") && !["a", "z", "enter"].includes(event.key?.toLowerCase())) return;
      const entry = { type, time: performance.now(), trusted: event.isTrusted,
        key: event.key, code: event.code, meta: event.metaKey, control: event.ctrlKey,
        shift: event.shiftKey, alt: event.altKey, inputType: event.inputType,
        target: { tag: event.target?.tagName, id: event.target?.id },
        pageFocus: document.hasFocus(), activeId: document.activeElement?.id,
        visibility: document.visibilityState, defaultPrevented: event.defaultPrevented };
      events.push(entry);
      setTimeout(() => { entry.defaultPrevented = event.defaultPrevented; }, 0);
    }, { capture: true, passive: true });
  }
  return { platform: navigator.platform, userAgent: navigator.userAgent,
    userAgentPlatform: navigator.userAgentData?.platform ?? null };
}

export function acceptanceMenuState(Menu) {
  const describe = (menu) => menu?.items.map((item) => ({ label: item.label, role: item.role,
    type: item.type, enabled: item.enabled, visible: item.visible,
    accelerator: item.accelerator, registerAccelerator: item.registerAccelerator,
    ...(item.submenu ? { submenu: describe(item.submenu) } : {}) })) ?? null;
  return describe(Menu.getApplicationMenu());
}

// Native roles only; no click callbacks, custom accelerators or SDK commands.
export function installAcceptanceMenu(Menu, uiUndo, platform = process.platform) {
  if (!uiUndo) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "selectAll" }] },
  ]));
}

// Read-only diagnostics for the isolated synthetic sheet, never the user's page.
export function syntheticSheetInputState() {
  const app = window.SpreadsheetApp, canvas = app.view.canvas;
  const describe = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { tag: node.tagName, id: node.id, className: String(node.className),
      contentEditable: node.isContentEditable, value: "value" in node ? node.value : null,
      text: node.isContentEditable ? node.textContent : null,
      selectionStart: node.selectionStart ?? null, selectionEnd: node.selectionEnd ?? null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  };
  return { sheetId: app.workbook.activeSheet.getSheetId(), renderedSheetId: app.view.renderedSheetId,
    textSelection: { text: document.getSelection()?.toString() ?? "", anchorOffset: document.getSelection()?.anchorOffset,
      focusOffset: document.getSelection()?.focusOffset },
    ranges: app.view.getSelectionRanges().map(({ startRowIndex, endRowIndex, startColIndex, endColIndex }) =>
      ({ startRowIndex, endRowIndex, startColIndex, endColIndex })),
    inputting: canvas.inputManager.isInputtingState(), pageFocus: document.hasFocus(),
    events: window.officeAcceptanceInputEvents ?? [],
    canvas: { container: describe(canvas.clientRect.container),
      rowHeadWidth: canvas.headSize.displayRowHeadWidth, colHeadHeight: canvas.headSize.displayColHeadHeight,
      B2: { left: canvas.areaData.getDisplayViewLeftByCol(1), top: canvas.areaData.getDisplayViewTopByRow(1) } },
    activeElement: describe(document.activeElement),
    inputs: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].slice(0, 16).map(describe) };
}

// DOM inspection only. Returned hit-tested coordinates are consumed by real mouse input.
export function syntheticSheetToolbarState() {
  const nodes = [...document.querySelectorAll('button,[role="button"],[title],[aria-label],[data-tooltip],[class*="undo" i],[class*="redo" i]')];
  const controls = nodes.map((node) => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    const attributes = Object.fromEntries([...node.attributes].filter(({ name }) =>
      /^(?:id|class|title|aria-.*|data-.*|disabled)$/.test(name)).map(({ name, value }) => [name, value]));
    const label = [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-tooltip"),
      node.textContent?.trim(), node.id, String(node.className)].filter(Boolean).join(" ");
    const action = /\bundo\b|撤销|撤消/i.test(label) ? "undo" : /\bredo\b|重做|恢复/i.test(label) ? "redo" : null;
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const disabled = Boolean(node.closest('[disabled],[aria-disabled="true"],[class~="disabled"],[class*="-disabled"]'));
    return { tag: node.tagName, attributes, label: label.slice(0, 250), action, visible, enabled: !disabled,
      hit: visible && node.contains(document.elementFromPoint(x, y)),
      point: { x, y }, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ancestors: [node.parentElement, node.parentElement?.parentElement].filter(Boolean).map((parent) =>
        ({ tag: parent.tagName, role: parent.getAttribute("role"), className: String(parent.className) })) };
  });
  return { pageFocus: document.hasFocus(), controls: [
    ...controls.filter((control) => control.action),
    ...controls.filter((control) => !control.action && control.visible).slice(0, 80),
  ] };
}

export async function selectSyntheticCellText(contents, evaluate, eventually, expected) {
  const key = (keyCode, modifiers = []) => {
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  // Select the single ASCII line with real editing keys, independently of
  // whether the native Select All accelerator has an active first responder.
  for (let i = 0; i <= expected.length; i++) key("Right");
  for (let i = 0; i < expected.length; i++) key("Left", ["shift"]);
  await eventually("synthetic editor text selected by real keys", () => evaluate(contents, (text) =>
    document.activeElement?.id === "alloy-rich-text-editor" && document.getSelection()?.toString() === text, expected));
}

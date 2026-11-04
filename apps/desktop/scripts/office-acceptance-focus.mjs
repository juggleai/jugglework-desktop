import assert from "node:assert/strict";

export async function prepareAcceptanceApp(app, uiUndo, platform = process.platform) {
  if (!uiUndo || platform !== "darwin") return;
  assert.ok(app.isReady(), "Fixture activation preparation requires app.whenReady()");
  const dockVisibleBefore = app.dock.isVisible();
  // Electron exposes no activationPolicy getter: report the requested policy only.
  app.setActivationPolicy("regular");
  await app.dock.show();
  return { activationPolicyRequested: "regular", dockVisibleBefore, dockVisibleAfter: app.dock.isVisible(),
    appActiveAfter: app.isActive() };
}

// Fixture-only opt-in. Ordinary acceptance must never activate an OS window.
export function prepareAcceptanceWindow(host, uiUndo) {
  if (!uiUndo) {
    host.show = () => host.showInactive();
    host.focus = () => {};
  }
}

export async function focusAcceptanceEditor({ uiUndo, app, BrowserWindow, host, contents, attachedContents, eventually, evaluate }) {
  assert.ok(uiUndo, "Native activation is restricted to explicit --ui-undo");
  assert.equal(attachedContents, contents, "Only the attached fixture editor may receive input");
  assert.deepEqual(BrowserWindow.getAllWindows(), [host], "Activation must target the sole isolated fixture window");
  host.show();
  // app is the standalone fixture process, never the user's JuggleWork process.
  if (process.platform === "darwin" && !app.isActive()) app.focus({ steal: true });
  host.focus();
  await eventually("fixture window focused", () => {
    const focus = { focused: host.isFocused(), app: app.isActive(),
      visible: host.isVisible(), focusable: host.isFocusable(), minimized: host.isMinimized(),
      dockVisible: app.dock?.isVisible() };
    assert.ok(focus.focused && focus.app, JSON.stringify(focus));
    return true;
  });
  contents.focus();
  await eventually("native input focused", async () => {
    const focus = { window: host.isFocused(), contents: contents.isFocused(), app: app.isActive(),
      page: await evaluate(contents, () => document.hasFocus()) };
    assert.ok(focus.window && focus.contents && focus.app && focus.page, JSON.stringify(focus));
    return true;
  });
}

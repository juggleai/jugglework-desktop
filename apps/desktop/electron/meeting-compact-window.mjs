/** Both renderers stay mounted; switching never resizes/reloads the media window. */
export function installMeetingCompactWindow(main, full, mini, getWorkArea) {
  let compact = false;
  let ready = false;
  let switching = false;
  let disposed = false;
  const enter = (hideFull = false) => {
    if (!ready || switching || disposed || full.isDestroyed() || mini.isDestroyed()) return;
    switching = true;
    try {
      if (!compact) {
        const area = getWorkArea(full.getBounds());
        mini.setBounds({ x: area.x + Math.max(0, area.width - 276), y: area.y + 16, width: 260, height: 82 });
      }
      compact = true;
      if (mini.isMinimized()) mini.restore();
      mini.setAlwaysOnTop(true, "floating");
      mini.showInactive();
      if (hideFull && full.isVisible()) full.hide();
    } finally { switching = false; }
  };
  const restore = () => {
    if (disposed || switching || full.isDestroyed()) return;
    switching = true;
    try {
      compact = false;
      if (full.isMinimized()) full.restore();
      full.show();
      full.focus();
      if (!mini.isDestroyed()) mini.hide();
    } finally { switching = false; }
  };
  const checkVisibility = () => {
    if (!ready || disposed || switching || full.isDestroyed()) return;
    if (!full.isVisible() || full.isMinimized() || !full.isFocused()) {
      if (!compact || (!mini.isDestroyed() && !mini.isVisible())) enter();
    }
  };
  const requestClose = (event) => {
    if (disposed) return;
    event.preventDefault();
    restore();
    full.close(); // Existing beforeunload opens the leave/end confirmation.
  };
  const minimizeFull = () => enter(true);
  const blurFull = () => enter();
  const focusFull = () => {
    if (switching || disposed) return;
    compact = false;
    if (!mini.isDestroyed()) mini.hide();
  };
  const miniHidden = () => { if (compact) enter(); };
  full.on("minimize", minimizeFull);
  full.on("blur", blurFull);
  full.on("focus", focusFull);
  full.on("hide", blurFull);
  main.on("minimize", checkVisibility);
  main.on("hide", checkVisibility);
  mini.on("hide", miniHidden);
  mini.on("minimize", miniHidden);
  mini.on("close", requestClose);
  const timer = setInterval(checkVisibility, 500);
  timer.unref?.();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    full.removeListener("minimize", minimizeFull);
    full.removeListener("blur", blurFull);
    full.removeListener("focus", focusFull);
    full.removeListener("hide", blurFull);
    main.removeListener("minimize", checkVisibility);
    main.removeListener("hide", checkVisibility);
    mini.removeListener("hide", miniHidden);
    mini.removeListener("minimize", miniHidden);
    mini.removeListener("close", requestClose);
    if (!mini.isDestroyed()) mini.destroy();
  };
  full.once("closed", dispose);
  return {
    isCompact: () => compact, restore, checkVisibility,
    markReady() {
      ready = true;
      mini.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      if (!full.isVisible() || full.isMinimized() || !full.isFocused()) enter();
    },
  };
}

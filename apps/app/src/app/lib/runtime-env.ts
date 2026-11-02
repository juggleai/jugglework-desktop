// Runtime detection primitives. Leaf module by design: keep it import-free so
// low-level clients (opencode, jugglework-server, den) can use it without
// dragging in the utils barrel (which pulls i18n and app constants).
export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__JUGGLEWORK_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}

/** 独立文件入口使用 Main 的受限传输，不回退到 renderer 直接联网。 */
export function isFileWindowRuntime() {
  return isElectronRuntime() && /(?:^|\/)file-window\.html$/.test(window.location?.pathname ?? "");
}

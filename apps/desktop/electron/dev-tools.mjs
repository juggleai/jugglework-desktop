export function openDevelopmentDevTools(webContents, isDevelopment) {
  if (!isDevelopment || !webContents) return false;
  if (webContents.isDestroyed?.()) return false;
  if (webContents.isDevToolsOpened?.()) return false;

  webContents.openDevTools({ mode: "detach", activate: true });
  return true;
}

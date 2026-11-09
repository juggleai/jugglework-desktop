export function configureFakeMediaForTests(app, enabled) {
  if (!enabled) return;
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}

function isLocalRendererOrigin(origin) {
  const value = String(origin ?? "").trim();
  if (!value || value === "file://") return true;
  try {
    const url = new URL(value);
    return url.protocol === "file:" || url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

function shouldAllowMainWindowPermission(input) {
  const { webContents, permission, origin, details, mainWindow, meetingWindow } = input;
  // The blank meeting window has no preload or navigation and may only capture
  // the display in response to its own user gesture, never camera/microphone.
  if (permission === "display-capture" && meetingWindow && webContents?.id === meetingWindow.webContents.id) {
    return isLocalRendererOrigin(origin) || origin === "about:blank" || origin === "null";
  }
  if (!mainWindow || !webContents || webContents.id !== mainWindow.webContents.id) return false;
  if (!isLocalRendererOrigin(origin)) return false;
  if (permission !== "media" && permission !== "audioCapture") return true;
  const mediaType = typeof details.mediaType === "string" ? details.mediaType : "";
  if (mediaType && !["audio", "video"].includes(mediaType)) return false;
  const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return ["audio", "video"].includes(mediaType) || (mediaTypes.length > 0 && mediaTypes.every((type) => ["audio", "video"].includes(type)));
}

export function installMediaPermissionHandlers(session, getMainWindow, getMeetingWindow = () => null) {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: details?.requestingUrl,
      details: details ?? {},
      mainWindow: getMainWindow(),
      meetingWindow: getMeetingWindow(),
    }));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    shouldAllowMainWindowPermission({
      webContents,
      permission,
      origin: requestingOrigin,
      details: details ?? {},
      mainWindow: getMainWindow(),
      meetingWindow: getMeetingWindow(),
    })
  ));
}

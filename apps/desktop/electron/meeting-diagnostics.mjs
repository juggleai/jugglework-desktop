import { readFileSync, writeFileSync } from "node:fs";

/** Rare native events survive renderer hangs. No URLs, titles or device identifiers. */
export function installMeetingDiagnostics(app, filePath, roleOf) {
  let records = [];
  let storageAvailable = true;
  try {
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    if (Array.isArray(saved)) records = saved.slice(-200);
  } catch { /* first run */ }
  const record = (event, data = {}) => {
    records.push({ at: new Date().toISOString(), event, ...data });
    records = records.slice(-200);
    try { writeFileSync(filePath, JSON.stringify(records)); }
    catch { storageAvailable = false; }
  };
  record("process.start", { platform: process.platform, arch: process.arch, electron: process.versions.electron, appVersion: app.getVersion() });
  app.on("browser-window-created", (_event, window) => {
    const context = () => ({ windowId: window.id, role: roleOf(window), pid: window.webContents.isDestroyed() ? null : window.webContents.getOSProcessId() });
    window.on("unresponsive", () => record("window.unresponsive", context()));
    window.on("responsive", () => record("window.responsive", context()));
    window.webContents.on("render-process-gone", (_event, details) => record("renderer.gone", { ...context(), reason: details.reason, exitCode: details.exitCode }));
  });
  app.on("child-process-gone", (_event, details) => record("child.gone", { type: details.type, reason: details.reason, exitCode: details.exitCode }));
  return () => ({ storageAvailable, records });
}

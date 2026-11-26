import path from 'node:path';
import { existsSync } from 'node:fs';
import { createWindowsWindowIdentity } from './meeting-window-identity-windows.mjs';
import { createWindowsSemanticOverlay, semanticOverlayHelperPath } from './meeting-semantic-overlay-windows.mjs';

export function semanticOverlayDevEnabled({ platform, arch, isPackaged, flag }) {
  return platform === 'win32' && arch === 'x64' && isPackaged === false && flag === '1';
}

export function createSemanticOverlayDev(options) {
  if (!semanticOverlayDevEnabled(options)) return null;
  const identityPath = path.join(options.desktopRoot, '.dev-helpers', 'window-annotation', 'MeetingWindowIdentityWindows.exe');
  if (!existsSync(identityPath) || !existsSync(semanticOverlayHelperPath(options.desktopRoot))) return null;
  const identity = createWindowsWindowIdentity({ helperPath: identityPath });
  return {
    resolveWindowsIdentity: identity.resolveWindowsIdentity,
    activateWindow: identity.activateWindow,
    watchWindow: (target, onSample) => identity.watchWindow(target, onSample),
    async open(target) {
      const parentProcessStartedAt = await identity.resolveProcessStartedAt(process.pid);
      if (!parentProcessStartedAt) return null;
      return await createWindowsSemanticOverlay({ desktopRoot: options.desktopRoot, parentProcessStartedAt }).open(target);
    },
  };
}

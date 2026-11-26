import path from 'node:path';
import { existsSync } from 'node:fs';
import { createWindowsWindowIdentity } from './meeting-window-identity-windows.mjs';
import { createWindowsCanvasPlacement } from './meeting-window-placement-windows.mjs';
import { createAnnotationTrace } from './meeting-annotation-trace.mjs';

/** Fixed source-tree path, outside packaged resources; no executable path from the renderer. */
export function windowsAnnotationDevDir(desktopRoot) {
  return path.join(desktopRoot, '.dev-helpers', 'window-annotation');
}

export function windowsAnnotationDevEnabled({ platform, arch, isPackaged, flag }) {
  return platform === 'win32' && arch === 'x64' && isPackaged === false && flag === '1';
}

export function createWindowsAnnotationDev(options) {
  if (!windowsAnnotationDevEnabled(options)) return null;
  const helperPath = path.join(windowsAnnotationDevDir(options.desktopRoot), 'MeetingWindowIdentityWindows.exe');
  if (!existsSync(helperPath)) return null;
  const identity = createWindowsWindowIdentity({ helperPath });
  const place = createWindowsCanvasPlacement({ helperPath });
  let lastPlacement;
  let generation = 0, requestNumber = 0;
  const trace = createAnnotationTrace();
  return {
    traceEvent: event => { if (event === 'open') { generation++; requestNumber++; lastPlacement = undefined; } trace.record(event); },
    resolveWindowsIdentity: identity.resolveWindowsIdentity,
    activateWindow: identity.activateWindow,
    // macOS watcher argument 3 reports order events; Windows diagnostics
    // are not order events and must never trigger an extra placement.
    watchWindow: (target, onSample) => identity.watchWindow(target, onSample),
    placeWindowCanvas: async (canvas, target, request) => {
      const currentGeneration = generation, number = ++requestNumber;
      const phase = request.stage === 'tool-final' || request.stage === 'stationary' ? request.stage : request.checkOnly ? 'check-visible' : request.visible ? 'place-visible' : 'place-hidden';
      let reason, context;
      const result = await place(canvas, target, { ...request, onDiagnostic: code => { reason = code; },
        onCheckContext: value => { context = value; } });
      // Only the adapter's allowlisted refusal code, never a window identity.
      if (generation === currentGeneration && number === requestNumber)
        lastPlacement = result === true ? undefined : `${phase}:${reason ?? 'unconfirmed'}${context ? ':' + context : ''}`;
      return result;
    },
    getPlacementFailure: () => lastPlacement ? `${lastPlacement} | ${trace.summary()}` : undefined,
  };
}

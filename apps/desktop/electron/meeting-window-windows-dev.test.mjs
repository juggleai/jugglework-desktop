import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWindowsAnnotationDev, windowsAnnotationDevDir } from './meeting-window-windows-dev.mjs';

test('only unpackaged x64 Windows with an explicit opt-in and the standard helper connects the adapters', t => {
  const desktopRoot = mkdtempSync(path.join(tmpdir(), 'jw-window-dev-'));
  t.after(() => rmSync(desktopRoot, { recursive: true, force: true }));
  const opts = { desktopRoot, platform: 'win32', arch: 'x64', flag: '1', isPackaged: false };
  assert.equal(createWindowsAnnotationDev(opts), null);
  const dir = windowsAnnotationDevDir(desktopRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'MeetingWindowIdentityWindows.FixtureNoSendChanging.exe'), '');
  assert.equal(createWindowsAnnotationDev(opts), null);
  writeFileSync(path.join(dir, 'MeetingWindowIdentityWindows.exe'), ''); // never executed
  for (const patch of [{ flag: undefined }, { flag: '0' }, { flag: 'true' }, { isPackaged: true }, { arch: 'arm64' }, { platform: 'darwin' }, { platform: 'linux' }]) {
    assert.equal(createWindowsAnnotationDev({ ...opts, ...patch }), null);
  }
  const adapters = createWindowsAnnotationDev(opts);
  assert.equal(typeof adapters?.resolveWindowsIdentity, 'function');
  assert.equal(typeof adapters?.watchWindow, 'function');
  assert.equal(typeof adapters?.placeWindowCanvas, 'function');
});

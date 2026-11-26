import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticOverlayDevEnabled } from './meeting-semantic-overlay-dev.mjs';

test('semantic backend is restricted to unpackaged Windows x64 with its explicit flag', () => {
  assert.equal(semanticOverlayDevEnabled({ platform: 'win32', arch: 'x64', isPackaged: false, flag: '1' }), true);
  for (const input of [
    { platform: 'darwin', arch: 'x64', isPackaged: false, flag: '1' },
    { platform: 'win32', arch: 'arm64', isPackaged: false, flag: '1' },
    { platform: 'win32', arch: 'x64', isPackaged: true, flag: '1' },
    { platform: 'win32', arch: 'x64', isPackaged: false, flag: '0' },
  ]) assert.equal(semanticOverlayDevEnabled(input), false);
});

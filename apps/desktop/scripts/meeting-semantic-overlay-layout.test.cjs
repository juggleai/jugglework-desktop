'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('x64 PAINTSTRUCT and INPUT native layouts are exact', () => {
  if (process.platform !== 'win32') return;
  const exe = process.env.MEETING_SEMANTIC_OVERLAY_EXE ? path.resolve(process.env.MEETING_SEMANTIC_OVERLAY_EXE) : '';
  assert.ok(path.isAbsolute(exe), '--exe is required');
  const result = spawnSync(exe, ['layout'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const layout = JSON.parse(result.stdout.trim());
  assert.deepEqual(layout, { type: 'layout', pointer: 8, paintStruct: 72, input: 40 });
});

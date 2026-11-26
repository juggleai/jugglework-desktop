import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationTrace } from './meeting-annotation-trace.mjs';
test('trace is bounded, allowlisted, frozen on close and reset per open', () => {
  const t = createAnnotationTrace();
  t.record('canvas-focus'); assert.equal(t.summary(), '');
  t.record('open');
  for (let i=0;i<100;i++) t.record('stationary-ok');
  assert.equal(t.summary().split(',').length, 48);
  t.record('private-window-title'); assert.equal(t.summary().includes('private'), false);
  t.record('closed'); const frozen = t.summary();
  t.record('canvas-blur'); assert.equal(t.summary(), frozen);
  t.record('open'); assert.equal(t.summary().split(',').length, 1);
});

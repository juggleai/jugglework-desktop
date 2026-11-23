const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNativeSample, classifyNativeSample } = require('./meeting-window-p0-native.cjs');

const target = { hwnd: '9007199254740993', pid: 1234 };
const bounds = { x: -12, y: 10, width: 820, height: 540 };
const normal = {
  ...target, processCreated: '133800000000000001', status: 'available',
  state: 'normal', dpi: 120, outerPx: bounds, dwmPx: { x: -4, y: 10, width: 804, height: 532 },
};
const unavailable = { status: 'unavailable', reason: 'window-identity' };
const minimized = { ...normal, state: 'minimized', outerPx: null, dwmPx: null };
const parse = (record) => parseNativeSample(JSON.stringify(record), target);

test('preserves exact decimal identity and negative screen coordinates', () => {
  assert.deepEqual(parse(normal), normal);
  assert.equal(parse({ ...normal, hwnd: 9007199254740992 }), null);
  assert.equal(parse({ ...normal, hwnd: '9007199254740992' }), null);
});

test('rejects evidence from a different process or with a lossy creation timestamp', () => {
  assert.equal(parse({ ...normal, pid: 1235 }), null);
  assert.equal(parse({ ...normal, processCreated: 133800000000000000 }), null);
});

test('drops malformed JSON and invalid native geometry', () => {
  assert.equal(parseNativeSample('{', target), null);
  assert.equal(parse({ ...normal, dwmPx: { ...bounds, width: 0 } }), null);
  assert.equal(parse({ ...normal, outerPx: null }), null);
});

test('keeps unavailable separate from closure and rejects stale minimized bounds', () => {
  assert.deepEqual(parse(unavailable), unavailable);
  assert.equal(parse({ status: 'closed' }), null);
  assert.deepEqual(parse(minimized), minimized);
  assert.equal(parse({ ...minimized, outerPx: bounds }), null);
});

test('same-DPI pixel move ignores Electron DIP width jitter', () => {
  const before = { ...normal, outerDip: { width: 656 } };
  const after = { ...normal, outerDip: { width: 657 }, outerPx: { ...bounds, x: -11 },
    dwmPx: { ...normal.dwmPx, x: -3 } };
  assert.equal(classifyNativeSample(before, after), 'move');
  assert.equal(classifyNativeSample(before, { ...before, outerDip: after.outerDip }), 'unchanged');
});

test('same-DPI change on just one axis counts as a native size change', () => {
  assert.equal(classifyNativeSample(normal, { ...normal, outerPx: { ...bounds, height: 541 } }), 'resize');
});

test('DWM-only size or position changes affect mapping without implying a resize or move', () => {
  assert.equal(classifyNativeSample(normal, { ...normal, dwmPx: { ...normal.dwmPx, width: 805 } }), 'mapping-change');
  assert.equal(classifyNativeSample(normal, { ...normal, dwmPx: { ...normal.dwmPx, x: -3 } }), 'mapping-change');
});

test('a move with a change in DWM offset also changes the mapping', () => {
  const after = { ...normal, outerPx: { ...bounds, x: -11 }, dwmPx: { ...normal.dwmPx, x: -2 } };
  assert.equal(classifyNativeSample(normal, after), 'mapping-change');
});

test('DPI and window state transitions are not labeled same-DPI resize', () => {
  const resized = { ...normal, outerPx: { ...bounds, width: 984 } };
  assert.equal(classifyNativeSample(normal, { ...resized, dpi: 144 }), 'dpi-change');
  assert.equal(classifyNativeSample(normal, { ...resized, state: 'maximized' }), 'state-change');
  assert.equal(classifyNativeSample(normal, minimized), 'state-change');
  assert.equal(classifyNativeSample(minimized, normal), 'state-change');
});

test('does not compare geometry across unavailable samples or process lifetimes', () => {
  assert.equal(classifyNativeSample(normal, unavailable), 'unavailable');
  assert.equal(classifyNativeSample(unavailable, normal), 'baseline');
  assert.equal(classifyNativeSample(null, normal), 'baseline');
  assert.equal(classifyNativeSample(normal, { ...normal, processCreated: '133800000000000002' }), 'identity-change');
});

test('overlay samples require native client, edge metrics and exact layer identities', () => {
  const overlayTarget = { ...target, overlay: true };
  const overlay = { clientPx: { x: -4, y: 40, width: 804, height: 500 }, borderPx: { x: 10, y: 10 }, layers: [
    { role: 'ink', hwnd: '9007199254740995', dpi: 120, outerPx: bounds, visible: true, topmost: false, adjacent: true },
  ] };
  const overlayExpected = { ...overlay, strips: null };
  const read = (value) => parseNativeSample(JSON.stringify(value), overlayTarget);
  assert.deepEqual(read({ ...normal, overlay }), { ...normal, overlay: overlayExpected });
  assert.equal(read(normal), null);
  assert.equal(read({ ...normal, overlay: { ...overlay, clientPx: null } }), null);
  assert.equal(read({ ...normal, overlay: { ...overlay, layers: [{ ...overlay.layers[0], hwnd: 9007199254740996 }] } }), null);
  assert.equal(read({ ...normal, overlay: { ...overlay, layers: [{ ...overlay.layers[0], adjacent: 'true' }] } }), null);
});

test('passive ink emits detailed neighbor diagnostics only for the synthetic target process', () => {
  const layer = { role: 'ink', hwnd: '9007199254740995', dpi: 120, outerPx: bounds, visible: true,
    topmost: false, adjacent: false, targetRelative: 'below', nextOwner: 'target-process', nextRole: 'ime-class',
    nextOwnedByTarget: false, nextVisible: false, nextOverlapsInk: false, nextHasArea: true,
    aboveOwner: 'target-process', aboveRole: 'fixture-occluder', aboveOverlapsInk: true, occluderAboveInk: true, occluderWalk: 3, occluderTitleHits: 1,
    occluderPx: { x: 0, y: 0, width: 4, height: 6 }, occluderRaw: { l: 0, t: 0, r: 4, b: 6, valid: true, read: true, cls: '' } };
  const read = (fields) => parseNativeSample(JSON.stringify({ ...normal, overlay: { clientPx: bounds,
    borderPx: { x: 10, y: 10 }, layers: [{ ...layer, ...fields }] } }), { ...target, overlay: true, passiveInk: true })?.overlay.layers[0];
  assert.deepEqual(read({}), layer);
  assert.deepEqual(read({ nextOwner: 'other', rawTitle: 'private', aboveRole: 'arbitrary-class', aboveOverlapsInk: 'yes',
    occluderWalk: 'x', occluderTitleHits: 99 }),
    { ...layer, nextOwner: 'other', nextRole: 'unknown', nextOwnedByTarget: null, nextVisible: null,
      nextOverlapsInk: null, nextHasArea: null, aboveRole: 'unknown', aboveOverlapsInk: null,
      occluderWalk: null, occluderTitleHits: null });
});

test('edge strip evidence accepts only four known roles with known failure tokens', () => {
  const overlayTarget = { ...target, overlay: true, passiveInk: true };
  const base = { clientPx: bounds, borderPx: { x: 8, y: 8 }, layers: [
    { role: 'ink', hwnd: '9007199254740995', dpi: 96, outerPx: bounds, visible: true, topmost: false, adjacent: true } ] };
  const read = (strips) => parseNativeSample(JSON.stringify({ ...normal, overlay: { ...base, strips } }), overlayTarget)?.overlay?.strips;
  assert.deepEqual(read({ ok: true, count: 4, failures: [] }), { ok: true, count: 4, failures: [] });
  assert.deepEqual(read({ ok: false, count: 4, failures: ['top:geometry', 'left:client-overlap'] }),
    { ok: false, count: 4, failures: ['top:geometry', 'left:client-overlap'] });
  for (const bad of [{ ok: true, count: 3, failures: [] }, { ok: 'yes', count: 4, failures: [] },
    { ok: true, count: 4, failures: ['top:unknown'] }, { ok: true, count: 4, failures: ['middle:geometry'] },
    { ok: true, count: 4, failures: ['top'] }, { ok: true, count: 4, failures: [1] }]) {
    assert.equal(read(bad), undefined);
  }
});
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOccluder, geometryTransition, subtract, transition } = require('./meeting-semantic-overlay-model.cjs');

test('rectangle difference preserves exactly the unoccluded area', () => {
  const result = subtract([{ x: 0, y: 0, width: 100, height: 80 }], { x: 20, y: 10, width: 40, height: 30 });
  assert.equal(result.reduce((sum, box) => sum + box.width * box.height, 0), 6800);
  assert.deepEqual(subtract(result, { x: 200, y: 200, width: 1, height: 1 }), result);
  assert.deepEqual(subtract([{ x: 0, y: 0, width: 10, height: 10 }], { x: -1, y: -1, width: 12, height: 12 }), []);
});

test('epoch changes revoke input before re-enable and resize is terminal', () => {
  let state = { epoch: 4, mode: 'draw', input: true, visible: true, trusted: true, terminal: false };
  state = transition(state, { type: 'snapshot' });
  assert.deepEqual({ epoch: state.epoch, input: state.input, visible: state.visible }, { epoch: 5, input: false, visible: false });
  state = transition(state, { type: 'enable' }); assert.equal(state.input, false);
  state = transition(state, { type: 'commit' }); assert.equal(state.visible, true);
  state = transition(state, { type: 'enable' }); assert.equal(state.input, true);
  state = transition(state, { type: 'minimize' }); assert.equal(state.input, false);
  state = transition(state, { type: 'snapshot' }); assert.equal(state.epoch, 6); assert.equal(state.input, false);
  state = transition(state, { type: 'resize' }); assert.equal(state.terminal, true); assert.equal(state.input, false);
  assert.equal(transition(state, { type: 'snapshot' }).input, false);
});

test('unsupported or unreadable occluders fail closed without class-name exceptions', () => {
  const plain = { visible: true, minimized: false, frameTrusted: true, topmost: false, layered: false, cloaked: false, region: 'none' };
  assert.equal(classifyOccluder(plain), 'rectangle');
  for (const patch of [
    { frameTrusted: false }, { topmost: true }, { layered: true }, { cloaked: true },
    { cloaked: undefined }, { region: 'custom' }, { region: 'empty' },
  ]) assert.equal(classifyOccluder({ ...plain, ...patch }), 'unknown');
  assert.equal(classifyOccluder({ ...plain, visible: false }), 'ignore');
  assert.equal(classifyOccluder({ ...plain, minimized: true }), 'ignore');

  let state = { epoch: 2, mode: 'draw', input: true, visible: true, trusted: true, terminal: false };
  state = transition(state, { type: 'untrusted' });
  assert.deepEqual({ input: state.input, visible: state.visible, trusted: state.trusted }, { input: false, visible: false, trusted: false });
  state = transition(state, { type: 'snapshot' });
  assert.deepEqual({ epoch: state.epoch, input: state.input, visible: state.visible }, { epoch: 3, input: false, visible: false });
  state = transition(state, { type: 'commit' });
  state = transition(state, { type: 'enable' });
  assert.equal(state.input, true);
});

test('DPI changes are a new mapping epoch rather than a same-DPI resize claim', () => {
  const base = { x: 0, y: 0, width: 800, height: 600, dpi: 96 };
  assert.equal(geometryTransition(base, { ...base, x: -800 }), 'move');
  assert.equal(geometryTransition(base, { ...base, width: 801 }), 'resize');
  assert.equal(geometryTransition(base, { ...base, x: -1000, width: 1000, height: 750, dpi: 120 }), 'dpi-change');
  assert.equal(geometryTransition(base, { ...base, width: 0 }), 'untrusted');
});

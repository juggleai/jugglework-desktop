import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingAnnotationRouter } from './meeting-annotation-router.mjs';

function backend(state) {
  const calls = [];
  return {
    calls,
    state: () => state,
    open: async () => calls.push('open'),
    close: async () => calls.push('close'),
    windowShareReady: () => calls.push('ready'),
    write: async () => calls.push('write'),
  };
}

test('selected semantic backend never falls back when unavailable', async () => {
  const legacy = backend({ available: true }), semantic = backend({ selected: true, available: false });
  const router = createMeetingAnnotationRouter({ legacy, semantic });
  assert.deepEqual(router.state({}), { selected: true, available: false });
  await router.open({});
  router.windowShareReady({}, {});
  await router.writeSemantic({}, {});
  assert.deepEqual(semantic.calls, ['open', 'ready', 'write']);
  assert.deepEqual(legacy.calls, []);
});

test('non-semantic shares preserve legacy routing and close cleans both backends', async () => {
  const legacy = backend({ available: true }), semantic = backend({ selected: false, available: false });
  const router = createMeetingAnnotationRouter({ legacy, semantic });
  assert.deepEqual(router.state({}), { available: true });
  await router.open({});
  router.windowShareReady({}, {});
  await router.close({}, {});
  assert.deepEqual(legacy.calls, ['open', 'ready', 'close']);
  assert.deepEqual(semantic.calls, ['ready', 'close']);
});

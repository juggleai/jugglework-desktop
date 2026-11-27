import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/react-app/domains/meeting/doc-share.ts', import.meta.url), 'utf8');
const url = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64');
const { buildShareState, parseShareState, ShareFollower, ShareSender, SHARE_STALE_MS } = await import(url);

const identity = { meetingId: 'm1', shareId: 'shr_1', sessionId: 's1' };
const slot = { id: 'shr_1', userId: 'alice', sessionId: 's1', kind: 'doc' };
const view = (offset = 0.2) => ({ workspaceId: 'w1', docId: 'd1', mode: 'page', anchor: { blockId: 'b1', offset } });
const state = (seq, overrides = {}) => ({ ...buildShareState(identity, seq, view()), ...overrides });

test('state message is a full snapshot without action fields or content', () => {
  const message = buildShareState(identity, 3, view());
  assert.deepEqual(Object.keys(message).sort(), ['doc', 'meetingId', 'schemaVersion', 'seq', 'sessionId', 'shareId', 'state', 'viewport']);
  assert.equal(JSON.stringify(message).length < 1024, true);
  assert.deepEqual(buildShareState(identity, 4, null), { schemaVersion: 1, ...identity, seq: 4, state: 'ended' });
});

test('parse rejects unknown versions, bad ids and non-finite coordinates', () => {
  assert.equal(parseShareState({ ...state(1), schemaVersion: 2 }), null);
  assert.equal(parseShareState(state(1, { doc: { workspaceId: 'w/../x', pageId: 'd1', mode: 'page' } })), null);
  assert.equal(parseShareState(state(1, { viewport: { edgeless: { centerX: NaN, centerY: 0, zoom: 1 } } })), null);
  assert.equal(parseShareState(state(-1)), null);
  const clamped = parseShareState(state(1, { viewport: { anchor: { blockId: 'b', offset: 9 } } }));
  assert.equal(clamped.viewport.anchor.offset, 1);
});

test('follower keeps only the newest state from the slot owner', () => {
  const f = new ShareFollower();
  f.syncSlot(slot);
  assert.ok(f.receive(state(5), 'alice', slot, 'm1', 1000));
  assert.equal(f.receive(state(5), 'alice', slot, 'm1', 1001), null, 'duplicate seq');
  assert.equal(f.receive(state(4), 'alice', slot, 'm1', 1002), null, 'older seq');
  assert.equal(f.receive(state(6), 'mallory', slot, 'm1', 1003), null, 'sender is not the sharer');
  assert.equal(f.receive(state(7, { sessionId: 'other' }), 'alice', slot, 'm1', 1004), null, 'wrong session');
  assert.equal(f.receive(state(8, { shareId: 'shr_old' }), 'alice', slot, 'm1', 1005), null, 'stale share');
  assert.equal(f.receive(state(9), 'alice', slot, 'other-meeting', 1006), null, 'other meeting');
  assert.equal(f.receive(state(9), 'alice', undefined, 'm1', 1007), null, 'no share slot');
  assert.equal(f.latest.seq, 5);
});

test('user input switches to free browsing and follow returns with the latest state', () => {
  const f = new ShareFollower();
  f.syncSlot(slot);
  f.receive(state(1), 'alice', slot, 'm1', 0);
  assert.equal(f.shouldApply(), true);
  f.userScrolled();
  assert.equal(f.mode, 'free');
  f.receive(state(2), 'alice', slot, 'm1', 10);
  assert.equal(f.shouldApply(), false, 'free browsing never applies the sharer view');
  f.follow();
  assert.equal(f.shouldApply(), true);
  assert.equal(f.latest.seq, 2);
});

test('a new sharer resets sequence and follow state; ended clears following', () => {
  const f = new ShareFollower();
  f.syncSlot(slot);
  f.receive(state(40), 'alice', slot, 'm1', 0);
  f.userScrolled();
  const next = { id: 'shr_2', userId: 'bob', sessionId: 's2', kind: 'doc' };
  f.syncSlot(next);
  assert.equal(f.mode, 'following');
  const accepted = f.receive({ ...buildShareState({ meetingId: 'm1', shareId: 'shr_2', sessionId: 's2' }, 1, view()) }, 'bob', next, 'm1', 20);
  assert.ok(accepted, 'seq restarts for a new share id');
  f.syncSlot(undefined);
  assert.equal(f.latest, null);
});

test('stale only after ten seconds without a new state', () => {
  const f = new ShareFollower();
  f.syncSlot(slot);
  f.receive(state(1), 'alice', slot, 'm1', 1000);
  assert.equal(f.stale(1000 + SHARE_STALE_MS), false);
  assert.equal(f.stale(1001 + SHARE_STALE_MS), true);
});

test('sender throttles bursts, delivers the last state and resends while idle', () => {
  const sent = [];
  const s = new ShareSender((seq, v) => sent.push([seq, v.anchor.offset]));
  s.update(view(0.1), 1000);
  s.update(view(0.2), 1050);
  s.update(view(0.3), 1100);
  assert.deepEqual(sent, [[1, 0.1]]);
  s.tick(1200);
  assert.deepEqual(sent.at(-1), [2, 0.3], 'last state is not lost');
  s.tick(2000);
  assert.equal(sent.length, 2, 'no resend before three seconds');
  s.tick(4300);
  assert.deepEqual(sent.at(-1), [3, 0.3], 'idle resend carries a higher seq');
});

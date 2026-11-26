const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recoverOnce } = require('./meeting-toolbar-owner-recovery.cjs');

function fixture() {
  let consume, stopped = 0, suspended = 0, placements = 0;
  const rows = [];
  const options = { target: {}, watchWindow: (_, callback) => { consume = callback; return () => { stopped++; }; },
    suspend: () => suspended++, record: (stage, data) => rows.push({ stage, ...data }),
    layout: async () => { placements++; } };
  return { options, emit: value => consume(value), rows,
    counts: () => ({ stopped, suspended, placements }) };
}
const visible = n => ({ status: 'visible', bounds: { x: n, y: 0, width: 480, height: 280 }, actualSize: { width: 480, height: 280 } });

test('ten trusted visible samples are skipped; pending cannot advance; fresh eleventh geometry authorizes full layout', async () => {
  const f = fixture(); let used;
  f.options.layout = async (sample, active) => { active(); used = sample; };
  const task = recoverOnce(f.options);
  f.emit({ status: 'geometry-pending' });
  for (let i = 1; i <= 10; i++) f.emit(visible(i));
  await Promise.resolve(); assert.equal(used, undefined);
  f.emit(visible(11)); await task;
  assert.equal(used.bounds.x, 11);
  assert.equal(f.rows.filter(r => r.stage === 'recovery-trusted-visible').length, 11);
  assert.equal(f.counts().suspended, 1); assert.ok(f.counts().stopped);
});

test('terminal observer failure withdraws layers and never attempts placement', async () => {
  const f = fixture(), task = recoverOnce(f.options);
  f.emit({ status: 'unavailable' });
  await assert.rejects(task, /recovery-observer-unavailable/);
  assert.equal(f.counts().placements, 0); assert.equal(f.counts().suspended, 2);
});

test('deadline includes placement and cannot be renewed by fresh samples', async () => {
  const f = fixture();
  f.options.timeoutMs = 20;
  f.options.layout = async (_, active) => { await new Promise(resolve => setTimeout(resolve, 35)); active(); };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await assert.rejects(task, /recovery-original-deadline/);
  assert.equal(f.counts().suspended, 3);
  assert.equal(f.rows.some(r => r.stage === 'recovery-verified'), false);
});

test('placement rejection stops without a second watch or layout', async () => {
  const f = fixture(); let calls = 0;
  f.options.layout = async () => { calls++; throw new Error('strict-refused'); };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await assert.rejects(task, /strict-refused/);
  assert.equal(calls, 1); assert.equal(f.counts().suspended, 2);
});

const unconfirmed = () => Object.assign(new Error('strict-order-unconfirmed'), {
  result: 'placement-order-unconfirmed', deferRecoveryOrder: true,
});
const tick = () => new Promise(resolve => setImmediate(resolve));

test('order deferral skips exactly two additional trusted samples and uses fresh geometry only once', async () => {
  const f = fixture(), used = [];
  f.options.layout = async sample => { used.push(sample.bounds.x); throw unconfirmed(); };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await tick();
  f.emit({ status: 'geometry-pending' });
  f.emit(visible(12)); f.emit(visible(13));
  await tick(); assert.deepEqual(used, [11]);
  f.emit(visible(14));
  await assert.rejects(task, /strict-order-unconfirmed/);
  assert.deepEqual(used, [11, 14]);
  assert.equal(f.rows.filter(r => r.stage === 'recovery-order-deferred').length, 1);
  f.emit(visible(15)); assert.deepEqual(used, [11, 14]);
});

test('single deferral can complete full layout within original deadline', async () => {
  const f = fixture(); let calls = 0;
  f.options.layout = async (_, active) => { active(); if (++calls === 1) throw unconfirmed(); };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await tick();
  for (let i = 12; i <= 14; i++) f.emit(visible(i));
  await task;
  assert.equal(calls, 2);
  assert.equal(f.rows.filter(r => r.stage === 'recovery-verified').length, 1);
});

test('deferral does not renew deadline and late watcher samples cannot place', async () => {
  const f = fixture(); let calls = 0;
  f.options.timeoutMs = 100;
  f.options.layout = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 65)); throw unconfirmed(); };
  const start = performance.now(), task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await assert.rejects(task, /recovery-original-deadline/);
  assert.ok(performance.now() - start < 155, 'must not get a second 100ms budget');
  for (let i = 12; i <= 14; i++) f.emit(visible(i));
  assert.equal(calls, 1);
  assert.equal(f.rows.some(r => r.stage === 'recovery-verified'), false);
});

test('late placement reply after deferral cannot verify or reopen input', async () => {
  const f = fixture(); let calls = 0, reopened = false;
  f.options.timeoutMs = 30;
  f.options.layout = async (_, active) => {
    if (++calls === 1) throw unconfirmed();
    await new Promise(resolve => setTimeout(resolve, 50)); active(); reopened = true;
  };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await tick();
  for (let i = 12; i <= 14; i++) f.emit(visible(i));
  await assert.rejects(task, /recovery-original-deadline/);
  assert.equal(calls, 2); assert.equal(reopened, false);
  assert.equal(f.rows.some(r => r.stage === 'recovery-verified'), false);
});

for (const variant of ['pen', 'final']) test(`${variant} rejection cannot consume order deferral`, async () => {
  const f = fixture(); let calls = 0;
  if (variant === 'pen') f.options.mode = 'pen';
  f.options.layout = async () => { calls++; const error = unconfirmed(); if (variant === 'final') error.deferRecoveryOrder = false; throw error; };
  const task = recoverOnce(f.options);
  for (let i = 1; i <= 11; i++) f.emit(visible(i));
  await assert.rejects(task, /strict-order-unconfirmed/);
  assert.equal(calls, 1);
  assert.equal(f.rows.some(r => r.stage === 'recovery-order-deferred'), false);
});

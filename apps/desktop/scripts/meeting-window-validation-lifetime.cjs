// Fixture lifecycle only. A last-window close must not skip child cleanup.
function holdApp(app) {
  let released = false;
  const hold = () => {};
  const prevent = event => { if (!released) event.preventDefault(); };
  app.on('window-all-closed', hold);
  app.on('before-quit', prevent);
  return () => {
    released = true;
    app.removeListener('window-all-closed', hold);
    app.removeListener('before-quit', prevent);
  };
}

function trackChild(child, role) {
  const record = { child, role, closed: false, exited: false, code: null, signal: null, forced: false, killRequests: 0, spawnError: false };
  child.once('exit', () => { record.exited = true; });
  const kill = child.kill?.bind(child);
  if (kill) child.kill = (...args) => { record.killRequests++; return kill(...args); };
  record.done = new Promise(resolve => child.once('close', (code, signal) => {
    Object.assign(record, { closed: true, code, signal }); resolve(record);
  }));
  // Spawn errors still require `close`; no private command or error text is logged.
  child.on('error', () => { record.spawnError = true; });
  return record;
}

async function waitForClose(record, timeoutMs = 3000) {
  let timer;
  try {
    return await Promise.race([
      record.done.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function finishChild(record, requestStop, timeoutMs = 3000) {
  if (!record.closed) {
    try { requestStop(); } catch { /* retain exit readback as the authority */ }
  }
  const graceful = await waitForClose(record, timeoutMs);
  if (!graceful) {
    record.forced = true;
    try { record.child.kill(); } catch { /* wait for actual close below */ }
    await waitForClose(record, timeoutMs);
  }
  return { role: record.role, closed: record.closed, code: record.code,
    signal: record.signal, forced: record.forced,
    graceful: graceful && record.code === 0 && !record.signal && !record.forced && !record.spawnError && record.killRequests === 0 };
}

function expectedRejection(record) {
  return record.closed && record.code === 1 && !record.signal && !record.spawnError && record.killRequests === 0;
}

function motionVerdict(samples, expected, allowPending = false) {
  const visible = samples.filter(sample => sample.status === 'visible');
  const unavailable = samples.filter(sample => sample.status === 'unavailable').length;
  const sizeStable = visible.every(sample => sample.actualSize?.width === expected.width && sample.actualSize?.height === expected.height);
  const pending = samples.filter(sample => sample.status === 'geometry-pending').length;
  const recovered = samples.at(-1)?.status === 'visible';
  return { pass: samples.every(sample => sample.status === 'visible' || (allowPending && sample.status === 'geometry-pending')) &&
      visible.length > 0 && sizeStable && recovered,
    visibleSamples: visible.length, unavailable, pending, recovered, sizeStable };
}

module.exports = { holdApp, trackChild, waitForClose, finishChild, motionVerdict, expectedRejection };

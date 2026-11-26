// Fixture-only recovery driven by the production identity observer, not a sleep.
// Match meeting-annotation.mjs: skip ten trusted visible samples, then use the
// next fresh geometry. A single deadline covers observation AND full placement.
async function recoverOnce({ watchWindow, target, suspend, layout, record, mode = 'pointer', timeoutMs = 2500 }) {
  const started = performance.now(), expires = started + timeoutMs;
  let stop, timer, expired = false, samples = 0, waiting, deferredRecoveryOrder = false, terminal;
  const active = () => {
    if (expired || performance.now() >= expires) throw new Error('recovery-original-deadline');
    if (terminal) throw terminal;
  };
  suspend();
  record('recovery-suspended', { timeoutMs, skipTrustedVisible: 10 });
  try {
    const nextSample = skip => new Promise((resolve, reject) => { waiting = { skip, resolve, reject }; });
    let sampleTask = nextSample(10);
    timer = setTimeout(() => {
      expired = true; suspend(); waiting?.reject(new Error('recovery-original-deadline')); waiting = undefined;
    }, timeoutMs);
    stop = watchWindow(target, value => {
        if (expired || terminal) return;
        try {
          active();
          if (value.status === 'geometry-pending') { record('recovery-pending'); return; }
          if (value.status !== 'visible') throw new Error(`recovery-observer-${value.status}`);
          if (!waiting) return; // Samples during placement cannot authorize another epoch.
          samples++;
          record('recovery-trusted-visible', { sample: samples, bounds: value.bounds, actualSize: value.actualSize, elapsedMs: Math.round(performance.now() - started) });
          if (waiting.skip-- > 0) return;
          const { resolve } = waiting; waiting = undefined; resolve(value);
        } catch (error) { terminal = error; waiting?.reject(error); waiting = undefined; }
      }, reason => record('recovery-observer-diagnostic', { reason }));
    while (true) {
      const sample = await sampleTask;
      active();
      if (terminal) throw terminal;
      try { await layout(sample, active); }
      catch (error) {
        active();
        if (terminal) throw terminal;
        // Production deferUnconfirmedOrder: this function is already inside
        // the retriedHiddenNeighbor/geometryRecovery/original-deadline epoch.
        // Only hidden/visible placement marks this error eligible, never final.
        if (mode !== 'pointer' || error.result !== 'placement-order-unconfirmed' ||
            !error.deferRecoveryOrder || deferredRecoveryOrder) throw error;
        deferredRecoveryOrder = true;
        suspend();
        record('recovery-order-deferred', { skipTrustedVisible: 2, elapsedMs: Math.round(performance.now() - started), timeoutMs });
        sampleTask = nextSample(2);
        continue;
      }
      active();
      if (terminal) throw terminal;
      break;
    }
    record('recovery-verified', { samples, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    suspend();
    record('recovery-refused', { reason: error.message, samples, elapsedMs: Math.round(performance.now() - started) });
    throw error;
  } finally { clearTimeout(timer); stop?.(); }
}

module.exports = { recoverOnce };

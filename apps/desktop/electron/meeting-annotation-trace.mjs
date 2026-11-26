// Private, bounded memory only. Never accepts document/window identities.
const allowed = new Set(['open', 'tool-pointer', 'tool-draw', 'canvas-focus', 'canvas-blur',
  'toolbar-focus', 'toolbar-blur', 'suspend', 'hidden-start', 'hidden-ok', 'hidden-fail',
  'visible-start', 'visible-ok', 'visible-fail', 'final-start', 'final-ok', 'final-fail',
  'stationary-start', 'stationary-ok', 'stationary-fail', 'external-recovery', 'closed']);
export function createAnnotationTrace() {
  let epoch = 0, seq = 0, start = 0, frozen = false;
  let entries = [];
  return {
    record(event) {
      if (!allowed.has(event)) return;
      if (event === 'open') { epoch++; seq = 0; start = performance.now(); frozen = false; entries = []; }
      if (frozen || !epoch) return;
      entries.push({ n: ++seq, ms: Math.round(performance.now() - start), event });
      if (entries.length > 48) entries.shift();
      if (event === 'closed') frozen = true;
    },
    summary() { return entries.map(e => `${e.n}@${e.ms}:${e.event}`).join(','); },
  };
}

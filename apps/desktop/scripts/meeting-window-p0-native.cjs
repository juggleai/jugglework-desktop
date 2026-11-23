const decimal = (value) => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) &&
  value.length <= 20 && BigInt(value) <= 0xffffffffffffffffn;
const reasons = new Set(['dpi-context', 'process-identity', 'window-identity', 'geometry', 'layer-identity']);

function parseBox(box) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) ||
      box.width <= 0 || box.height <= 0) return null;
  const { x, y, width, height } = box;
  return { x, y, width, height };
}

function parseNativeSample(line, target) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record) return null;
  const { status, reason, hwnd, pid, processCreated, state, dpi } = record;
  if (status === 'unavailable' && reasons.has(reason)) return { status, reason };
  if (status !== 'available' || !decimal(hwnd) || hwnd !== target.hwnd || pid !== target.pid ||
      !decimal(processCreated) || !['normal', 'minimized', 'maximized'].includes(state) ||
      !Number.isSafeInteger(dpi) || dpi <= 0) return null;
  const outerPx = parseBox(record.outerPx), dwmPx = parseBox(record.dwmPx);
  if (state === 'minimized' ? record.outerPx !== null || record.dwmPx !== null : !outerPx || !dwmPx) return null;
  const result = { status, hwnd, pid, processCreated, state, dpi, outerPx, dwmPx };
  if (target.overlay) {
    const value = record.overlay;
    if (!value || !parseBox(value.clientPx) || !value.borderPx ||
        ![value.borderPx.x, value.borderPx.y].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 64) ||
        !Array.isArray(value.layers) || value.layers.length > 5) return null;
    const layers = [];
    for (const layer of value.layers) {
      if (!layer || !['ink', 'top', 'bottom', 'left', 'right'].includes(layer.role) || !decimal(layer.hwnd) ||
          !Number.isSafeInteger(layer.dpi) || layer.dpi <= 0 || !parseBox(layer.outerPx) ||
          !['visible', 'topmost', 'adjacent'].every((k) => typeof layer[k] === 'boolean')) return null;
      const { role, hwnd, dpi, visible, topmost, adjacent } = layer;
      const order = target.passiveInk ? {
        ...(adjacent ? {} : {
          targetRelative: ['above', 'below', 'unknown'].includes(layer.targetRelative) ? layer.targetRelative : 'unknown',
          nextOwner: ['none', 'ink-process', 'target-process', 'other', 'unknown'].includes(layer.nextOwner) ? layer.nextOwner : 'unknown',
          nextRole: layer.nextOwner === 'target-process' && ['target-default-ime', 'ime-class', 'winforms-class'].includes(layer.nextRole)
            ? layer.nextRole : 'unknown',
          ...Object.fromEntries(['nextOwnedByTarget', 'nextVisible', 'nextOverlapsInk', 'nextHasArea'].map((key) =>
            [key, layer.nextOwner === 'target-process' && typeof layer[key] === 'boolean' ? layer[key] : null])),
        }),
        aboveOwner: ['none', 'ink-process', 'target-process', 'other', 'unknown'].includes(layer.aboveOwner) ? layer.aboveOwner : 'unknown',
        aboveRole: layer.aboveRole === 'fixture-occluder' ? 'fixture-occluder' : 'unknown',
        aboveOverlapsInk: typeof layer.aboveOverlapsInk === 'boolean' ? layer.aboveOverlapsInk : null,
        occluderAboveInk: typeof layer.occluderAboveInk === 'boolean' ? layer.occluderAboveInk : null,
        occluderWalk: Number.isSafeInteger(layer.occluderWalk) && layer.occluderWalk >= 0 && layer.occluderWalk <= 32 ? layer.occluderWalk : null,
        occluderTitleHits: Number.isSafeInteger(layer.occluderTitleHits) && layer.occluderTitleHits >= 0 && layer.occluderTitleHits <= 32 ? layer.occluderTitleHits : null,
        occluderPx: parseBox(layer.occluderPx), occluderRaw: layer.occluderRaw && ['l','t','r','b'].every((k)=>Number.isSafeInteger(layer.occluderRaw[k])) ? { l: layer.occluderRaw.l, t: layer.occluderRaw.t, r: layer.occluderRaw.r, b: layer.occluderRaw.b, valid: layer.occluderRaw.valid === true, read: layer.occluderRaw.read === true, cls: typeof layer.occluderRaw.cls === 'string' && layer.occluderRaw.cls.length <= 128 ? layer.occluderRaw.cls : '' } : null,
      } : {};
      layers.push({ role, hwnd, dpi, outerPx: parseBox(layer.outerPx), visible, topmost, adjacent, ...order });
    }
    let strips = null;
    if (value.strips != null) {
      const strip = value.strips;
      const roles = ['top', 'bottom', 'left', 'right'];
      const reasons = ['hwnd', 'pid', 'style', 'hidden', 'below-target', 'rect', 'geometry', 'client-overlap', 'not-hittable', 'target-above', 'ink-above', 'other-above'];
      if (typeof strip.ok !== 'boolean' || !Number.isSafeInteger(strip.count) || strip.count !== 4 ||
          !Array.isArray(strip.failures) || strip.failures.length > 8) return null;
      const failures = [];
      for (const failure of strip.failures) {
        if (typeof failure !== 'string') return null;
        const [role, reason] = failure.split(':');
        if (!roles.includes(role) || !reasons.includes(reason)) return null;
        failures.push(role + ':' + reason);
      }
      strips = { ok: strip.ok, count: strip.count, failures };
    }
    result.overlay = { clientPx: parseBox(value.clientPx), borderPx: { x: value.borderPx.x, y: value.borderPx.y }, layers, strips };
  }
  return result;
}

function classifyNativeSample(before, after) {
  if (after.status === 'unavailable') return 'unavailable';
  if (before?.status !== 'available') return 'baseline';
  if (before.hwnd !== after.hwnd || before.pid !== after.pid || before.processCreated !== after.processCreated) {
    return 'identity-change';
  }
  if (before.state !== after.state) return 'state-change';
  if (before.dpi !== after.dpi) return 'dpi-change';
  if (after.state === 'minimized') return 'unchanged';
  const { outerPx: a, dwmPx: frameA } = before;
  const { outerPx: b, dwmPx: frameB } = after;
  if (a.width !== b.width || a.height !== b.height) return 'resize';
  const dx = b.x - a.x, dy = b.y - a.y;
  if (frameA.width !== frameB.width || frameA.height !== frameB.height ||
      frameB.x - frameA.x !== dx || frameB.y - frameA.y !== dy) return 'mapping-change';
  if (dx || dy) return 'move';
  return 'unchanged';
}

module.exports = { parseNativeSample, classifyNativeSample };

// Fixture-only passive ink; never enables input or reorders another window.
const rectKeys = ['x', 'y', 'width', 'height'];
const same = (a, b) => !!a && !!b && rectKeys.every((key) => a[key] === b[key]);

function inkPlan(sample, screen, baseline) {
  if (sample?.status !== 'available') throw new Error('ink-native-unavailable');
  if (sample.state !== 'normal') throw new Error('ink-target-state');
  if (baseline && ['hwnd', 'pid', 'processCreated'].some((key) => sample[key] !== baseline[key])) throw new Error('ink-identity');
  if (sample.dpi !== 96 || (baseline && sample.dpi !== baseline.dpi)) throw new Error('ink-dpi');
  const px = sample.overlay.clientPx;
  const outer = sample.outerPx;
  const screens = screen.getAllDisplays();
  const dip = screen.screenToDipRect(null, px);
  const bounds = screens[0]?.bounds;
  if (!bounds || screens.length !== 1 || screens[0].scaleFactor !== 1 ||
      !same(px, screen.dipToScreenRect(null, dip)) ||
      outer.x < bounds.x || outer.y < bounds.y || outer.x + outer.width > bounds.x + bounds.width ||
      outer.y + outer.height > bounds.y + bounds.height ||
      px.x < outer.x || px.y < outer.y || px.x + px.width > outer.x + outer.width ||
      px.y + px.height > outer.y + outer.height) throw new Error('ink-geometry');
  if (baseline && (!same(px, baseline.overlay.clientPx) || !same(outer, baseline.outerPx) ||
      !same(sample.dwmPx, baseline.dwmPx))) throw new Error('ink-geometry');
  return { px, dip };
}

function inkVerdict(layers, hwnd, plan) {
  const [layer] = layers;
  if (layers.length !== 1 || layer.role !== 'ink' || layer.hwnd !== hwnd) return 'ink-identity';
  if (layer.dpi !== 96) return 'ink-dpi';
  if (layer.topmost || !layer.visible || !same(layer.outerPx, plan.px)) return 'ink-geometry';
  return layer.adjacent ? null : 'ink-order';
}

const page = `<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>body {margin:0;overflow:hidden}canvas {display:block}</style><canvas></canvas><script>
const c=document.querySelector('canvas'); c.width=innerWidth; c.height=innerHeight;
const g=c.getContext('2d'); g.strokeStyle='#ff35c8';g.lineWidth=4;
g.beginPath(); g.moveTo(48,80);g.lineTo(48,48);g.lineTo(80,48);
g.moveTo(100,120);g.lineTo(240,120);g.stroke();
let clicks=0,drags=0,start=null; // real pointer events only
document.addEventListener('pointerdown',e=>{clicks++;start={x:e.clientX,y:e.clientY}});
document.addEventListener('pointerup',e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)drags++;start=null});
document.addEventListener('pointercancel',()=>{start=null});
globalThis.p0Input=()=>({clicks,drags});
</script>`;

// Deterministic pass/fail for the manual A4 modes.
function a4Verdict(mode, ink, target) {
  const counts = (v) => v && Number.isSafeInteger(v.clicks) && Number.isSafeInteger(v.drags) &&
    v.clicks >= 0 && v.drags >= 0;
  if (!['passive', 'draw', 'occluded'].includes(mode) || !counts(ink) || !counts(target)) return { pass: false, reason: 'counts' };
  if (mode === 'occluded') {
    const covered = Number.isSafeInteger(target.occluderClicks) ? target.occluderClicks : 0;
    if (covered < 3) return { pass: false, reason: 'occluder-clicks-missing' };
    if (target.clicks !== 0) return { pass: false, reason: 'target-received-occluded-click' };
    return { pass: true, reason: 'occluder-owned-input' };
  }
  if (mode === 'passive') {
    if (target.drags < 8) return { pass: false, reason: 'edge-drags-missing' };
    if (ink.clicks !== 0 || ink.drags !== 0) return { pass: false, reason: 'ink-stole-input' };
    return { pass: true, reason: 'click-through' };
  }
  if (ink.drags < 3) return { pass: false, reason: 'draw-drags-missing' };
  if (target.clicks !== 0) return { pass: false, reason: 'target-received-input' };
  return { pass: true, reason: 'ink-owned-input' };
}

// 100%-scale mapping check: frame must match DWM size and synthetic marker spacing
// must match the target client size minus the fixture's fixed 24 DIP inset.
function mappingVerdict(markers, frame, dwm, client) {
  if (!Array.isArray(markers) || markers.length !== 4) return { ok: false, reason: 'markers' };
  const by = Object.fromEntries(markers.map((m) => [m.role, m]));
  if (!['TL', 'TR', 'BL', 'BR'].every((role) => by[role] && by[role].count > 0 &&
      Number.isFinite(by[role].x) && Number.isFinite(by[role].y))) return { ok: false, reason: 'present' };
  if (!frame || !dwm || !client || ![frame.width, frame.height, dwm.width, dwm.height, client.width, client.height]
      .every((n) => Number.isSafeInteger(n) && n > 0)) return { ok: false, reason: 'size' };
  const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
  const sizeOk = near(frame.width, dwm.width, 1) && near(frame.height, dwm.height, 1);
  const alignOk = near(by.TL.x, by.BL.x, 0.5) && near(by.TR.x, by.BR.x, 0.5) &&
    near(by.TL.y, by.TR.y, 0.5) && near(by.BL.y, by.BR.y, 0.5);
  const spacingX = by.TR.x - by.TL.x, spacingY = by.BL.y - by.TL.y;
  const spacingOk = near(spacingX, client.width - 48, 1) && near(spacingY, client.height - 48, 1);
  return { ok: sizeOk && alignOk && spacingOk, sizeOk, alignOk, spacingOk,
    spacingX: Math.round(spacingX * 100) / 100, spacingY: Math.round(spacingY * 100) / 100,
    expectedX: client.width - 48, expectedY: client.height - 48 };
}

// Strip hot zones: only the four fixture strips may receive the clicks.
function stripInputVerdict(strips, ink, target) {
  const roles = ['top', 'bottom', 'left', 'right'];
  if (!strips || typeof strips !== 'object' || !Array.isArray(roles)) return { pass: false, reason: 'counts' };
  let total = 0;
  for (const role of roles) {
    const value = strips[role] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) return { pass: false, reason: 'counts' };
    total += value;
  }
  const valid = (v) => v && Number.isSafeInteger(v.clicks) && Number.isSafeInteger(v.drags) && v.clicks >= 0 && v.drags >= 0;
  if (!valid(ink) || !valid(target)) return { pass: false, reason: 'counts' };
  if (total < 8) return { pass: false, reason: 'strip-clicks-missing' };
  if (target.clicks !== 0) return { pass: false, reason: 'target-received-edge-click' };
  if (ink.clicks !== 0 || ink.drags !== 0) return { pass: false, reason: 'ink-stole-edge-input' };
  return { pass: true, reason: 'strips-owned-input', total };
}

module.exports = { inkPlan, inkVerdict, page, a4Verdict, mappingVerdict, stripInputVerdict };

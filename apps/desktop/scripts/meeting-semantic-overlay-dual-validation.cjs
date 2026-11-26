'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const at = process.argv.indexOf('--exe');
const exe = at >= 0 ? path.resolve(process.argv[at + 1] || '') : '';
if (process.platform !== 'win32' || !path.isAbsolute(exe)) process.exit(1);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); } throw Error('timeout'); }
function check(value, stage, detail = {}) { console.log(JSON.stringify({ stage, pass: Boolean(value), ...detail })); if (!value) throw Error(stage); }
const children = [];
function start(role, args, fixtureInjection = false) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false,
    env: fixtureInjection ? { ...process.env, MEETING_SEMANTIC_OVERLAY_FIXTURE_INJECTION: '1' } : process.env });
  const record = { role, child, lines: [], closed: false, forced: false, code: null }; children.push(record);
  child.stdin.on('error', () => {}); createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('close', code => { record.closed = true; record.code = code; }); return record;
}
async function ready(record) { return until(() => record.lines.find(line => line.type === 'ready')); }
async function command(record, action) { const mark = record.lines.length; record.child.stdin.write(`${action}\n`); return until(() => record.lines.slice(mark).find(line => line.type === 'ack' && line.action === action)); }
async function state(record) { await command(record, 'query'); return record.lines.findLast(line => line.type === 'state'); }
function processIdentity(pid) { const result = spawnSync(exe, ['process-fixture', String(pid)], { encoding: 'utf8', timeout: 5000 }); return JSON.parse(result.stdout.trim()); }
function pixel(x, y) { const result = spawnSync(exe, ['pixel', String(x), String(y)], { encoding: 'utf8', timeout: 5000 }); return JSON.parse(result.stdout.trim()); }
function inkNear(x, y, predicate, radius = 5) {
  const samples = [];
  for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) { const value = pixel(x + dx, y + dy); samples.push(value); if (predicate(value)) return { pass: true, value }; }
  return { pass: false, samples };
}
function resources(pid) { const result = spawnSync(exe, ['resources', String(pid)], { encoding: 'utf8', timeout: 5000 }); return JSON.parse(result.stdout.trim()); }
function hit(x, y, target, overlay, occluder, includeOverlay = true) {
  const ids = ['target', target.hwnd, target.pid, target.started];
  if (includeOverlay) ids.push('overlay', 'hit', overlay.pid, overlay.started);
  if (occluder) ids.push('occluder', occluder.hwnd, occluder.pid, occluder.started);
  const result = spawnSync(exe, ['probe', String(x), String(y), 'hit', ...ids], { encoding: 'utf8', timeout: 5000 });
  return JSON.parse(result.stdout.trim());
}
async function protocol(record, sessionId, epoch, seq, commandName, fields = {}) {
  const mark = record.lines.length; record.child.stdin.write(`${JSON.stringify({ version: 1, sessionId, seq, expectedEpoch: epoch, command: commandName, ...fields })}\n`);
  return until(() => record.lines.slice(mark).find(line => (line.type === 'ack' || line.type === 'state' || line.type === 'error') && line.seq === seq));
}

(async () => {
  let failed = false;
  try {
    const target = start('target', ['target', '100', '100', '640', '420']); const targetId = await ready(target);
    const parent = processIdentity(process.pid), sessionId = 'dual_validation_123456789';
    const overlay = start('overlay', ['overlay', targetId.hwnd, targetId.pid, targetId.started, parent.pid, parent.started, sessionId], true);
    const hello = await until(() => overlay.lines.find(line => line.type === 'hello')); let epoch = hello.epoch, seq = 1;
    const overlayId = processIdentity(overlay.child.pid); const baseline = pixel(420, 300);
    check(hit(420, 300, targetId, overlayId, null, false).role === 'target', 'pointer-target-hit');
    check(Math.abs(pixel(420, 300).r - baseline.r) <= 1 && Math.abs(pixel(420, 300).g - baseline.g) <= 1 && Math.abs(pixel(420, 300).b - baseline.b) <= 1,
      'transparent-background-preserved', { baseline });
    let reply = await protocol(overlay, sessionId, epoch, seq++, 'mode', { mode: 'draw', tool: 'rectangle', color: '#ff0000', size: 12, highlight: false }); epoch = reply.epoch;
    check(hit(420, 300, targetId, overlayId).role === 'overlay', 'draw-blank-hit');
    const inputBlank = pixel(420, 300); check(inputBlank.r === baseline.r && inputBlank.g === baseline.g && inputBlank.b === baseline.b,
      'input-window-no-visual-effect', { inputBlank });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'stroke', id: 'pen', color: '#ff0000', size: 12, highlight: false, points: [[0.35, 0.5], [0.65, 0.5]] }] }); epoch = reply.epoch;
    await delay(100); const pen = pixel(420, 306); check(pen.r > pen.g + 80 && pen.r > pen.b + 80, 'pen-pixel', { pen });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'stroke', id: 'highlighter', color: '#ffff00', size: 8, highlight: true, points: [[0.35, 0.5], [0.65, 0.5]] }] }); epoch = reply.epoch;
    await delay(100); const highlighter = pixel(420, 306); check(highlighter.r > baseline.r + 40 && highlighter.g > baseline.g + 40 && highlighter.b < baseline.b,
      'highlighter-premultiplied-pixel', { highlighter });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [] }); epoch = reply.epoch;
    await delay(100); const cleared = pixel(420, 306); check(Math.abs(cleared.r - baseline.r) <= 1 && Math.abs(cleared.g - baseline.g) <= 1 && Math.abs(cleared.b - baseline.b) <= 1, 'clear-restores-background', { cleared });
    const laserStroke = { id: 'laser_pixel', color: '#ef4444', size: 4, highlight: false, points: [[.35, .5], [.65, .5]] };
    reply = await protocol(overlay, sessionId, epoch, seq++, 'lasers', { laserRevision: 1, epoch, lasers: [{ stroke: laserStroke, opacity: 1 }] }); epoch = reply.epoch;
    await delay(100); const laserFull = pixel(420, 306);
    reply = await protocol(overlay, sessionId, epoch, seq++, 'lasers', { laserRevision: 2, epoch, lasers: [{ stroke: laserStroke, opacity: .5 }] }); epoch = reply.epoch;
    await delay(100); const laserHalf = pixel(420, 306);
    reply = await protocol(overlay, sessionId, epoch, seq++, 'lasers', { laserRevision: 3, epoch, lasers: [] }); epoch = reply.epoch;
    await delay(100); const laserEmpty = pixel(420, 306);
    const redDelta = value => value.r - baseline.r;
    check(redDelta(laserFull) > redDelta(laserHalf) && redDelta(laserHalf) > 20 && Math.abs(laserEmpty.r - baseline.r) <= 1 &&
      Math.abs(laserEmpty.g - baseline.g) <= 1 && Math.abs(laserEmpty.b - baseline.b) <= 1,
      'laser-opacity-decreases-to-background', { baseline, full: laserFull, half: laserHalf, empty: laserEmpty });
    const shapePixels = value => value.r > value.g + 80 && value.r > value.b + 80;
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'shape', id: 'rectangle', kind: 'rectangle', color: '#ff0000', size: 8, x1: .3, y1: .3, x2: .7, y2: .7 }] }); epoch = reply.epoch;
    await delay(100); const rectanglePixels = [[295, 306], [545, 306], [420, 224], [420, 389]].map(([x, y]) => ({ x, y, ...inkNear(x, y, shapePixels) }));
    check(rectanglePixels.every(value => value.pass), 'rectangle-four-sides', { pixels: rectanglePixels });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'shape', id: 'ellipse', kind: 'ellipse', color: '#ff0000', size: 8, x1: .3, y1: .3, x2: .7, y2: .7 }] }); epoch = reply.epoch;
    await delay(100); const ellipsePixels = [[295, 306], [545, 306], [420, 224], [420, 389]].map(([x, y]) => ({ x, y, ...inkNear(x, y, shapePixels) }));
    check(ellipsePixels.every(value => value.pass), 'ellipse-four-extrema', { pixels: ellipsePixels });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'shape', id: 'arrow', kind: 'arrow', color: '#ff0000', size: 12, x1: .3, y1: .5, x2: .7, y2: .5 }] }); epoch = reply.epoch;
    await delay(100); check([[420, 306], [545, 306], [505, 326], [505, 286]].every(([x, y]) => inkNear(x, y, shapePixels).pass), 'arrow-shaft-head');
    reply = await protocol(overlay, sessionId, epoch, seq++, 'preview', { previewRevision: 1, epoch, hiddenElementIds: ['arrow'] }); epoch = reply.epoch;
    await delay(100); const previewHidden = pixel(420, 306);
    check(Math.abs(previewHidden.r - baseline.r) <= 1 && Math.abs(previewHidden.g - baseline.g) <= 1 && Math.abs(previewHidden.b - baseline.b) <= 1,
      'preview-hidden-pixel', { previewHidden });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'preview', { previewRevision: 2, epoch, hiddenElementIds: [] }); epoch = reply.epoch;
    await delay(100); check(inkNear(420, 306, shapePixels).pass, 'preview-cancel-restores-pixel');
    const stalePreview = await protocol(overlay, sessionId, epoch, seq++, 'preview', { previewRevision: 1, epoch, hiddenElementIds: ['arrow'] });
    check(stalePreview.type === 'error' && stalePreview.code === 'invalid-command', 'preview-old-revision-rejected');
    const occluder = start('occluder', ['occluder', '260', '210', '220', '150']); const occluderId = await ready(occluder);
    await until(() => { const value = hit(340, 280, targetId, overlayId, occluderId, false); return value.role === 'occluder' ? value : null; });
    check(hit(340, 280, targetId, overlayId, occluderId, false).role === 'occluder', 'occluder-hit');
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [{ type: 'shape', id: 'occluded_rectangle', kind: 'rectangle', color: '#ff0000', size: 20, x1: .2, y1: .43, x2: .8, y2: .7 }] }); epoch = reply.epoch;
    await delay(100); const occludedPixel = pixel(340, 280);
    check(occludedPixel.r === 224 && occludedPixel.g === 96 && occludedPixel.b === 32, 'occluder-hole-has-no-ink', { occludedPixel });
    reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', { elements: [] }); epoch = reply.epoch;
    reply = await protocol(overlay, sessionId, epoch, seq++, 'lasers', { laserRevision: 4, epoch, lasers: [{ stroke: laserStroke, opacity: 1 }] }); epoch = reply.epoch;
    const beforeLoss = await protocol(overlay, sessionId, epoch, seq++, 'state'); epoch = beforeLoss.epoch;
    overlay.child.stdin.write('fixture-device-loss\n');
    await delay(150);
    const afterLoss = await protocol(overlay, sessionId, epoch, seq++, 'state'); epoch = afterLoss.epoch;
    check(afterLoss.state === 'unknown' && !afterLoss.input && !afterLoss.visible, 'device-loss-withdraws', { before: beforeLoss.epoch, after: afterLoss.epoch });
    await command(occluder, 'exit'); await until(() => occluder.closed);
    overlay.child.stdin.write('fixture-device-recover\n');
    const recovered = await until(() => overlay.lines.findLast(line => line.type === 'state' && 'eventSeq' in line && line.state === 'active' && line.epoch > epoch)); epoch = recovered.epoch;
    check(recovered.epoch > afterLoss.epoch, 'device-rebuild-new-epoch', { epoch: recovered.epoch });
    await delay(100); const recoveredPixel = pixel(420, 306);
    check(Math.max(recoveredPixel.r, recoveredPixel.g, recoveredPixel.b) - Math.min(recoveredPixel.r, recoveredPixel.g, recoveredPixel.b) <= 3,
      'device-loss-clears-laser', { recoveredPixel });
    const beforeResources = resources(overlay.child.pid);
    const mixed = { elements: [
      { type: 'stroke', id: 'mixed_stroke', color: '#22c55e', size: 4, highlight: false, points: [[.2, .2], [.8, .8]] },
      { type: 'shape', id: 'mixed_rectangle', kind: 'rectangle', color: '#ef4444', size: 4, x1: .1, y1: .1, x2: .3, y2: .3 },
      { type: 'shape', id: 'mixed_ellipse', kind: 'ellipse', color: '#3b82f6', size: 4, x1: .4, y1: .2, x2: .7, y2: .5 },
      { type: 'shape', id: 'mixed_arrow', kind: 'arrow', color: '#a855f7', size: 4, x1: .2, y1: .8, x2: .8, y2: .6 },
    ] };
    for (let i = 0; i < 300; i++) { reply = await protocol(overlay, sessionId, epoch, seq++, 'scene', i % 2 ? { elements: [] } : mixed); epoch = reply.epoch; }
    const afterResources = resources(overlay.child.pid);
    check(afterResources.gdi - beforeResources.gdi <= 4 && afterResources.user - beforeResources.user <= 2, 'resource-loop', { before: beforeResources, after: afterResources });
    await protocol(overlay, sessionId, epoch, seq++, 'close'); await until(() => overlay.closed);
    await command(target, 'exit'); await until(() => target.closed);
  } catch (error) { failed = true; console.log(JSON.stringify({ stage: 'failed', pass: false, reason: error.message })); }
  finally {
    for (const record of children) if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    const end = Date.now() + 4000; while (children.some(record => !record.closed) && Date.now() < end) await delay(20);
    for (const record of children) if (!record.closed) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.closed && !record.forced);
    console.log(JSON.stringify({ stage: 'cleanup', pass: clean, forced: children.filter(record => record.forced).length }));
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

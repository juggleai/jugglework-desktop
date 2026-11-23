const test = require('node:test');
const assert = require('node:assert/strict');
const { INK, strokeOffsets, compositeInk, verifySingleOverlay } = require('./meeting-window-p0-compositor.cjs');

function bitmap(width, height, fill) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = fill.b; buf[i * 4 + 1] = fill.g; buf[i * 4 + 2] = fill.r; buf[i * 4 + 3] = fill.a;
  }
  return buf;
}

const DARK = { b: 45, g: 30, r: 22, a: 255 };
const W = 64, H = 40;

test('stroke offsets stay in bounds, are unique and cover the endpoints', () => {
  const offsets = strokeOffsets({ width: W, height: H }, [{ x0: 10, y0: 20, x1: 50, y1: 20 }], 3);
  assert.ok(offsets.length > 0);
  const keys = new Set(offsets.map(({ x, y }) => `${x},${y}`));
  assert.equal(keys.size, offsets.length);
  assert.ok(offsets.every(({ x, y }) => x >= 0 && y >= 0 && x < W && y < H));
  assert.ok(offsets.some(({ x, y }) => x === 10 && y === 20));
  assert.ok(offsets.some(({ x, y }) => x === 50 && y === 20));
});

test('out-of-bounds strokes are clipped, never wrap', () => {
  const offsets = strokeOffsets({ width: W, height: H }, [{ x0: -5, y0: -5, x1: W + 5, y1: H + 5 }], 1);
  assert.ok(offsets.every(({ x, y }) => x >= 0 && y >= 0 && x < W && y < H));
});

test('bitmap consistency: selected pixels painted and non-ink identical', () => {
  const raw = bitmap(W, H, DARK);
  const offsets = strokeOffsets({ width: W, height: H }, [
    { x0: 8, y0: 8, x1: 8, y1: 32 },   // thin vertical line
    { x0: 8, y0: 8, x1: 40, y1: 8 },   // corner mark
  ], 1);
  const composite = compositeInk(raw, { width: W, height: H }, offsets);
  const result = verifySingleOverlay(raw, composite, { width: W, height: H }, offsets);
  assert.ok(result);
  assert.equal(result.inkRegionDiffers, true);
  assert.equal(result.rawCleanAtInk, true);
  assert.equal(result.nonInkIdentical, true);
  assert.equal(result.nonInkChecked, W * H - result.inkOffsets);
  assert.equal(result.inkOffsets, offsets.length);
});

test('opaque paint is idempotent; these pixels cannot prove composition count', () => {
  const bounds = { width: W, height: H };
  const raw = bitmap(W, H, DARK);
  const before = Buffer.from(raw);
  const offsets = strokeOffsets(bounds, [{ x0: 8, y0: 8, x1: 40, y1: 8 }], 1);
  const once = compositeInk(raw, bounds, offsets);
  const twice = compositeInk(once, bounds, offsets);
  assert.deepEqual(raw, before);
  assert.deepEqual(once, twice);
  assert.equal(verifySingleOverlay(raw, twice, bounds, offsets).inkRegionDiffers, true);
});

test('rejects invalid or excessive raster work before entering loops', () => {
  const bounds = { width: W, height: H };
  const stroke = [{ x0: 0, y0: 0, x1: 10, y1: 10 }];
  for (const thickness of [Infinity, NaN, -1, 1.5, 32]) assert.equal(strokeOffsets(bounds, stroke, thickness), null);
  assert.equal(strokeOffsets(bounds, [{ x0: 0, y0: 0, x1: Number.MAX_SAFE_INTEGER, y1: 0 }]), null);
  assert.equal(strokeOffsets({ width: 100000, height: 100000 }, stroke), null);
});

test('rejects malformed buffers, out-of-bounds or duplicate offsets and full coverage', () => {
  const bounds = { width: W, height: H };
  const raw = bitmap(W, H, DARK);
  assert.equal(compositeInk(raw, null, [{ x: 0, y: 0 }]), null);
  assert.equal(compositeInk({ length: raw.length }, bounds, [{ x: 0, y: 0 }]), null);
  assert.equal(compositeInk(Buffer.alloc(raw.length + 1), bounds, [{ x: 0, y: 0 }]), null);
  for (const offsets of [[null], [{ x: W, y: 0 }], [{ x: -1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 0 }]]) {
    assert.equal(compositeInk(raw, bounds, offsets), null);
    assert.equal(verifySingleOverlay(raw, raw, bounds, offsets), null);
  }
  assert.equal(verifySingleOverlay(Buffer.alloc(4), Buffer.alloc(4), { width: 1, height: 1 }, [{ x: 0, y: 0 }]), null);
});

test('raw already inked at a stroke point fails raw-clean and ink-differs', () => {
  const raw = bitmap(W, H, DARK);
  const offsets = strokeOffsets({ width: W, height: H }, [{ x0: 10, y0: 10, x1: 10, y1: 10 }], 0);
  const i = (10 * W + 10) * 4;
  raw[i] = INK.b; raw[i + 1] = INK.g; raw[i + 2] = INK.r; raw[i + 3] = INK.a;
  const composite = compositeInk(raw, { width: W, height: H }, offsets);
  const result = verifySingleOverlay(raw, composite, { width: W, height: H }, offsets);
  assert.equal(result.rawCleanAtInk, false);
  assert.equal(result.inkRegionDiffers, false);
});

test('a non-ink pixel altered in composite fails non-ink identical', () => {
  const raw = bitmap(W, H, DARK);
  const offsets = strokeOffsets({ width: W, height: H }, [{ x0: 10, y0: 10, x1: 10, y1: 10 }], 0);
  const composite = compositeInk(raw, { width: W, height: H }, offsets);
  composite[0] ^= 0xff; // corrupt a non-ink pixel
  const result = verifySingleOverlay(raw, composite, { width: W, height: H }, offsets);
  assert.equal(result.nonInkIdentical, false);
});

test('rejects empty offsets and malformed buffers', () => {
  assert.equal(verifySingleOverlay(bitmap(W, H, DARK), bitmap(W, H, DARK), { width: W, height: H }, []), null);
  assert.equal(compositeInk(Buffer.alloc(3), { width: W, height: H }, []), null);
  assert.equal(strokeOffsets({ width: 0, height: H }, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]), null);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { edges, intersection, normalizePoint, rectFromEdges, toLocalRegion } = require('./meeting-semantic-overlay-geometry.cjs');

test('physical rectangles preserve large and negative virtual-screen coordinates', () => {
  assert.deepEqual(rectFromEdges(-30000, -20000, 30000, 20000), { x: -30000, y: -20000, width: 60000, height: 40000 });
  assert.deepEqual(edges({ x: -2000000000, y: -100, width: 100000000, height: 200 }), {
    left: -2000000000, top: -100, right: -1900000000, bottom: 100,
  });
});

test('invalid, zero-sized, unsafe and overflowing rectangles fail closed', () => {
  for (const action of [
    () => rectFromEdges(0, 0, 0, 1),
    () => rectFromEdges(-2147483648, 0, 2147483647, 1),
    () => edges({ x: 2147483640, y: 0, width: 10, height: 1 }),
    () => edges({ x: 0, y: 0, width: 0, height: 1 }),
    () => edges({ x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 1 }),
  ]) assert.throws(action, RangeError);
});

test('intersection and local region conversion clip before subtracting origins', () => {
  const frame = { x: -1920, y: -200, width: 1920, height: 1200 };
  const region = { x: -2000, y: 100, width: 500, height: 400 };
  assert.deepEqual(intersection(frame, region), { x: -1920, y: 100, width: 420, height: 400 });
  assert.deepEqual(toLocalRegion(frame, region), { x: 0, y: 300, width: 420, height: 400 });
  assert.equal(toLocalRegion(frame, { x: 1, y: 1, width: 1, height: 1 }), null);
});

test('input normalization clamps every boundary and rejects zero dimensions', () => {
  assert.deepEqual(normalizePoint({ x: 0, y: 0 }, { width: 641, height: 421 }), { x: 0, y: 0 });
  assert.deepEqual(normalizePoint({ x: 640, y: 420 }, { width: 641, height: 421 }), { x: 1, y: 1 });
  assert.deepEqual(normalizePoint({ x: -1, y: 999 }, { width: 641, height: 421 }), { x: 0, y: 1 });
  assert.deepEqual(normalizePoint({ x: 5, y: 7 }, { width: 1, height: 1 }), { x: 1, y: 1 });
  assert.throws(() => normalizePoint({ x: 0, y: 0 }, { width: 0, height: 1 }), RangeError);
});

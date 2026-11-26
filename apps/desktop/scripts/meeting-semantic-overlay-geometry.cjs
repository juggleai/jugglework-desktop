'use strict';

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < INT_MIN || value > INT_MAX) throw new RangeError(name);
  return value;
}

function rectFromEdges(left, top, right, bottom) {
  [left, top, right, bottom].forEach((value, index) => integer(value, ['left', 'top', 'right', 'bottom'][index]));
  const width = right - left;
  const height = bottom - top;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > INT_MAX || height > INT_MAX) {
    throw new RangeError('invalid rectangle');
  }
  return { x: left, y: top, width, height };
}

function edges(rect) {
  const x = integer(rect.x, 'x');
  const y = integer(rect.y, 'y');
  const width = integer(rect.width, 'width');
  const height = integer(rect.height, 'height');
  if (width <= 0 || height <= 0) throw new RangeError('zero-sized rectangle');
  const right = x + width;
  const bottom = y + height;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom) || right > INT_MAX || bottom > INT_MAX) throw new RangeError('rectangle overflow');
  return { left: x, top: y, right, bottom };
}

function intersection(first, second) {
  const a = edges(first);
  const b = edges(second);
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? rectFromEdges(left, top, right, bottom) : null;
}

function toLocalRegion(frame, region) {
  const hit = intersection(frame, region);
  if (!hit) return null;
  return rectFromEdges(hit.x - frame.x, hit.y - frame.y, hit.x - frame.x + hit.width, hit.y - frame.y + hit.height);
}

function normalizePoint(point, size) {
  const width = integer(size.width, 'width');
  const height = integer(size.height, 'height');
  if (width <= 0 || height <= 0) throw new RangeError('zero-sized input');
  const x = integer(point.x, 'x');
  const y = integer(point.y, 'y');
  return {
    x: Math.max(0, Math.min(1, x / Math.max(1, width - 1))),
    y: Math.max(0, Math.min(1, y / Math.max(1, height - 1))),
  };
}

module.exports = { edges, intersection, normalizePoint, rectFromEdges, toLocalRegion };

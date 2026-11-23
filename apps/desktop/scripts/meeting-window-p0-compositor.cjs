// Fixture-only compositor primitives. No application imports or production
// feature flags. Bitmaps are BGRA (Electron nativeImage.toBitmap layout).
const INK = Object.freeze({ b: 200, g: 53, r: 255, a: 255 }); // #ff35c8
const BYTES = 4;

function validBounds(bounds) {
  return bounds && Number.isSafeInteger(bounds.width) && Number.isSafeInteger(bounds.height) &&
    bounds.width > 0 && bounds.height > 0 && bounds.width * bounds.height <= 3840 * 2160;
}

function validBitmap(bitmap, bounds) {
  return validBounds(bounds) && Buffer.isBuffer(bitmap) && bitmap.length === bounds.width * bounds.height * BYTES;
}

function validOffsets(offsets, bounds) {
  if (!Array.isArray(offsets) || offsets.length === 0 || offsets.length > bounds.width * bounds.height) return false;
  const seen = new Set();
  for (const point of offsets) {
    if (!point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
        point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height) return false;
    const key = point.y * bounds.width + point.x;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function linePoints(x0, y0, x1, y1) {
  // Integer Bresenham; both endpoints included.
  const points = [];
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    points.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return points;
}

function strokeOffsets(bounds, strokes, thickness = 3) {
  if (!validBounds(bounds) || !Array.isArray(strokes) || strokes.length > 64 ||
      !Number.isSafeInteger(thickness) || thickness < 0 || thickness > 31) return null;
  const r = Math.max(0, Math.floor(thickness / 2));
  let work = 0;
  for (const stroke of strokes) {
    if (!stroke || !['x0', 'y0', 'x1', 'y1'].every((k) => Number.isSafeInteger(stroke[k]) && Math.abs(stroke[k]) <= 16384)) return null;
    work += (Math.max(Math.abs(stroke.x1 - stroke.x0), Math.abs(stroke.y1 - stroke.y0)) + 1) * (2 * r + 1) ** 2;
    if (work > 8_000_000) return null;
  }
  const seen = new Set();
  const offsets = [];
  for (const stroke of strokes) {
    if (!stroke || !['x0', 'y0', 'x1', 'y1'].every((k) => Number.isSafeInteger(stroke[k]))) return null;
    for (const [cx, cy] of linePoints(stroke.x0, stroke.y0, stroke.x1, stroke.y1)) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) continue;
          const key = y * bounds.width + x;
          if (seen.has(key)) continue;
          seen.add(key);
          offsets.push({ x, y });
        }
      }
    }
  }
  return offsets;
}

function compositeInk(bitmap, bounds, offsets) {
  if (!validBitmap(bitmap, bounds) || !validOffsets(offsets, bounds)) return null;
  const out = Buffer.from(bitmap);
  for (const { x, y } of offsets) {
    const i = (y * bounds.width + x) * BYTES;
    out[i] = INK.b; out[i + 1] = INK.g; out[i + 2] = INK.r; out[i + 3] = INK.a;
  }
  return out;
}

// Pixel consistency only. Opaque paint is idempotent: this cannot establish
// how many times a renderer composed ink, or whether a live stream fed it back.
function verifySingleOverlay(raw, composite, bounds, offsets) {
  if (!validBitmap(raw, bounds) || !validBitmap(composite, bounds) || !validOffsets(offsets, bounds) ||
      offsets.length === bounds.width * bounds.height) return null;
  let inkRegionDiffers = true, rawCleanAtInk = true;
  const inkSet = new Set(offsets.map(({ x, y }) => y * bounds.width + x));
  for (const { x, y } of offsets) {
    const i = (y * bounds.width + x) * BYTES;
    const same = composite[i] === raw[i] && composite[i + 1] === raw[i + 1] &&
      composite[i + 2] === raw[i + 2] && composite[i + 3] === raw[i + 3];
    const isInk = composite[i] === INK.b && composite[i + 1] === INK.g &&
      composite[i + 2] === INK.r && composite[i + 3] === INK.a;
    if (!isInk || same) inkRegionDiffers = false;
    if (raw[i] === INK.b && raw[i + 1] === INK.g && raw[i + 2] === INK.r && raw[i + 3] === INK.a) rawCleanAtInk = false;
  }
  let nonInkIdentical = true, nonInkChecked = 0;
  for (let y = 0; y < bounds.height; y++) {
    for (let x = 0; x < bounds.width; x++) {
      const key = y * bounds.width + x;
      if (inkSet.has(key)) continue;
      const i = key * BYTES;
      nonInkChecked++;
      if (raw[i] !== composite[i] || raw[i + 1] !== composite[i + 1] ||
          raw[i + 2] !== composite[i + 2] || raw[i + 3] !== composite[i + 3]) nonInkIdentical = false;
    }
  }
  return { inkOffsets: offsets.length, inkRegionDiffers, rawCleanAtInk, nonInkIdentical, nonInkChecked };
}

module.exports = { INK, strokeOffsets, compositeInk, verifySingleOverlay };

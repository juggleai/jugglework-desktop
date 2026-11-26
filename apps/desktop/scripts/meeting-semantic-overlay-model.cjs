'use strict';

function intersect(a, b) {
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function subtract(rectangles, cut) {
  const output = [];
  for (const source of rectangles) {
    const hit = intersect(source, cut);
    if (!hit) { output.push(source); continue; }
    if (hit.y > source.y) output.push({ x: source.x, y: source.y, width: source.width, height: hit.y - source.y });
    if (hit.y + hit.height < source.y + source.height) output.push({ x: source.x, y: hit.y + hit.height, width: source.width, height: source.y + source.height - hit.y - hit.height });
    if (hit.x > source.x) output.push({ x: source.x, y: hit.y, width: hit.x - source.x, height: hit.height });
    if (hit.x + hit.width < source.x + source.width) output.push({ x: hit.x + hit.width, y: hit.y, width: source.x + source.width - hit.x - hit.width, height: hit.height });
  }
  return output;
}

function transition(state, event) {
  if (state.terminal) return { ...state, input: false };
  if (event.type === 'resize') return { ...state, epoch: state.epoch + 1, input: false, visible: false, terminal: true };
  if (event.type === 'untrusted' || event.type === 'minimize') return { ...state, input: false, visible: false, trusted: false };
  if (event.type === 'snapshot') return { ...state, epoch: state.epoch + 1, input: false, visible: false, trusted: true, committed: false };
  if (event.type === 'commit') return { ...state, input: false, visible: state.trusted, committed: state.trusted };
  if (event.type === 'enable') return { ...state, input: state.trusted && state.committed && state.mode === 'draw' };
  if (event.type === 'mode') return { ...state, mode: event.mode, input: false };
  return state;
}

function classifyOccluder(value) {
  if (!value || !value.visible || value.minimized) return 'ignore';
  if (!value.frameTrusted || value.topmost || value.layered || value.cloaked !== false || value.region !== 'none') return 'unknown';
  return 'rectangle';
}

function geometryTransition(previous, next) {
  if (!previous || !next || previous.width <= 0 || previous.height <= 0 || next.width <= 0 || next.height <= 0 || next.dpi <= 0) return 'untrusted';
  if (previous.dpi !== next.dpi) return 'dpi-change';
  if (previous.width !== next.width || previous.height !== next.height) return 'resize';
  return previous.x === next.x && previous.y === next.y ? 'same' : 'move';
}

module.exports = { classifyOccluder, geometryTransition, intersect, subtract, transition };

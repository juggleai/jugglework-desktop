import { expect, test } from "bun:test";
import { createSceneSaver, parseWhiteboardScene } from "../src/react-app/domains/meeting/whiteboard/scene";

const scene = (extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "excalidraw", version: 2, source: "local", elements: [{ id: "a" }],
  appState: { viewBackgroundColor: "#fff", selectedElementIds: { a: true }, collaborators: {} }, files: {}, ...extra,
});

test("parses native scenes and drops transient view state", () => {
  const parsed = parseWhiteboardScene(scene());
  expect(parsed?.elements).toEqual([{ id: "a" }]);
  expect(parsed?.appState).toEqual({ viewBackgroundColor: "#fff" });
});

test("empty, corrupt or foreign content starts a fresh board", () => {
  expect(parseWhiteboardScene(null)).toBeNull();
  expect(parseWhiteboardScene("{broken")).toBeNull();
  expect(parseWhiteboardScene(JSON.stringify({ type: "tldraw", elements: [] }))).toBeNull();
  expect(parseWhiteboardScene(scene({ elements: "x" }))).toBeNull();
});

function fakeTimers() {
  const queue = new Map<number, () => void>();
  let id = 0;
  return {
    timers: { set: ((fn: () => void) => { queue.set(++id, fn); return id; }) as unknown as typeof setTimeout,
      clear: ((handle: number) => { queue.delete(handle); }) as unknown as typeof clearTimeout },
    fire() { const fns = [...queue.values()]; queue.clear(); fns.forEach((fn) => fn()); },
    size: () => queue.size,
  };
}

test("debounces to the latest scene and only saves once", () => {
  const saved: string[] = [], t = fakeTimers();
  const saver = createSceneSaver(async (json) => { saved.push(json); }, () => true, 500, t.timers);
  saver.schedule("1"); saver.schedule("2"); saver.schedule("3");
  expect(t.size()).toBe(1);
  t.fire();
  expect(saved).toEqual(["3"]);
  expect(saver.hasPending()).toBe(false);
});

test("flushSync writes the unsaved scene synchronously and cancels the timer", () => {
  const async: string[] = [], sync: string[] = [], t = fakeTimers();
  const saver = createSceneSaver(async (json) => { async.push(json); }, (json) => { sync.push(json); return true; }, 500, t.timers);
  expect(saver.flushSync()).toBe(false);
  saver.schedule("final");
  expect(saver.flushSync()).toBe(true);
  t.fire();
  expect(sync).toEqual(["final"]);
  expect(async).toEqual([]);
});

test("save failures are reported, not thrown", async () => {
  const t = fakeTimers();
  const errors: unknown[] = [];
  const saver = createSceneSaver(async () => { throw new Error("disk full"); }, () => false, 500, t.timers);
  saver.onError((error) => errors.push(error));
  saver.schedule("x");
  t.fire();
  await Promise.resolve(); await Promise.resolve();
  expect(String(errors[0])).toContain("disk full");
});

test("default timers call the global setTimeout with the right receiver", async () => {
  // Browsers throw "Illegal invocation" when setTimeout is called as a method of another object.
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realSet(...args);
  } as typeof setTimeout;
  globalThis.clearTimeout = function (this: unknown, handle?: Parameters<typeof clearTimeout>[0]) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realClear(handle);
  } as typeof clearTimeout;
  try {
    const saved: string[] = [];
    const saver = createSceneSaver(async (json) => { saved.push(json); }, () => true, 1);
    saver.schedule("a"); saver.schedule("b");
    await new Promise((resolve) => realSet(resolve, 20));
    expect(saved).toEqual(["b"]);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

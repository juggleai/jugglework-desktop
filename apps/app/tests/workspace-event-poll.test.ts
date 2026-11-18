import { expect, test } from "bun:test";
import { startWorkspaceEventPoll } from "../src/react-app/shell/workspace-event-poll";

test("workspace polling coalesces focus changes, backs off in the background and stops cleanly", async () => {
  const win = Object.getOwnPropertyDescriptor(globalThis, "window");
  const doc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const timers = new Map<number, number>();
  let counter = 0;
  let foreground = true;
  let focused = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: (_fn: () => void, delay: number) => { timers.set(++counter, delay); return counter; },
    clearTimeout: (id: number) => timers.delete(id),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    visibilityState: "visible", hasFocus: () => focused,
  } });
  try {
    const reads: Array<() => void> = [];
    const poll = startWorkspaceEventPoll(() => new Promise<void>(resolve => reads.push(resolve)), () => foreground);
    await poll.refresh();
    await poll.refresh();
    expect(reads.length).toBe(1);
    reads.shift()!();
    await Promise.resolve();
    expect([...timers.values()]).toEqual([0]);
    async function finishPoll() {
      const finished = poll.refresh();
      reads.shift()!();
      await finished;
      return [...timers.values()];
    }
    expect(await finishPoll()).toEqual([3_000]);
    foreground = false;
    expect(await finishPoll()).toEqual([30_000]);
    foreground = true;
    focused = false;
    expect(await finishPoll()).toEqual([30_000]);
    focused = true;
    expect(await finishPoll()).toEqual([3_000]);
    const final = poll.refresh();
    poll.stop();
    reads.shift()!();
    await final;
    await poll.refresh();
    expect(timers.size).toBe(0);
    expect(reads.length).toBe(0);
  } finally {
    if (win) Object.defineProperty(globalThis, "window", win); else Reflect.deleteProperty(globalThis, "window");
    if (doc) Object.defineProperty(globalThis, "document", doc); else Reflect.deleteProperty(globalThis, "document");
  }
});

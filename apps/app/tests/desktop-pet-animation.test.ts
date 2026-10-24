import { expect, test } from "bun:test";
import { createPetAnimator, selectPetBaseAction, type PetAnimation } from "../src/pet/animation";
import type { PetTask } from "../src/app/lib/desktop-pet-types";

function fixture() {
  let now = 0, serial = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const frames: Array<[PetAnimation, number]> = [];
  const clock = { now: () => now, setTimeout: ((run: () => void, delay: number) => { const id = ++serial; timers.set(id, { at: now + delay, run }); return id; }) as unknown as typeof setTimeout, clearTimeout: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout };
  const player = createPetAnimator((action, frame) => frames.push([action, frame]), false, clock);
  const advance = (duration: number) => {
    const until = now + duration;
    while (true) { const next = [...timers].sort((a,b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > until) break; now = next[1].at; timers.delete(next[0]); next[1].run(); }
    now = until;
  };
  return { player, advance, frames, timers, latest: () => frames.at(-1) };
}

const task = (state: PetTask["state"]): PetTask => ({ key: state, workspaceId: "w", sessionId: state, project: "项目", title: "任务", turnKey: "turn", state, statusText: "", canStop: false });
const idle = { tasks: [] as PetTask[], syncing: false, mainComposerEditing: false, voicePhase: "idle" };

test("opening an empty pet editor or focusing the main composer immediately shows work", () => {
  expect(selectPetBaseAction(idle, true)).toBe("seated-working");
  expect(selectPetBaseAction({ ...idle, mainComposerEditing: true }, false)).toBe("seated-working");
  expect(selectPetBaseAction(idle, false)).toBe("typing");
});

test("waiting across tasks takes priority over editing, voice and running work", () => {
  expect(selectPetBaseAction({ ...idle, mainComposerEditing: true, voicePhase: "transcribing", tasks: [task("running"), task("waiting")] }, true)).toBe("waiting");
});

test("completion does not hide other work, while unrelated partial sync does not invent work", () => {
  expect(selectPetBaseAction({ ...idle, tasks: [task("completed"), task("running")] }, false)).toBe("seated-working");
  expect(selectPetBaseAction({ ...idle, tasks: [task("reconciling")] }, false)).toBe("seated-working");
  const partial = { ...idle, partial: true, tasks: [task("completed")] };
  expect(selectPetBaseAction(partial, false)).toBe("typing");
  expect(selectPetBaseAction({ ...idle, voicePhase: "recording" }, false)).toBe("seated-working");
});

test("hover playback restores the latest waiting priority after its typing cycle", () => {
  const f = fixture(); f.player.setBase(selectPetBaseAction(idle, true));
  f.player.enter(); f.advance(100); f.player.leave();
  f.player.setBase(selectPetBaseAction({ ...idle, tasks: [task("waiting")] }, true));
  f.advance(2660); expect(f.latest()?.[0]).toBe("typing");
  f.advance(1560); expect(f.latest()?.[0]).toBe("waiting"); f.player.dispose();
});

test("hover interrupts work for exactly two complete jumps then holds typing", () => {
  const f = fixture(); f.player.setBase("seated-working"); f.player.enter();
  f.advance(2760);
  expect(f.frames.filter(([action]) => action === "celebrate").map(([,frame]) => frame)).toEqual([0,1,2,3,4,0,1,2,3,4]);
  expect(f.latest()?.[0]).toBe("typing");
  f.advance(4000); f.player.enter(); expect(f.latest()?.[0]).toBe("typing");
  f.player.leave(); expect(f.latest()?.[0]).toBe("seated-working"); f.player.dispose(); expect(f.timers.size).toBe(0);
});
test("leaving midjump finishes two jumps and at least one typing loop; re-entry cannot cut it short", () => {
  const f = fixture(); f.player.setBase("waiting"); f.player.enter(); f.advance(100); f.player.leave();
  f.advance(2660); expect(f.latest()?.[0]).toBe("typing");
  f.advance(500); f.player.enter(); f.advance(400); f.player.leave(); f.advance(659);
  expect(f.latest()?.[0]).toBe("typing"); f.advance(1); expect(f.latest()?.[0]).toBe("waiting"); f.player.dispose();
});
test("drag/reduced-motion cancels decoration and uses a static business frame", () => {
  const f = fixture(); f.player.setBase("seated-working"); f.player.enter(); f.player.cancel();
  expect(f.latest()).toEqual(["seated-working",0]); f.player.setReduced(true); const count = f.frames.length;
  f.advance(5000); expect(f.frames.length).toBe(count); f.player.dispose();
});

test("system hiding pauses all animation timers and resumes the business action", () => {
  const f = fixture(); f.player.setBase("seated-working"); f.player.enter(); f.advance(200);
  f.player.setPaused(true); expect(f.timers.size).toBe(0);
  f.advance(10_000); expect(f.latest()).toEqual(["seated-working",0]);
  f.player.setPaused(false); f.advance(150); expect(f.latest()).toEqual(["seated-working",1]); f.player.dispose();
});

import { afterEach, expect, mock, test } from "bun:test";
import type { MeetingVideoEffects } from "../src/react-app/domains/meeting/video-effects";

mock.module("../src/react-app/domains/meeting/meeting-background-catalog", () => ({
  MEETING_BACKGROUND_PRESETS: [{ id: "scene-room", label: "Room", url: "/room.jpg" }],
}));
const { readMeetingVideoEffects: read, writeMeetingVideoEffects: write, subscribeMeetingVideoEffects: subscribe } =
  await import("../src/react-app/domains/meeting/video-effects-preferences");

const key = "jugglework.meeting.video-effects.v1";
const defaults: MeetingVideoEffects = { background: "none", avatar: "none", filter: "none", beauty: 0 };
const original = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});

function setup() {
  const values = new Map<string, string>();
  const win = Object.assign(new EventTarget(), { localStorage: {
    getItem: (id: string) => values.get(id) ?? null,
    setItem: (id: string, value: string) => values.set(id, value),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  return { win, values, storageEvent: (id: string | null) => win.dispatchEvent(Object.assign(new Event("storage"), { key: id })) };
}

test("reads v1 preferences without migration and validates photo ids without persisting image data", () => {
  const { values } = setup();
  expect(read()).toEqual(defaults);
  for (const background of ["none", "studio", "sky", "blur", "scene-room", "custom-4c06_a-1"] as const) {
    const expected = { ...defaults, background, avatar: "cat", beauty: 13, filter: "mono" } as const;
    values.set(key, JSON.stringify({ ...expected, beauty: 12.6 }));
    expect(read()).toEqual(expected);
    write(expected);
    expect(JSON.parse(values.get(key)!)).toEqual(expected);
  }
  for (const background of ["scene-unlisted", "custom-", "custom-../x", "custom-data:image/png", "https://test.invalid", 42, null]) {
    values.set(key, JSON.stringify({ background }));
    expect(read()).toEqual(defaults);
  }
});

test("subscribers read persisted settings on same-window edits and other-window storage changes", () => {
  const { values, storageEvent, win } = setup();
  const changed = mock(() => read().background);
  const unsubscribe = subscribe(changed);
  write({ ...defaults, background: "scene-room" });
  expect(changed.mock.results[0]?.value).toBe("scene-room");
  values.set(key, JSON.stringify({ background: "custom-example" }));
  storageEvent("other");
  storageEvent(key);
  expect(changed.mock.results[1]?.value).toBe("custom-example");
  values.clear();
  storageEvent(null);
  expect(changed.mock.results[2]?.value).toBe("none");
  win.localStorage.setItem = () => { throw new Error("storage unavailable"); };
  expect(() => write({ ...defaults, background: "blur" })).toThrow("storage unavailable");
  unsubscribe();
  storageEvent(key);
  expect(changed).toHaveBeenCalledTimes(3);
});

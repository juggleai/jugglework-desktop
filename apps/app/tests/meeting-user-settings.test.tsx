import { afterAll, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { MeetingPreferences } from "../src/react-app/domains/meeting/meeting-preferences";

let prefs: MeetingPreferences = { meetingReminders: true, participantSounds: false, defaultMic: false, defaultCamera: false, mirrorPreview: true,
  outputVolume: 100, shareQuality: "balanced", microphoneId: "", cameraId: "", speakerId: "" };
const listeners = new Set<() => void>();
mock.module("../src/react-app/domains/meeting/meeting-preferences", () => ({
  readMeetingPreferences: () => prefs,
  updateMeetingPreferences: (patch: Partial<MeetingPreferences>) => { prefs = { ...prefs, ...patch }; listeners.forEach(fn => fn()); },
  subscribeMeetingPreferences: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
}));
mock.module("../src/react-app/domains/meeting/video-effects-preferences", () => ({
  readMeetingVideoEffects: () => ({ background: "none", avatar: "none", beauty: 0, filter: "none" }),
  subscribeMeetingVideoEffects: () => () => {}, writeMeetingVideoEffects: mock(),
}));
mock.module("../src/react-app/domains/meeting/meeting-background-catalog", () => ({ MEETING_BACKGROUND_PRESETS: [] }));
mock.module("../src/react-app/domains/meeting/meeting-background-imports", () => ({
  listImportedBackgrounds: async () => [], importMeetingBackground: mock(), deleteImportedBackground: mock(),
}));
const { MeetingUserSettings, useMeetingUserPreferences } = await import("../src/react-app/domains/meeting/meeting-user-settings");
const capture = mock();
const enumerate = mock(async () => [
  { deviceId: "mic", label: "Desk mic", kind: "audioinput" }, { deviceId: "speaker", label: "Headset", kind: "audiooutput" },
  { deviceId: "camera", label: "Webcam", kind: "videoinput" },
]);
const originals = new Map(["IS_REACT_ACT_ENVIRONMENT", "navigator", "HTMLMediaElement"].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
Object.defineProperties(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  navigator: { configurable: true, value: { mediaDevices: { getUserMedia: capture, enumerateDevices: enumerate } } },
  HTMLMediaElement: { configurable: true, value: class {} },
});
afterAll(() => {
  for (const [k, d] of originals) { if (d) Object.defineProperty(globalThis, k, d); else Reflect.deleteProperty(globalThis, k); }
});

function Harness({ prejoin = false, room = false }: { prejoin?: boolean; room?: boolean }) {
  return <MeetingUserSettings entry={room ? "room" : "prejoin"} prefs={useMeetingUserPreferences()} camera
    preview={<video />} prejoin={prejoin ? { heading: null, controls: null } : undefined} />;
}

test("prejoin keeps the existing preview across settings; device pickers only enumerate and save", async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<Harness prejoin />); });
  const video = tree.root.findByType("video");
  const selectCategory = async (name: string) => {
    const button = tree.root.findByType("nav").findAllByType("button").find(b => b.findByType("span").children.includes(name))!;
    await act(async () => button.props.onClick());
  };
  try {
    await act(async () => tree.update(<Harness />));
    expect(tree.root.findByType("h3").children).toEqual(["特效"]);
    expect(tree.root.findByType("nav").findAllByType("button").map(b => b.findByType("span").children.join("")))
      .toEqual(["常规", "音频", "视频", "共享", "特效", "录制"]);
    expect(enumerate).not.toHaveBeenCalled();
    await selectCategory("常规");
    const toggle = (label: string) => tree.root.findAllByType("label").find(l => l.children.includes(label))!.findByType("input").props.onChange({ currentTarget: { checked: true } });
    await act(async () => toggle("参会者进出会议声音提醒"));
    expect(prefs.participantSounds).toBe(true);
    await act(async () => toggle("默认开启麦克风"));
    expect(prefs.defaultMic).toBe(true);
    await selectCategory("音频");
    const [mic, speaker] = tree.root.findAllByType("select");
    expect(speaker.props.disabled).toBe(true);
    expect(mic.findAllByType("option").map(o => o.props.value)).toEqual(["", "mic"]);
    await act(async () => { mic.props.onChange({ currentTarget: { value: "mic" } }); tree.root.findByProps({ type: "range" }).props.onChange({ currentTarget: { valueAsNumber: 55 } }); });
    expect(prefs).toMatchObject({ microphoneId: "mic", outputVolume: 55 });
    await selectCategory("视频");
    await act(async () => tree.root.findByType("select").props.onChange({ currentTarget: { value: "camera" } }));
    expect(prefs.cameraId).toBe("camera");
    await selectCategory("共享");
    await act(async () => tree.root.findByType("select").props.onChange({ currentTarget: { value: "motion" } }));
    expect(prefs.shareQuality).toBe("motion");
    await selectCategory("录制");
    expect(tree.root.findByType("section").findAllByType("input")).toHaveLength(0);
    expect(tree.root.findByProps({ className: "capability-note" }).children.join("")).toContain("当前版本");
    await act(async () => tree.update(<Harness prejoin />));
    expect(tree.root.findByType("video")).toBe(video);
    await act(async () => tree.update(<Harness />));
    expect(tree.root.findByType("h3").children).toEqual(["特效"]);
    expect(capture).not.toHaveBeenCalled();
  } finally { await act(async () => tree.unmount()); }
  expect(listeners.size).toBe(0);
});

test("room opens general settings and a sink-capable host can select the speaker", async () => {
  Object.defineProperty(globalThis, "HTMLMediaElement", { configurable: true, value: class { setSinkId() {} } });
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<Harness room />); });
  try {
    expect(tree.root.findByType("h3").children).toEqual(["常规"]);
    await act(async () => tree.root.findByType("nav").findAllByType("button")[1].props.onClick());
    const speaker = tree.root.findAllByType("select")[1];
    expect(speaker.props.disabled).toBe(false);
    await act(async () => speaker.props.onChange({ currentTarget: { value: "speaker" } }));
    expect(prefs.speakerId).toBe("speaker");
  } finally { await act(async () => tree.unmount()); }
});

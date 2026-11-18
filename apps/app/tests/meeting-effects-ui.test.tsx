import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { MeetingVideoEffects } from "../src/react-app/domains/meeting/video-effects";

const original: MeetingVideoEffects = { background: "none", avatar: "none", beauty: 0, filter: "none" };
let value = original;
const listeners = new Set<() => void>();
function write(next: MeetingVideoEffects) { value = next; listeners.forEach(fn => fn()); }
const persist = mock(write);
mock.module("../src/react-app/domains/meeting/video-effects-preferences", () => ({
  readMeetingVideoEffects: () => value, writeMeetingVideoEffects: persist,
  subscribeMeetingVideoEffects: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
}));
const photo = { id: "scene-coast", label: "海岸", url: "/backgrounds/coast.jpg" } as const;
const local = { id: "custom-room", label: "书房", url: "data:image/png;base64,eA==" } as const;
mock.module("../src/react-app/domains/meeting/meeting-background-catalog", () => ({ MEETING_BACKGROUND_PRESETS: [photo] }));
const list = mock(async () => [local]);
const add = mock(async (_file: File) => local);
const remove = mock(async (_id: string) => {});
mock.module("../src/react-app/domains/meeting/meeting-background-imports", () => ({
  listImportedBackgrounds: list, importMeetingBackground: add, deleteImportedBackground: remove,
}));
const permissions = mock(async () => {});
let devices = { microphoneId: "", cameraId: "" };
mock.module("../src/react-app/domains/meeting/meeting-preferences", () => ({ readMeetingPreferences: () => devices }));
mock.module("../src/react-app/domains/meeting/media-permission", () => ({ ensureMeetingMediaPermissions: permissions }));
const raw = { stop: mock() };
const processed = { track: { id: "processed" }, stop: mock() };
const capture = mock(async () => ({ getTracks: () => [raw], getVideoTracks: () => [raw] }));
const processTrack = mock(async (_raw: unknown, _read: () => MeetingVideoEffects) => processed);
mock.module("../src/react-app/domains/meeting/video-effects", () => ({ createMeetingEffectTrack: processTrack }));
const { MeetingEffectSettings } = await import("../src/react-app/domains/meeting/meeting-effect-settings");
const { startPrejoinPreview } = await import("../src/react-app/domains/meeting/prejoin-preview");

const originals = new Map(["IS_REACT_ACT_ENVIRONMENT", "navigator", "MediaStream"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperties(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  navigator: { configurable: true, value: { mediaDevices: { getUserMedia: capture } } },
  MediaStream: { configurable: true, value: class { constructor(public tracks: unknown[]) {} } },
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
beforeEach(() => { value = original; for (const fn of [list, add, remove, persist, permissions, capture, processTrack, raw.stop, processed.stop]) fn.mockClear(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("camera-off settings persist selections, reset all effects and never capture", async () => {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<MeetingEffectSettings camera={false} />); });
  const button = (name: string) => tree.root.findAllByType("button").find(node => node.props["aria-label"] === name || node.children.includes(name))!;
  expect(tree.root.findByProps({ role: "status" }).children.join("")).toContain("摄像头已关闭");
  const click = (name: string) => act(async () => { button(name).props.onClick(); });
  for (const name of ["天空", "虚拟形象", "机器人", "滤镜", "冷色", "美颜"]) await click(name);
  await act(async () => { tree.root.findByProps({ type: "range" }).props.onChange({ currentTarget: { valueAsNumber: 42 } }); });
  expect(value).toEqual({ background: "sky", avatar: "robot", filter: "cool", beauty: 42 });
  await click("虚拟形象");
  expect(button("机器人").props["aria-pressed"]).toBe(true);
  await act(async () => { button("恢复原始").props.onClick(); });
  expect(value).toEqual(original);
  expect(permissions).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
  expect(listeners.size).toBe(0);
});

test("gallery presents labeled controls in order and selects a local file without capture or upload", async () => {
  list.mockResolvedValueOnce([]);
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  const openPicker = mock();
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<MeetingEffectSettings camera={false} />, {
    createNodeMock: el => el.type === "input" ? { click: openPicker } : null,
  }); });
  try {
    const gallery = tree.root.findByProps({ className: "background-gallery" });
    const button = (name: string) => gallery.findByProps({ "aria-label": name });
    expect(gallery.findAllByType("button").map(b => b.props["aria-label"]))
      .toEqual(["关闭", "导入本机", "整幅模糊", photo.label, "演播室", "天空"]);
    expect(button("关闭").props["aria-pressed"]).toBe(true);
    await act(async () => button("整幅模糊").props.onClick());
    expect(value.background).toBe("blur");
    await act(async () => button(photo.label).props.onClick());
    expect(value.background).toBe(photo.id);
    await act(async () => button("导入本机").props.onClick());
    expect(openPicker).toHaveBeenCalledTimes(1);
    const file = new File(["image"], "书房.png", { type: "image/png" });
    await act(async () => tree.root.findByProps({ type: "file" }).props.onChange({ currentTarget: { files: [file], value: file.name } }));
    expect(add).toHaveBeenCalledWith(file);
    expect(value.background).toBe(local.id);
    expect(button(local.label).props["aria-pressed"]).toBe(true);
    expect(button(local.label).findByType("img").props.src).toBe(local.url);
    expect(permissions).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); await act(async () => tree.unmount()); }
});

test("deletion requires a successful studio switch; failed deletion keeps the tile for retry", async () => {
  value = { ...original, background: local.id, beauty: 33 };
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<MeetingEffectSettings camera={false} />); });
  try {
    const erase = () => act(async () => tree.root.findByProps({ "aria-label": `删除 ${local.label}` }).props.onClick());
    persist.mockImplementationOnce(() => { throw new Error("quota"); });
    await erase();
    expect(remove).not.toHaveBeenCalled();
    expect(value.background).toBe(local.id);
    expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("无法保存");
    let backgroundAtDelete: string | undefined;
    remove.mockImplementationOnce(async () => { backgroundAtDelete = value.background; throw new Error("storage"); });
    await erase();
    expect(backgroundAtDelete).toBe("studio");
    expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("未能删除");
    expect(value).toEqual({ ...original, background: "studio", beauty: 33 });
    await act(async () => tree.root.findByProps({ "aria-label": photo.label }).props.onClick());
    await erase();
    expect(remove).toHaveBeenLastCalledWith(local.id);
    expect(value.background).toBe(photo.id);
    expect(tree.root.findAllByProps({ "aria-label": local.label })).toHaveLength(0);
  } finally { await act(async () => tree.unmount()); }
});

test("list and import errors leave the existing background selected", async () => {
  value = { ...original, background: "sky" };
  list.mockRejectedValueOnce(new Error("unavailable"));
  add.mockRejectedValueOnce(new Error("unsupported"));
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<MeetingEffectSettings camera={false} />); });
  try {
    expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("无法读取");
    await act(async () => tree.root.findByProps({ type: "file" }).props.onChange({ currentTarget: { files: [new File([], "invalid")] } }));
    expect(tree.root.findByProps({ role: "alert" }).children.join("")).toContain("未能导入");
    expect(value.background).toBe("sky");
  } finally { await act(async () => tree.unmount()); }
});

test("only the processed track is displayed; preference edits do not recapture", async () => {
  const element = { srcObject: null } as HTMLVideoElement;
  const error = mock();
  const stop = startPrejoinPreview(element, false, true, error);
  await tick();
  expect(element.srcObject).toMatchObject({ tracks: [processed.track] });
  write({ ...original, avatar: "cat" });
  expect(processTrack.mock.calls[0][1]().avatar).toBe("cat");
  expect(capture).toHaveBeenCalledTimes(1);
  expect(processTrack).toHaveBeenCalledTimes(1);
  stop(); stop();
  expect(element.srcObject).toBeNull();
  expect(raw.stop).toHaveBeenCalledTimes(1);
  expect(processed.stop).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
  expect(error).not.toHaveBeenCalled();
});

test("previews use the selected inputs only when opened and never request a disabled input", async () => {
  const element = { srcObject: null } as HTMLVideoElement;
  const error = mock();
  devices = { microphoneId: "mic-1", cameraId: "cam-1" };
  const stop = startPrejoinPreview(element, false, true, error);
  await tick();
  expect(capture).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: "cam-1" } } });
  devices = { microphoneId: "mic-2", cameraId: "cam-2" };
  expect(capture).toHaveBeenCalledTimes(1);
  stop();
  const stopAudio = startPrejoinPreview(element, true, false, error);
  await tick();
  expect(capture).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-2" } }, video: false });
  stopAudio();
  const stopDisabled = startPrejoinPreview(element, false, false, error);
  await tick();
  expect(capture).toHaveBeenCalledTimes(2);
  stopDisabled();
  expect(error).not.toHaveBeenCalled();
  devices = { microphoneId: "", cameraId: "" };
});

test("closing during effect setup never attaches a late track or clears a newer preview", async () => {
  let finish!: (result: typeof processed) => void;
  processTrack.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const element = { srcObject: null } as HTMLVideoElement;
  const stop = startPrejoinPreview(element, false, true, mock());
  await tick();
  expect(element.srcObject).toBeNull();
  stop();
  expect(raw.stop).toHaveBeenCalledTimes(1);
  const newer = {} as MediaStream;
  element.srcObject = newer;
  finish(processed);
  await tick();
  expect(processed.stop).toHaveBeenCalledTimes(1);
  expect(element.srcObject).toBe(newer);
});

test("an effect setup failure releases capture instead of falling back to raw video", async () => {
  const cause = new Error("processor unavailable");
  processTrack.mockRejectedValueOnce(cause);
  const error = mock();
  const assignments: unknown[] = [];
  const element = { set srcObject(source: unknown) { assignments.push(source); } } as HTMLVideoElement;
  startPrejoinPreview(element, true, true, error);
  await tick();
  expect(error).toHaveBeenCalledWith(cause);
  expect(assignments).toEqual([null]);
  expect(raw.stop).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(0);
});

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Aperture, CircleDot, Mic, ScreenShare, Settings, Video } from "lucide-react";
import { MeetingEffectSettings } from "./meeting-effect-settings";
import { readMeetingPreferences, subscribeMeetingPreferences, updateMeetingPreferences, type MeetingPreferences } from "./meeting-preferences";

const categories = [
  ["常规", Settings], ["音频", Mic], ["视频", Video], ["共享", ScreenShare], ["特效", Aperture],
  ["录制", CircleDot],
] as const;
type Category = typeof categories[number][0];

export function useMeetingUserPreferences() {
  const [prefs, setPrefs] = useState(readMeetingPreferences);
  useEffect(() => {
    const sync = () => setPrefs(readMeetingPreferences());
    const unsubscribe = subscribeMeetingPreferences(sync);
    sync();
    return unsubscribe;
  }, []);
  return prefs;
}

function useDeviceList(enabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const media = navigator.mediaDevices;
    let revision = 0;
    async function refresh() {
      const current = ++revision;
      try {
        const list = await media.enumerateDevices();
        if (revision === current) { setDevices(list); setError(false); }
      } catch {
        if (revision === current) { setDevices([]); setError(true); }
      }
    }
    void refresh();
    media?.addEventListener?.("devicechange", refresh);
    return () => { revision++; media?.removeEventListener?.("devicechange", refresh); };
  }, [enabled]);
  return { devices, error };
}

function DeviceSelect({ label, devices, value, onChange, disabled }: {
  label: string; devices: MediaDeviceInfo[]; value: string; onChange: (id: string) => void; disabled?: boolean;
}) {
  return <label>{label}<select value={value} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
    <option value="">系统默认</option>
    {value && !devices.some(d => d.deviceId === value) && <option value={value} disabled>已选设备（当前不可见）</option>}
    {devices.filter(d => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
  </select></label>;
}

export function MeetingUserSettings({ entry, prefs, preview, camera, prejoin }: {
  entry: "prejoin" | "room"; prefs: MeetingPreferences; preview: ReactNode; camera: boolean;
  prejoin?: { heading: ReactNode; controls: ReactNode };
}) {
  const open = !prejoin;
  const initialCategory = entry === "prejoin" ? "特效" : "常规";
  const [category, setCategory] = useState<Category>(initialCategory);
  const [saveError, setSaveError] = useState(false);
  const content = useRef<HTMLElement>(null);
  const initialButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  const headingId = useId();
  useLayoutEffect(() => {
    if (open && !wasOpen.current) { setCategory(initialCategory); initialButton.current?.focus(); }
    wasOpen.current = open;
  }, [open, initialCategory]);
  useLayoutEffect(() => { if (content.current) content.current.scrollTop = 0; }, [category]);
  const { devices, error } = useDeviceList(open && (category === "音频" || category === "视频"));
  const canSelectSpeaker = typeof HTMLMediaElement !== "undefined" && typeof HTMLMediaElement.prototype.setSinkId === "function";
  function save(patch: Partial<MeetingPreferences>) {
    try { updateMeetingPreferences(patch); setSaveError(false); }
    catch { setSaveError(true); }
  }
  function check(key: "defaultMic" | "defaultCamera" | "meetingReminders" | "mirrorPreview" | "participantSounds", label: string) {
    return <label className="check"><input type="checkbox" checked={prefs[key]} onChange={e => save({ [key]: e.currentTarget.checked })} />{label}</label>;
  }
  return <div className={open ? "meeting-user-settings" : "prejoin-content"}>
    {open && <nav aria-label="会议设置分类" className="settings-categories">
      {categories.map(([name, Icon]) => <button type="button" key={name} aria-current={category === name ? "page" : undefined}
        data-meeting-initial-focus={name === initialCategory ? "" : undefined}
        ref={name === initialCategory ? initialButton : undefined} onClick={() => setCategory(name)}>
        <Icon size={18} aria-hidden="true"/><span>{name}</span>
      </button>)}
    </nav>}
    <section ref={content} className={open ? "settings-content" : undefined} aria-labelledby={open ? headingId : undefined} tabIndex={open ? 0 : undefined}>
      {open ? <h3 id={headingId}>{category}</h3> : prejoin.heading}
      {/* Keep the prejoin video element mounted: only the presentation changes. */}
      <div hidden={open && category !== "视频" && category !== "特效"}>
        {(entry === "prejoin" || category === "视频" || category === "特效") && preview}
      </div>
      {prejoin ? prejoin.controls : <>
      {category === "常规" && <>
        <h4>通知</h4>
        {check("meetingReminders", "日程会议开始通知")}
        {check("participantSounds", "参会者进出会议声音提醒")}
        <h4>入会默认设备状态</h4>
        {check("defaultMic", "默认开启麦克风")}{check("defaultCamera", "默认开启摄像头")}
        <p className="sub small">下次打开预入会窗口时使用，可在加入前临时更改。</p>
      </>}
      {category === "音频" && <>
        {check("defaultMic", "加入会议时默认开启麦克风")}
        <DeviceSelect label="麦克风" devices={devices.filter(d => d.kind === "audioinput")} value={prefs.microphoneId} onChange={microphoneId => save({ microphoneId })} />
        <p className="sub small">下次开启麦克风时使用所选设备。</p>
        <DeviceSelect label="扬声器" devices={devices.filter(d => d.kind === "audiooutput")} value={prefs.speakerId} disabled={!canSelectSpeaker} onChange={speakerId => save({ speakerId })} />
        {!canSelectSpeaker && <p className="sub small">当前宿主不支持切换扬声器，请使用系统声音设置。</p>}
        <label>输出音量 · {prefs.outputVolume}%<input type="range" min={0} max={100} value={prefs.outputVolume} aria-valuetext={`${prefs.outputVolume}%`} onChange={e => save({ outputVolume: e.currentTarget.valueAsNumber })} /></label>
      </>}
      {category === "视频" && <>
        {check("defaultCamera", "加入会议时默认开启摄像头")}
        <DeviceSelect label="摄像头" devices={devices.filter(d => d.kind === "videoinput")} value={prefs.cameraId} onChange={cameraId => save({ cameraId })} />
        <p className="sub small">下次开启摄像头时使用所选设备。</p>
        {check("mirrorPreview", "镜像本地摄像头预览")}
        <p className="sub small">镜像只改变你看到的本地画面。</p>
      </>}
      {(category === "音频" || category === "视频") && <p className="sub small">{error ? "无法读取设备列表。" : "仅列出系统已允许查看的设备。"}</p>}
      {category === "共享" && <label>下次屏幕共享的画质<select value={prefs.shareQuality} onChange={e => save({ shareQuality: e.currentTarget.value as MeetingPreferences["shareQuality"] })}>
        <option value="balanced">均衡</option><option value="detail">细节优先（文字、文档）</option><option value="motion">流畅优先（动态画面）</option>
      </select></label>}
      {category === "特效" && <MeetingEffectSettings camera={camera} />}
      {category === "录制" && <p className="capability-note">当前版本不支持会议录制，不会生成本地或云端录像。</p>}
      {saveError && <p role="alert">无法保存会议偏好，请重试。</p>}
      </>}
    </section>
  </div>;
}

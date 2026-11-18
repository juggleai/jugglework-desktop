import { useEffect, useId, useRef, useState } from "react";
import { MEETING_BACKGROUND_PRESETS } from "./meeting-background-catalog";
import { meetingAvatars, type MeetingAvatar } from "./meeting-avatar-catalog";
import { deleteImportedBackground, importMeetingBackground, listImportedBackgrounds } from "./meeting-background-imports";
import type { MeetingVideoEffects } from "./video-effects";
import { readMeetingVideoEffects, subscribeMeetingVideoEffects, writeMeetingVideoEffects } from "./video-effects-preferences";

const original: MeetingVideoEffects = { background: "none", avatar: "none", beauty: 0, filter: "none" };
const avatarIds = Object.keys(meetingAvatars) as MeetingAvatar[];
const symbols: Record<string, string> = { none: "∅", ...Object.fromEntries(avatarIds.map(id => [id, meetingAvatars[id][1]])) };
const tabs = ["虚拟背景", "虚拟形象", "美颜", "滤镜"] as const;

function Choices<T extends string>({ title, hint, choices, value, select }: {
  title: string; hint?: string; choices: readonly (readonly [T, string])[]; value: T; select: (value: T) => void;
}) {
  return <fieldset className="effect-group">
    <legend>{title}</legend>
    {hint && <p className="sub small">{hint}</p>}
    <div className={title === "虚拟形象" ? "effect-choices avatar-gallery" : "effect-choices"}>{choices.map(([key, label]) =>
      <button key={key} type="button" aria-pressed={key === value} onClick={() => select(key)}>
        <span className="effect-swatch" data-effect={key} aria-hidden="true">{symbols[key]}</span>{label}
      </button>,
    )}</div>
  </fieldset>;
}

type Background = MeetingVideoEffects["background"];
type ImportedBackground = Awaited<ReturnType<typeof importMeetingBackground>>;

function BackgroundTile({ kind, label, url, pressed, disabled, onClick }: {
  kind: Background | "import"; label: string; url?: string; pressed?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className="background-tile" aria-label={label} title={label}
    aria-pressed={pressed} disabled={disabled} onClick={onClick}>
    <span className="background-thumb" data-effect={kind} aria-hidden="true">
      {url ? <img src={url} alt="" loading="lazy" /> : kind === "none" ? "∅" : kind === "import" ? "+" : null}
    </span>
    <span className="background-label">{label}</span>
  </button>;
}

function BackgroundChoices({ value, select }: { value: Background; select: (background: Background) => boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const [items, setItems] = useState<ImportedBackground[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    let current = true;
    listImportedBackgrounds().then(list => { if (current) setItems(list); })
      .catch(() => { if (current) setError("无法读取本机背景，请重新打开特效设置。"); })
      .finally(() => { if (current) setBusy(false); });
    return () => { current = false; mounted.current = false; };
  }, []);

  async function add(file: File) {
    setBusy(true); setError("");
    try {
      const item = await importMeetingBackground(file);
      if (!mounted.current) return;
      setItems(list => [...list.filter(other => other.id !== item.id), item]);
      select(item.id);
    } catch { setError("未能导入背景，请检查图片格式和大小后重试。"); }
    finally { setBusy(false); }
  }

  async function remove(item: ImportedBackground) {
    setError("");
    // Read at click time: another settings window may have changed the active effect.
    if (readMeetingVideoEffects().background === item.id && !select("studio")) return;
    setBusy(true);
    try {
      await deleteImportedBackground(item.id);
      setItems(list => list.filter(other => other.id !== item.id));
    } catch { setError("未能删除本机背景，请重试。"); }
    finally { setBusy(false); }
  }

  const choice = (id: Background, label: string, url?: string) => <BackgroundTile key={id} kind={id} label={label}
    url={url} pressed={value === id} disabled={busy && id.startsWith("custom-")} onClick={() => select(id)} />;
  return <fieldset className="effect-group background-group">
    <legend>虚拟背景</legend>
    <p className="sub small">模糊会覆盖整幅画面，包括人物。其他背景会替换绿幕；没有绿幕时显示完整背景图。</p>
    <input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="选择本机背景图片" onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file && !busy) void add(file);
    }} />
    <div className="background-gallery">
      {choice("none", "关闭")}
      <BackgroundTile kind="import" label="导入本机" disabled={busy} onClick={() => picker.current?.click()} />
      {choice("blur", "整幅模糊")}
      {MEETING_BACKGROUND_PRESETS.map(({ id, label, url }) => choice(id, label, url))}
      {choice("studio", "演播室")}{choice("sky", "天空")}
      {items.map(item => <div className="background-custom" key={item.id}>
        {choice(item.id, item.label, /^(data:image\/|blob:)/i.test(item.url) ? item.url : undefined)}
        <button type="button" className="background-delete" aria-label={`删除 ${item.label}`}
          title={item.id === value ? `删除 ${item.label} 并切换到演播室` : `删除 ${item.label}`}
          disabled={busy} onClick={() => void remove(item)}>×</button>
      </div>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </fieldset>;
}

export function MeetingEffectSettings({ camera }: { camera: boolean }) {
  const [value, setValue] = useState(readMeetingVideoEffects);
  const [tab, setTab] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const [saveError, setSaveError] = useState(false);
  const id = useId();
  useEffect(() => {
    const sync = () => setValue(readMeetingVideoEffects());
    const unsubscribe = subscribeMeetingVideoEffects(sync);
    sync();
    return unsubscribe;
  }, []);
  const change = (patch: Partial<MeetingVideoEffects>) => {
    try { writeMeetingVideoEffects({ ...readMeetingVideoEffects(), ...patch }); setSaveError(false); return true; }
    catch { setSaveError(true); return false; }
  };
  return <div className="effect-settings">
    {!camera && <p className="effect-hint" role="status">摄像头已关闭。可以先选效果，开启摄像头后生效。</p>}
    <div className="effect-tabs" role="tablist" aria-label="特效类型">
      {tabs.map((label, i) => <button key={label} type="button" role="tab" id={`${id}-tab-${i}`} aria-selected={tab === i}
        aria-controls={`${id}-panel-${i}`} tabIndex={tab === i ? 0 : -1} ref={node => { buttons.current[i] = node; }}
        onClick={() => setTab(i)} onKeyDown={e => {
          const last = tabs.length - 1;
          const next = e.key === "ArrowLeft" ? (i + last) % tabs.length : e.key === "ArrowRight" ? (i + 1) % tabs.length
            : e.key === "Home" ? 0 : e.key === "End" ? last : null;
          if (next === null) return;
          e.preventDefault(); setTab(next); buttons.current[next]?.focus();
        }}>{label}</button>)}
    </div>
    {tabs.map((label, i) => <div key={label} id={`${id}-panel-${i}`} role="tabpanel" aria-labelledby={`${id}-tab-${i}`} hidden={tab !== i}>
      {label === "虚拟背景" && <BackgroundChoices value={value.background} select={background => change({ background })} />}
      {label === "虚拟形象" && <Choices<MeetingVideoEffects["avatar"]> title={label} hint="用图形替身代替摄像头画面，不跟踪面部或动作。" value={value.avatar}
        choices={[["none", "无替身"], ...avatarIds.map(id => [id, meetingAvatars[id][0]] as const)]} select={avatar => change({ avatar })} />}
      {label === "美颜" && <div className="effect-group">
        <label htmlFor={id}>柔光美颜强度 <span aria-hidden="true">{value.beauty}%</span></label>
        <input id={id} type="range" min="0" max="100" value={value.beauty} aria-valuetext={`${value.beauty}%`}
          onChange={event => change({ beauty: event.currentTarget.valueAsNumber })} />
      </div>}
      {label === "滤镜" && <Choices<MeetingVideoEffects["filter"]> title={label} value={value.filter}
        choices={[["none", "原色"], ["warm", "暖色"], ["cool", "冷色"], ["mono", "黑白"]]} select={filter => change({ filter })} />}
    </div>)}
    {saveError && <p role="alert">无法保存视频效果，当前设置未更改。</p>}
    <div className="effect-actions"><button type="button" onClick={() => change(original)}>恢复原始</button></div>
  </div>;
}

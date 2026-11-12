import { useEffect, useState } from "react";
import { openMeetingPrivacySettings, relaunchDesktopApp, requestMeetingDevicePermission } from "@/app/lib/desktop";
import { MeetingIcon } from "./meeting-icons";
import { ensureMeetingPermission, meetingPermissionLabels, usePermissionRestart } from "./media-permission";
import { useMeetingStore } from "./store";

type PermissionKind = keyof typeof meetingPermissionLabels;
const permissionKinds = Object.keys(meetingPermissionLabels) as PermissionKind[];

export function MeetingPermissionSetup() {
  const [missing, setMissing] = useState<PermissionKind[]>([]);
  const [busy, setBusy] = useState<PermissionKind | null>(null);
  const [error, setError] = useState("");
  const platform = window.__JUGGLEWORK_ELECTRON__?.meta?.platform;
  useEffect(() => {
    if (platform !== "darwin" && platform !== "windows") return;
    let generation = 0;
    async function refresh() {
      const run = ++generation;
      const results = await Promise.all(permissionKinds.map(kind => requestMeetingDevicePermission(kind, false)));
      if (run === generation) setMissing(permissionKinds.filter((_, i) => !results[i].granted));
    }
    const update = () => void refresh().catch(() => {});
    update();
    window.addEventListener("focus", update);
    return () => { generation++; window.removeEventListener("focus", update); };
  }, [platform]);
  async function authorize(kind: PermissionKind) {
    setBusy(kind);
    setError("");
    try {
      await ensureMeetingPermission(kind);
      setMissing(previous => previous.filter(value => value !== kind));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "申请权限失败，请重试。");
    } finally { setBusy(null); }
  }
  return <>
    {missing.length > 0 && <div className="notice">
      <span>可提前授权会议设备，入会时再选择是否开启。</span>
      {missing.map(kind => <button key={kind} disabled={busy !== null} onClick={() => void authorize(kind)}>
        {busy === kind ? "正在申请…" : `授权${meetingPermissionLabels[kind]}`}
      </button>)}
    </div>}
    {error && <MeetingPermissionNotice message={error} onClose={() => setError("")} />}
    <MeetingPermissionRestart />
  </>;
}

export function MeetingPermissionRestart() {
  const reason = usePermissionRestart(s => s.reason);
  const phase = useMeetingStore(s => s.phase);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!reason) return null;
  async function restart() {
    if (busy) return;
    setBusy(true);
    try {
      const meeting = useMeetingStore.getState();
      if (meeting.phase === "joining") return;
      if (meeting.phase === "joined") await meeting.leave(false);
      await relaunchDesktopApp();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重启失败，请重试。");
    } finally { setBusy(false); }
  }
  return <div className="notice meeting-permission-notice" role="status">
    <div><span>{reason === "granted" ? "已获得授权。重启 JuggleWork 以应用新的设备权限。" : "在系统设置中完成授权后，请重启 JuggleWork。"}</span>
      <button type="button" className="permission-settings-link" disabled={busy || phase === "joining"} onClick={() => void restart()}>
        {phase === "idle" ? "重启 JuggleWork" : "离开会议并重启 JuggleWork"}
      </button>
      <button type="button" className="ghost" disabled={busy} onClick={() => usePermissionRestart.setState({ reason: null })}>稍后</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}

export function MeetingPermissionNotice({ message, onClose }: { message: string; onClose: () => void }) {
  const [openError, setOpenError] = useState("");
  const kinds = /权限|Permission denied/i.test(message)
    ? (["screen", "camera", "microphone"] as const).filter((kind) =>
      kind === "screen" ? /屏幕|共享/.test(message) : kind === "camera" ? /摄像头/.test(message) : /麦克风/.test(message))
    : [];
  const platform = window.__JUGGLEWORK_ELECTRON__?.meta?.platform;
  const settings = kinds.filter(kind => platform === "darwin" || (platform === "windows" && kind !== "screen"));
  return <div className="notice error meeting-permission-notice" role="alert">
    <div style={{ flex: 1 }}>
      <span>{message}</span>
      {settings.map((kind) => <button type="button" className="permission-settings-link" key={kind}
        onClick={() => { setOpenError(""); void openMeetingPrivacySettings(kind).then(() => usePermissionRestart.setState({ reason: "settings" })).catch((e) => setOpenError(e.message)); }}>
        打开{kinds.length > 1 ? (kind === "camera" ? "摄像头" : "麦克风") : ""}系统设置
      </button>)}
      {openError ? <p>{openError}</p> : null}
    </div>
    <button type="button" className="ghost icon-button" aria-label="关闭权限提示" onClick={onClose}><MeetingIcon name="close" width={16} height={16} /></button>
  </div>;
}

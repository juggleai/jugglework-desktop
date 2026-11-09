import { useState } from "react";
import { openMeetingPrivacySettings } from "@/app/lib/desktop";
export function MeetingPermissionNotice({ message, onClose }: { message: string; onClose: () => void }) {
  const [openError, setOpenError] = useState("");
  const kinds = /权限|Permission denied/i.test(message)
    ? (["screen", "camera", "microphone"] as const).filter((kind) =>
      kind === "screen" ? /屏幕|共享/.test(message) : kind === "camera" ? /摄像头/.test(message) : /麦克风/.test(message))
    : [];
  return <div className="notice error meeting-permission-notice" role="alert">
    <div style={{ flex: 1 }}>
      <span>{message}</span>
      {kinds.map((kind) => <button type="button" className="permission-settings-link" key={kind}
        onClick={() => { setOpenError(""); void openMeetingPrivacySettings(kind).catch((e) => setOpenError(e.message)); }}>
        打开{kinds.length > 1 ? (kind === "camera" ? "摄像头" : "麦克风") : ""}系统设置
      </button>)}
      {openError ? <p>{openError}</p> : null}
    </div>
    <button type="button" className="ghost icon-button" aria-label="关闭权限提示" onClick={onClose}>×</button>
  </div>;
}

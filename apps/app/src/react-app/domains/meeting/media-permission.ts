import { create } from "zustand";
import { requestMeetingDevicePermission } from "@/app/lib/desktop";

export const usePermissionRestart = create<{ reason: "granted" | "settings" | null }>(() => ({ reason: null }));
export const meetingPermissionLabels = { microphone: "麦克风", camera: "摄像头", screen: "屏幕录制" };

export async function ensureMeetingPermission(kind: keyof typeof meetingPermissionLabels) {
  const label = meetingPermissionLabels[kind];
  const result = await requestMeetingDevicePermission(kind);
  if (result.status === "restricted") throw new Error(`${label}受系统策略限制，请联系设备管理员。`);
  if (!result.granted) {
    const platform = typeof window !== "undefined" && window.__JUGGLEWORK_ELECTRON__?.meta?.platform;
    if (platform === "darwin") usePermissionRestart.setState({ reason: "settings" });
    const hint = platform === "windows"
      ? "请在系统设置中允许桌面应用访问此设备。"
      : "请打开系统设置，为 JuggleWork（开发版为 Electron）开启此项权限。";
    throw new Error(`${label}权限未开启。${hint}`);
  }
  if ("newlyGranted" in result && result.newlyGranted) usePermissionRestart.setState({ reason: "granted" });
}

export async function ensureMeetingMediaPermissions(mic: boolean, camera: boolean) {
  if (camera) await ensureMeetingPermission("camera");
  if (mic) await ensureMeetingPermission("microphone");
}
// Chromium also rejects getDisplayMedia when our chooser is dismissed. Only
// route a macOS user to Settings when the native permission is missing.
export async function handleScreenCaptureDenied() {
  if (typeof window !== "undefined" && window.__JUGGLEWORK_ELECTRON__?.meta?.platform === "darwin") {
    await ensureMeetingPermission("screen");
    return;
  }
  throw new Error("屏幕共享已取消或权限未开启，请重新选择要共享的屏幕或窗口。");
}

export function meetingDeviceError(error: unknown, mic: boolean, camera: boolean): string {
  const value = error as {name?: string; message?: string};
  if (value?.name === "NotAllowedError" || /permission denied/i.test(value?.message || ""))
    return `${camera ? "摄像头" : ""}${camera && mic ? "和" : ""}${mic ? "麦克风" : ""}权限被拒绝。请打开系统设置授权当前应用，然后重启应用重试。`;
  return value?.message || "无法访问音视频设备，请检查设备连接。";
}

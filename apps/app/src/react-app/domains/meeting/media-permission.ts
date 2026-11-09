import { requestMeetingDevicePermission } from "@/app/lib/desktop";
export async function ensureMeetingMediaPermissions(mic: boolean, camera: boolean) {
  for (const kind of [camera ? "camera" : null, mic ? "microphone" : null] as const) {
    if (!kind) continue;
    const result = await requestMeetingDevicePermission(kind);
    if (!result.granted) throw new Error(
      `${kind === "camera" ? "摄像头" : "麦克风"}权限未开启。请打开系统设置允许当前应用使用设备，然后重启应用重试。`);
  }
}
export function meetingDeviceError(error: unknown, mic: boolean, camera: boolean): string {
  const value = error as {name?: string; message?: string};
  if (value?.name === "NotAllowedError" || /permission denied/i.test(value?.message || ""))
    return `${camera ? "摄像头" : ""}${camera && mic ? "和" : ""}${mic ? "麦克风" : ""}权限被拒绝。请打开系统设置授权当前应用，然后重启应用重试。`;
  return value?.message || "无法访问音视频设备，请检查设备连接。";
}

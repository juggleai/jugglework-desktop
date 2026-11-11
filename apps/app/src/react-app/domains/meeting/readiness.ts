import type { MeetingReadiness } from "./types";

/** Explain the same server admission gates used by create/join. */
export function meetingReadinessReason(value: MeetingReadiness | null): string {
  if (!value) return "尚未获取会议配置，请刷新重试";
  if (value.ready) return "";
  const reasons: string[] = [];
  if (!value.settings.enabled) reasons.push("服务端未启用会议（meeting.enabled）");
  if (!value.settings.appId) reasons.push("服务端未配置 ZEGO AppID");
  if (!value.hasServerSecret) reasons.push("服务端未配置有效的 ZEGO ServerSecret");
  if (!value.settings.admissionConfigured)
    reasons.push("服务端尚未确认聊天室和音视频准入权限（meeting.admissionConfigured）");
  return reasons.length
    ? reasons.join("；")
    : "组织 IM 服务尚未就绪，请检查组织的 IM 配置";
}

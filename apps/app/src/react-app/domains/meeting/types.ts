export type MeetingParticipant = {
  userId: string;
  name: string;
  sessionId: string;
  joinedAt: string;
  lastSeenAt: string;
};
/**
 * 会议当前共享槽
 * @param id        共享 id，每次占用重新生成
 * @param kind      共享类型：screen / doc
 * @param userId    共享人
 * @param sessionId 共享人的参会会话
 * @param startedAt 占用时间
 */
export type MeetingShare = {
  id: string;
  kind: "screen" | "doc";
  userId: string;
  sessionId: string;
  startedAt: string;
};
export type Meeting = {
  id: string;
  organizationId: string;
  code: string;
  title: string;
  description: string;
  sourceKind: "workbench" | "group" | "direct";
  sourceId: string;
  organizerId: string;
  hostId: string;
  status:
    "scheduled" | "preparing" | "live" | "ended" | "cancelled" | "expired";
  version: number;
  startAt: string;
  endAt: string;
  timezone: string;
  startedAt?: string;
  endedAt?: string;
  locked: boolean;
  /** 当前共享槽，仅记录谁在共享，不含文档内容或位置。 */
  share?: MeetingShare;
  invites: Record<string, string>;
  participants: Record<string, MeetingParticipant>;
};
export type MeetingSettings = {
  enabled: boolean;
  appId: number;
  capacity: number;
  admissionConfigured: boolean;
};
export type MeetingReadiness = {
  source: "file";
  settings: MeetingSettings;
  ready: boolean;
  hasServerSecret: boolean;
  canManage: boolean;
};
export type MeetingJoin = {
  meeting: Meeting;
  sessionId: string;
  chatroomId: string;
  appId: number;
  roomId: string;
  userId: string;
  userName: string;
  token: string;
  expiresAt: string;
};
export type MeetingCreate = {
  title: string;
  description?: string;
  immediate: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
  sourceKind?: Meeting["sourceKind"];
  sourceId?: string;
  invitees?: string[];
};
export const meetingClosed = (m: Meeting) =>
  ["ended", "cancelled", "expired"].includes(m.status);
export const meetingStatusLabel = (m: Meeting) =>
  ({
    scheduled: "待开始",
    preparing: "准备中",
    live: "进行中",
    ended: "已结束",
    cancelled: "已取消",
    expired: "未举行",
  })[m.status];

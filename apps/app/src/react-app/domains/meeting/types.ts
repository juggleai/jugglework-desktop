export type MeetingParticipant = {
  userId: string;
  name: string;
  sessionId: string;
  joinedAt: string;
  lastSeenAt: string;
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

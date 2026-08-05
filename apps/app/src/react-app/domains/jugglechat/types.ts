export type ChatView = "conversations" | "contacts" | "favorites" | "settings";

export type ServerSetting = {
  app_key: string;
  app_servers: string[];
  im_servers: string[];
  api_base_url?: string;
};

export type ChatUser = {
  id: string;
  token: string;
  authorization: string;
  name: string;
  portrait?: string;
  isUsed?: boolean;
};

export type ChatConversation = {
  conversationId: string;
  conversationType: number;
  conversationTitle?: string;
  conversationAlias?: string;
  conversationPortrait?: string;
  conversationUserType?: number;
  latestMessage?: ChatMessage;
  latestUnreadIndex?: number;
  sortTime?: number;
  unreadCount?: number;
  undisturbType?: number;
  isTop?: boolean | number;
  [key: string]: unknown;
};

export type ChatMessageContent = {
  content?: string;
  url?: string;
  thumbnail?: string;
  snapshotUrl?: string;
  name?: string;
  type?: string;
  size?: number;
  duration?: number;
  width?: number;
  height?: number;
  reason?: number;
  title?: string;
  previewList?: Array<{ userName?: string; userId?: string; portrait?: string; content?: string }>;
  messageIdList?: string[];
  user_id?: string;
  portrait?: string;
  members?: Array<{ user_id?: string; nickname?: string }>;
  operator?: { user_id?: string; nickname?: string };
  [key: string]: unknown;
};

export type ChatMessage = {
  messageId?: string;
  tid?: string;
  messageIndex?: number;
  conversationId: string;
  conversationType: number;
  conversationTitle?: string;
  name: string;
  content: ChatMessageContent;
  sender?: {
    id?: string;
    name?: string;
    portrait?: string;
  };
  isSender?: boolean;
  sentTime?: number;
  sentState?: number;
  referMsg?: ChatMessage;
  reactions?: Record<string, ChatReaction[]>;
  translation?: string;
  isTranslating?: boolean;
  isShowTranslation?: boolean;
  isUpdated?: boolean;
  isRead?: boolean;
  readCount?: number;
  percent?: number;
  localUrl?: string;
  localSendAnimation?: boolean;
  lifeCountdownTime?: number;
  lifeTimeAfterRead?: number;
  destroyTime?: number;
  mentionInfo?: {
    mentionType?: number;
    members?: Array<{ id: string; name?: string }>;
  };
  streamMsg?: { isEnd?: boolean; streams?: string };
  [key: string]: unknown;
};

export type ChatReaction = {
  key: string;
  value: string;
  user?: Partial<ChatUser> & { id?: string; name?: string; portrait?: string };
  isRemove?: boolean;
};

export type ChatContact = {
  user_id: string;
  member_id?: string;
  identity_user_id?: string;
  conversationType?: number;
  nickname?: string;
  avatar?: string;
  friend_display_name?: string;
  user_type?: number;
  [key: string]: unknown;
};

export type ChatGroupMember = {
  user_id?: string;
  id?: string;
  nickname?: string;
  name?: string;
  group_display_name?: string;
  avatar?: string;
  portrait?: string;
  role?: number;
  [key: string]: unknown;
};

export type ChatGroupInfo = {
  id: string;
  nickname: string;
  avatar?: string;
  members: ChatGroupMember[];
  member_count: number;
  member_offset?: string;
  my_role: number;
  grp_display_name?: string;
  group_management: Record<string, number>;
};

export type ApiEnvelope<T = unknown> = {
  code: number;
  msg?: string;
  data: T;
};

export type OrganizationMember = {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  joinedAt: string;
  isOwner: boolean;
  user: {
    id: string;
    imUserId: string;
    account: string;
    email: string;
    name: string;
    avatar: string | null;
  };
};

export type OrganizationMembersResult = {
  members: OrganizationMember[];
  total: number;
  limit: number;
  offset: number;
};

export type OrganizationTeam = {
  id: string;
  teamId?: string;
  name: string;
  memberIds: string[];
  managedByScim: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationTeamsResult = {
  teams: OrganizationTeam[];
};

export type OrganizationChatGroup = {
  id: string;
  name: string;
  avatar?: string;
  groupType: "normal" | "team" | string;
  ownerId?: string;
  orgId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type OrganizationChatGroupsResult = {
  groups: OrganizationChatGroup[];
  total: number;
};

export type SkillEnvelope = {
  requestId: string;
  source: string;
  module: string;
  action: string;
  args?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type SkillResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: { code?: string; message: string; data?: unknown } };

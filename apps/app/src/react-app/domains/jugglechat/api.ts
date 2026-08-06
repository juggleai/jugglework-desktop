import type {
  ApiEnvelope,
  ChatGroupMember,
  OrganizationChatGroup,
  OrganizationChatGroupsResult,
  OrganizationMembersResult,
  OrganizationTeamsResult,
} from "./types";
import { readDenIMLoginBootstrap, readDenSettings, resolveDenBaseUrls } from "@/app/lib/den";
import { getServerSetting } from "./storage";

function normalizeServer(value: string) {
  const trimmed = value.trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function apiBase() {
  const setting = getServerSetting();
  const server = setting?.app_servers[0];
  if (!server) throw new Error("尚未配置 Chat 应用服务器");
  return `${normalizeServer(server)}/jim`;
}

function organizationApiBase() {
  const settings = readDenSettings();
  if (!settings.baseUrl) throw new Error("尚未配置 JuggleWork 服务地址");
  return resolveDenBaseUrls(settings).apiBaseUrl.replace(/\/$/, "");
}

function apiErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const value = payload as { message?: unknown; msg?: unknown; error?: unknown };
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (typeof value.msg === "string" && value.msg.trim()) return value.msg;
    if (typeof value.error === "string" && value.error.trim()) return value.error;
  }
  return `JuggleWork 服务请求失败（HTTP ${status}）`;
}

async function organizationRequest<T>(path: string, init: RequestInit = {}, authenticated = true) {
  const settings = readDenSettings();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (authenticated && settings.authToken) headers.set("Authorization", `Bearer ${settings.authToken}`);
  if (authenticated && settings.activeOrgId) headers.set("x-jugglework-legacy-org-id", settings.activeOrgId);
  const response = await fetch(`${organizationApiBase()}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`JuggleWork 服务返回了无效数据（HTTP ${response.status}）`);
    }
  }
  if (!response.ok) {
    if (response.status === 401 && authenticated) {
      window.dispatchEvent(new CustomEvent("jugglechat:unauthorized"));
    }
    throw new Error(apiErrorMessage(payload, response.status));
  }
  return payload as T;
}

export async function chatRequest<T>(pathOrUrl: string, init: RequestInit = {}) {
  const setting = getServerSetting();
  const settings = readDenSettings();
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${apiBase()}/${pathOrUrl.replace(/^\//, "")}`;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (setting?.app_key) headers.set("AppKey", setting.app_key);
  if (settings.authToken) headers.set("Authorization", `Bearer ${settings.authToken}`);
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent("jugglechat:unauthorized"));
  }
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Chat 服务返回了无效数据（HTTP ${response.status}）`);
  }
}

export async function getMembers() {
  const limit = 200;
  let offset = 0;
  let total = 0;
  const members: OrganizationMembersResult["members"] = [];
  do {
    const page = await organizationRequest<OrganizationMembersResult>(
      `/v1/members?limit=${limit}&offset=${offset}`,
      { method: "GET" },
    );
    members.push(...(Array.isArray(page.members) ? page.members : []));
    total = Number(page.total) || members.length;
    if (!page.members?.length) break;
    offset += page.members.length;
  } while (offset < total);
  return { members, total, limit, offset: 0 } satisfies OrganizationMembersResult;
}

export function getMembersPage(limit = 50, offset = 0) {
  return organizationRequest<OrganizationMembersResult>(
    `/v1/members?limit=${limit}&offset=${offset}`,
    { method: "GET" },
  );
}

export function searchFriends(key: string) {
  return chatRequest<ApiEnvelope>("friends/search", { method: "POST", body: JSON.stringify({ key }) });
}

async function getChatGroups() {
  const limit = 100;
  let offset = 0;
  let total = 0;
  const groups: OrganizationChatGroup[] = [];
  do {
    const page = await organizationRequest<OrganizationChatGroupsResult>(
      `/v1/groups?limit=${limit}&offset=${offset}`,
      { method: "GET" },
    );
    groups.push(...(Array.isArray(page.groups) ? page.groups : []));
    total = Number(page.total) || groups.length;
    if (!page.groups?.length) break;
    offset += page.groups.length;
  } while (offset < total);
  return groups;
}

export function getChatGroupsForContacts() {
  return getChatGroups();
}

export function getTeams() {
  return organizationRequest<OrganizationTeamsResult>("/v1/teams", { method: "GET" });
}

export function createGroup(name: string, members: ChatContactInput[]) {
  // POST /api/v1/groups expects user IDs (not org member IDs). The server
  // auto-includes the creator as owner via dedupedUserIDs(ownerUserID, ...).
  const memberIds = members.map((member) => member.identity_user_id).filter((id): id is string => Boolean(id));
  if (memberIds.length !== members.length) throw new Error("成员数据缺少用户 ID，请刷新后重试");
  return organizationRequest<{ group: OrganizationChatGroup }>("/v1/groups", {
    method: "POST",
    body: JSON.stringify({ name, memberIds }),
  });
}

export async function getGroupInfo(groupId: string): Promise<ApiEnvelope<Record<string, unknown>>> {
  const [groups, membersResult] = await Promise.all([getChatGroups(), getMembers()]);
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new Error("群组不存在或已被删除");
  const currentIMUserId = readDenIMLoginBootstrap()?.imUserId;
  const currentMember = membersResult.members.find((member) => member.user.imUserId === currentIMUserId);
  return {
    code: 0,
    data: {
      group_id: group.id,
      group_name: group.name,
      group_avatar: group.avatar || "",
      members: [],
      member_count: 0,
      my_role: currentMember?.user.id === group.ownerId ? 1 : 0,
      group_type: group.groupType,
      owner_id: group.ownerId,
      group_management: { group_mention_all_right: 7 },
    },
  };
}

export async function getGroupMembers(groupId: string, limit = 100, offset = "") {
  void limit;
  void offset;
  const result = await organizationRequest<{
    members: Array<{ userId: string; imUserId: string; name: string; email: string; avatar?: string | null }>;
  }>(`/v1/groups/${encodeURIComponent(groupId)}/members`, { method: "GET" });
  const members: ChatGroupMember[] = (result.members ?? []).map((member) => ({
    id: member.imUserId,
    user_id: member.imUserId,
    identity_user_id: member.userId,
    nickname: member.name || member.email || member.imUserId,
    name: member.name || member.email || member.imUserId,
    avatar: member.avatar || undefined,
    portrait: member.avatar || undefined,
  }));
  return {
    code: 0,
    data: { items: members, members, offset: "" },
  } satisfies ApiEnvelope<{ items: ChatGroupMember[]; members: ChatGroupMember[]; offset: string }>;
}

export function updateGroup(groupId: string, values: { group_name?: string; group_portrait?: string }) {
  if (!values.group_name?.trim()) throw new Error("群名称不能为空");
  return organizationRequest<{ group: OrganizationChatGroup }>(`/v1/groups/${encodeURIComponent(groupId)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: values.group_name.trim() }),
  }).then((data) => ({ code: 0, data } satisfies ApiEnvelope<typeof data>));
}

export function inviteGroupMembers(groupId: string, memberIds: string[]) {
  return organizationRequest<Record<string, never>>(`/v1/groups/${encodeURIComponent(groupId)}/members`, {
    method: "POST",
    body: JSON.stringify({ memberIds }),
  }).then((data) => ({ code: 0, data } satisfies ApiEnvelope<typeof data>));
}

export function removeGroupMembers(groupId: string, memberIds: string[]) {
  return organizationRequest<Record<string, never>>(`/v1/groups/${encodeURIComponent(groupId)}/members`, {
    method: "DELETE",
    body: JSON.stringify({ memberIds }),
  }).then((data) => ({ code: 0, data } satisfies ApiEnvelope<typeof data>));
}

export function getGroupNotice(groupId: string) {
  return chatRequest<ApiEnvelope<{ content?: string }>>(`groups/getgrpannouncement?group_id=${encodeURIComponent(groupId)}`, { method: "GET" });
}

export function setGroupNotice(groupId: string, content: string) {
  return chatRequest<ApiEnvelope>("groups/setgrpannouncement", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, content }),
  });
}

export function setGroupDisplayName(groupId: string, displayName: string) {
  return chatRequest<ApiEnvelope>("groups/setdisplayname", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, grp_display_name: displayName }),
  });
}

export function setGroupMute(groupId: string, isMute: boolean) {
  return chatRequest<ApiEnvelope>("groups/management/setmute", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, is_mute: Number(isMute) }),
  });
}

export function setGroupHistoryVisible(groupId: string, visible: boolean) {
  return chatRequest<ApiEnvelope>("groups/management/sethismsgvisible", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, group_his_msg_visible: Number(visible) }),
  });
}

export function setGroupManagement(groupId: string, name: string, value: number) {
  return chatRequest<ApiEnvelope>("groups/management/set", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, [name]: value }),
  });
}

export function transferGroupOwner(groupId: string, ownerId: string) {
  return organizationRequest<{ group: OrganizationChatGroup }>(`/v1/groups/${encodeURIComponent(groupId)}/owner`, {
    method: "PUT",
    body: JSON.stringify({ userId: ownerId }),
  }).then((data) => ({ code: 0, data } satisfies ApiEnvelope<typeof data>));
}

export function addGroupAdmins(groupId: string, memberIds: string[]) {
  return chatRequest<ApiEnvelope>("groups/management/administrators/add", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, admin_ids: memberIds }),
  });
}

export function removeGroupAdmins(groupId: string, memberIds: string[]) {
  return chatRequest<ApiEnvelope>("groups/management/administrators/del", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, admin_ids: memberIds }),
  });
}

export function getGroupAdmins(groupId: string) {
  return chatRequest<ApiEnvelope<{ items?: ChatGroupMember[]; members?: ChatGroupMember[] } | ChatGroupMember[]>>(
    `groups/management/administrators/list?group_id=${encodeURIComponent(groupId)}`,
    { method: "GET" },
  );
}

export function quitGroup(groupId: string) {
  return chatRequest<ApiEnvelope>("groups/quit", { method: "POST", body: JSON.stringify({ group_id: groupId }) });
}

export function dismissGroup(groupId: string) {
  return organizationRequest<Record<string, never>>(`/v1/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" })
    .then((data) => ({ code: 0, data } satisfies ApiEnvelope<typeof data>));
}

type ChatContactInput = { user_id: string; member_id?: string; identity_user_id?: string };

export async function callBusserver(args: Record<string, unknown> = {}) {
  const http = (args._http && typeof args._http === "object" ? args._http : {}) as Record<string, unknown>;
  const method = String(http.method ?? args.method ?? "POST").toUpperCase();
  const path = String(http.path ?? args._path ?? args.path ?? "");
  if (!path) throw new Error("busserver 请求缺少 path");
  const query = (args.query ?? http.query ?? {}) as Record<string, string>;
  const data = (args._data ?? args.data ?? args) as unknown;
  const queryString = method === "GET" ? new URLSearchParams(query).toString() : "";
  const server = getServerSetting()?.app_servers[0];
  if (!server) throw new Error("尚未配置 Chat 应用服务器");
  const url = `${normalizeServer(server)}${path.startsWith("/") ? path : `/${path}`}${queryString ? `?${queryString}` : ""}`;
  return chatRequest(url, {
    method,
    ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
  });
}

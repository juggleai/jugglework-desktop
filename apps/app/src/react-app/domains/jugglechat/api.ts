import type { ApiEnvelope, ChatGroupMember, LoginResult, ServerSetting } from "./types";
import { getChatUser, getServerSetting } from "./storage";

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

export async function chatRequest<T>(pathOrUrl: string, init: RequestInit = {}) {
  const setting = getServerSetting();
  const user = getChatUser();
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${apiBase()}/${pathOrUrl.replace(/^\//, "")}`;
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  if (setting?.app_key) headers.set("AppKey", setting.app_key);
  if (user?.authorization) headers.set("Authorization", user.authorization);
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

export function loginByAccount(account: string, password: string) {
  return chatRequest<ApiEnvelope<LoginResult>>("login", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
}

export function registerAccount(account: string, password: string) {
  return chatRequest<ApiEnvelope>("register", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
}

export function sendSmsCode(phone: string) {
  return chatRequest<ApiEnvelope>("sms/send", { method: "POST", body: JSON.stringify({ phone }) });
}

export function loginBySms(phone: string, code: string) {
  return chatRequest<ApiEnvelope<LoginResult>>("sms_login", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });
}

export function sendEmailCode(email: string) {
  return chatRequest<ApiEnvelope>("email/send", { method: "POST", body: JSON.stringify({ email }) });
}

export function loginByEmail(email: string, code: string) {
  return chatRequest<ApiEnvelope<LoginResult>>("email/login", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

export function getLoginQrCode() {
  return chatRequest<ApiEnvelope<{ qr_code: string; id: string }>>("login/qrcode", { method: "GET" });
}

export function pollLoginQrCode(id: string) {
  return chatRequest<ApiEnvelope<LoginResult>>("login/qrcode/check", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function getFriends(page = 1, count = 100) {
  return chatRequest<ApiEnvelope<{ items?: unknown[]; users?: unknown[]; friends?: unknown[] }>>(
    `friends/list?count=${count}&page=${page}`,
    { method: "GET" },
  );
}

export function searchFriends(key: string) {
  return chatRequest<ApiEnvelope>("friends/search", { method: "POST", body: JSON.stringify({ key }) });
}

export function applyFriend(friendId: string) {
  return chatRequest<ApiEnvelope>("friends/apply", {
    method: "POST",
    body: JSON.stringify({ friend_id: friendId }),
  });
}

export function getGroups(count = 100, offset = "") {
  return chatRequest<ApiEnvelope>(`groups/mygroups?count=${count}&offset=${encodeURIComponent(offset)}`, { method: "GET" });
}

export function createGroup(name: string, members: ChatContactInput[]) {
  return chatRequest<ApiEnvelope<{ group_id?: string; group_name?: string; group_portrait?: string }>>("groups/add", {
    method: "POST",
    body: JSON.stringify({
      group_name: name,
      group_portrait: "",
      members: members.map((member) => ({ user_id: member.user_id })),
    }),
  });
}

export function getGroupInfo(groupId: string) {
  return chatRequest<ApiEnvelope<Record<string, unknown>>>(`groups/info?group_id=${encodeURIComponent(groupId)}`, { method: "GET" });
}

export function getGroupMembers(groupId: string, limit = 100, offset = "") {
  return chatRequest<ApiEnvelope<{ items?: ChatGroupMember[]; members?: ChatGroupMember[]; offset?: string } | ChatGroupMember[]>>(
    `groups/members/list?group_id=${encodeURIComponent(groupId)}&limit=${limit}&offset=${encodeURIComponent(offset)}`,
    { method: "GET" },
  );
}

export function updateGroup(groupId: string, values: { group_name?: string; group_portrait?: string }) {
  return chatRequest<ApiEnvelope>("groups/update", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, is_notify: true, ...values }),
  });
}

export function inviteGroupMembers(groupId: string, memberIds: string[]) {
  return chatRequest<ApiEnvelope>("groups/invite", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, member_ids: memberIds }),
  });
}

export function removeGroupMembers(groupId: string, memberIds: string[]) {
  return chatRequest<ApiEnvelope>("groups/members/del", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, member_ids: memberIds }),
  });
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
  return chatRequest<ApiEnvelope>("groups/management/chgowner", {
    method: "POST",
    body: JSON.stringify({ group_id: groupId, owner_id: ownerId }),
  });
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
  return chatRequest<ApiEnvelope>("groups/dissolve", { method: "POST", body: JSON.stringify({ group_id: groupId }) });
}

type ChatContactInput = { user_id: string };

export async function resolveOrganization(organId: string): Promise<ServerSetting> {
  const value = organId.trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const server = `http://${value}:9003`;
    return { app_key: "n6wrag6h2csg9wyv", im_servers: [server], app_servers: [server] };
  }
  // The organization directory is public and intentionally receives no
  // tenant/user headers. Adding AppKey here makes browsers preflight a request
  // that the directory service does not need to accept.
  const response = await fetch(`https://index.snailchat.im/serverinfos?no=${encodeURIComponent(value)}`);
  if (!response.ok) throw new Error(`组织查询失败（HTTP ${response.status}）`);
  const result = (await response.json()) as { data?: { server_info_plain?: string } };
  const raw = result.data?.server_info_plain;
  if (!raw) throw new Error("组织不存在或未返回服务器配置");
  const parsed = JSON.parse(raw) as ServerSetting;
  if (!parsed.app_key || !parsed.app_servers?.length) throw new Error("组织服务器配置无效");
  return parsed;
}

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

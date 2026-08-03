import type { ChatUser, ServerSetting } from "./types";

const PREFIX = "jgweb";
const keys = {
  user: "user_auth_token",
  users: "users_auth",
  server: "server_setting",
  organization: "organ_setting",
} as const;

function storageKey(key: string) {
  return `${PREFIX}__${key}`;
}

export function readChatStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { data?: T };
    return parsed.data ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeChatStorage<T>(key: string, value: T) {
  localStorage.setItem(storageKey(key), JSON.stringify({ data: value }));
}

export function removeChatStorage(key: string) {
  localStorage.removeItem(storageKey(key));
}

export function getServerSetting(): ServerSetting | null {
  const value = readChatStorage<Partial<ServerSetting>>(keys.server, {});
  if (!value.app_key || !Array.isArray(value.app_servers) || !Array.isArray(value.im_servers)) {
    return null;
  }
  return value as ServerSetting;
}

export function setServerSetting(setting: ServerSetting) {
  writeChatStorage(keys.server, setting);
}

export function getOrganizationId() {
  return readChatStorage<{ organId?: string }>(keys.organization, {}).organId ?? "";
}

export function setOrganizationId(organId: string) {
  writeChatStorage(keys.organization, { organId });
}

export function getChatUser(): ChatUser | null {
  const value = readChatStorage<Partial<ChatUser>>(keys.user, {});
  return value.id && value.token ? value as ChatUser : null;
}

export function setChatUser(user: ChatUser) {
  writeChatStorage(keys.user, user);
  const accounts = readChatStorage<ChatUser[]>(keys.users, []);
  const next = accounts.filter((item) => item.id !== user.id);
  next.push(user);
  writeChatStorage(keys.users, next);
}

export function clearChatUser() {
  removeChatStorage(keys.user);
}


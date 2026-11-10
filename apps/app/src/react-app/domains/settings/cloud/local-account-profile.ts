import type { DenUser } from "../../../../app/lib/den";

export type StoredAccountProfile = {
  name: string;
  avatar: string | null;
};

export function accountProfileStorageKey(userId: string) {
  return `jugglework.accountProfile.${userId}`;
}

export function readStoredAccountProfile(userId: string): StoredAccountProfile {
  if (typeof window === "undefined") return { name: "", avatar: null };
  try {
    const value = JSON.parse(
      window.localStorage.getItem(accountProfileStorageKey(userId)) ?? "null",
    ) as Partial<StoredAccountProfile> | null;
    return {
      name: typeof value?.name === "string" ? value.name.trim() : "",
      avatar: typeof value?.avatar === "string" ? value.avatar : null,
    };
  } catch {
    return { name: "", avatar: null };
  }
}

export function applyStoredAccountProfile(user: DenUser): DenUser {
  const stored = readStoredAccountProfile(user.id);
  return {
    ...user,
    // The server is authoritative so a stale cache from another release can
    // never hide a profile saved on another device. Cache values only bridge
    // older deployments that did not return these fields at all.
    name: user.name || stored.name,
    avatar: user.avatar || stored.avatar,
  };
}

export function writeStoredAccountProfile(userId: string, profile: StoredAccountProfile) {
  window.localStorage.setItem(accountProfileStorageKey(userId), JSON.stringify(profile));
}

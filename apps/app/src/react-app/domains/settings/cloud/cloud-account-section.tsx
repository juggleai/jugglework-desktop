/** @jsxImportSource react */
import * as React from "react";
import { Building2, Check, Loader2, Pencil } from "lucide-react";

import { readDenSettings, writeDenIMLoginBootstrap, type DenOrgSummary } from "../../../../app/lib/den";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { SettingsNotice } from "../settings-section";
import { t } from "@/i18n";
import { useDenAuth } from "../../cloud/den-auth-provider";
import { useCloudSession } from "./cloud-session-provider";
import {
  accountProfileStorageKey,
  readStoredAccountProfile,
  writeStoredAccountProfile,
  type StoredAccountProfile,
} from "./local-account-profile";

export type AccountUsageSession = {
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  time: { created: number; updated: number };
};

export interface CloudAccountSectionProps {
  orgsBusy: boolean;
  orgsError: string | null;
  sessions: AccountUsageSession[];
}

export function CloudAccountSection({
  orgsBusy,
  orgsError,
  sessions,
}: CloudAccountSectionProps) {
  const { user: cloudUser, setUser, client } = useCloudSession();
  const { user: authoritativeUser, activeOrganization, refresh } = useDenAuth();
  const user = authoritativeUser ?? cloudUser;
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [name, setName] = React.useState("");
  const [nameDraft, setNameDraft] = React.useState("");
  const [avatar, setAvatar] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [profileSaving, setProfileSaving] = React.useState(false);
  const statistics = React.useMemo(() => accountStatistics(sessions), [sessions]);
  const profileKey = user?.id ? accountProfileStorageKey(user.id) : "";

  React.useEffect(() => {
    if (!user || !profileKey) return;
    const stored = readStoredAccountProfile(user.id);
    const nextName = user.name || stored.name || user.account || user.email;
    const nextAvatar = user.avatar || stored.avatar || null;
    setName(nextName);
    setNameDraft(nextName);
    setAvatar(nextAvatar);
  }, [profileKey, user]);

  const saveProfile = React.useCallback(async (next: StoredAccountProfile, avatarDataUrl?: string) => {
    if (!profileKey || !user || profileSaving) return null;
    setProfileSaving(true);
    try {
      const result = await client.updateProfile({ name: next.name, avatarDataUrl });
      writeStoredAccountProfile(result.user.id, {
        name: result.user.name || next.name,
        avatar: result.user.avatar || next.avatar,
      });
      if (result.im) {
        writeDenIMLoginBootstrap(result.im, activeOrganization?.id ?? readDenSettings().activeOrgId ?? null);
      }
      setUser(result.user);
      await refresh();
      setProfileError(null);
      return result.user;
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "无法保存个人资料，请稍后重试。");
      return null;
    } finally {
      setProfileSaving(false);
    }
  }, [activeOrganization?.id, client, profileKey, profileSaving, refresh, setUser, user]);

  const commitName = React.useCallback(async () => {
    const nextName = nameDraft.trim();
    setEditingName(false);
    if (!nextName) {
      setNameDraft(name);
      return;
    }
    if (nextName === name) return;
    const updated = await saveProfile({ name: nextName, avatar });
    if (!updated) {
      setNameDraft(name);
      return;
    }
    const savedName = updated.name || nextName;
    setName(savedName);
    setNameDraft(savedName);
    setAvatar(updated.avatar || avatar);
  }, [avatar, name, nameDraft, saveProfile]);

  const selectAvatar = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setProfileError("请选择图片文件。");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileError("头像图片不能超过 2 MB。");
      return;
    }
    try {
      const nextAvatar = await readFileAsDataUrl(file);
      const updated = await saveProfile({ name, avatar: nextAvatar }, nextAvatar);
      if (!updated) return;
      setAvatar(updated.avatar || nextAvatar);
    } catch {
      setProfileError("无法读取所选图片，请重新选择。");
    }
  }, [name, saveProfile]);

  const identity = name || user?.name || user?.account || user?.email || "?";
  const handle = user?.account || user?.email.split("@")[0] || "";

  return (
    <section className="flex flex-col gap-y-6">
      <div className="flex flex-col items-center py-2 text-center">
        <button
          type="button"
          className="group relative rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
          aria-label="更换头像"
          disabled={profileSaving}
          onClick={() => fileInputRef.current?.click()}
        >
          <Avatar className="size-28 shadow-sm after:border-dls-border">
            {avatar ? <AvatarImage src={avatar} alt={identity} /> : null}
            <AvatarFallback className="bg-amber-7 text-3xl font-normal text-white">
              {initials(identity)}
            </AvatarFallback>
          </Avatar>
          <span className="absolute inset-0 rounded-full bg-black/10 opacity-0 transition-opacity group-hover:opacity-100" />
          <span className="absolute right-0 top-1 flex size-9 items-center justify-center rounded-full bg-gray-12 text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:bg-gray-2/95 dark:text-gray-12 dark:ring-2 dark:ring-gray-8 dark:shadow-[0_4px_14px_rgba(0,0,0,0.55)]">
            <Pencil size={18} />
          </span>
        </button>
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          accept="image/*"
          aria-label="选择头像图片"
          onChange={(event) => void selectAvatar(event)}
        />

        <div className="mt-5 min-h-10">
          {editingName ? (
            <Input
              autoFocus
              value={nameDraft}
              maxLength={48}
              aria-label="编辑昵称"
              className="h-10 w-64 text-center text-lg font-semibold"
              onChange={(event) => setNameDraft(event.currentTarget.value)}
              disabled={profileSaving}
              onBlur={() => void commitName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setNameDraft(name);
                  setEditingName(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="group/name inline-flex max-w-80 items-center gap-2 rounded-lg px-2 py-1 text-2xl font-semibold text-dls-text hover:bg-dls-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="点击编辑昵称"
              onClick={() => setEditingName(true)}
            >
              <span className="truncate">{identity}</span>
              <Pencil className="shrink-0 opacity-0 transition-opacity group-hover/name:opacity-60 group-focus-visible/name:opacity-60" size={15} />
            </button>
          )}
        </div>
        {handle ? <div className="mt-1 text-sm text-dls-secondary">@{handle}</div> : null}
      </div>

      {profileError ? <SettingsNotice tone="error">{profileError}</SettingsNotice> : null}

      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-dls-border bg-dls-surface @2xl/settings:grid-cols-5">
        {statistics.map((item, index) => (
          <div
            key={item.label}
            className={`flex min-h-24 flex-col items-center justify-center gap-1 px-3 py-4 text-center ${index ? "@2xl/settings:border-l @2xl/settings:border-dls-border" : ""}`}
          >
            <strong className="text-lg font-medium text-dls-text">{item.value}</strong>
            <span className="text-xs text-dls-secondary">{item.label}</span>
          </div>
        ))}
      </div>

      {activeOrganization ? (
        <ConnectedOrganization org={activeOrganization} />
      ) : orgsBusy ? (
        <div className="flex items-center gap-2 text-sm text-dls-secondary">
          <Loader2 size={14} className="animate-spin" />
          {t("cloud_account.loading_orgs")}
        </div>
      ) : null}

      {orgsError ? <SettingsNotice tone="error">{orgsError}</SettingsNotice> : null}
    </section>
  );
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("invalid image"));
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(file);
  });
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : value.slice(0, 2)).toUpperCase();
}

function tokenCount(session: AccountUsageSession) {
  const tokens = session.tokens;
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
}

function dayNumber(timestamp: number) {
  const date = new Date(timestamp);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function accountStatistics(sessions: AccountUsageSession[]) {
  const totals = sessions.map(tokenCount);
  const activeDays = [...new Set(sessions.flatMap((session) => [dayNumber(session.time.created), dayNumber(session.time.updated)]))].sort((a, b) => a - b);
  let longestStreak = 0;
  let runningStreak = 0;
  let previous: number | undefined;
  for (const day of activeDays) {
    runningStreak = previous !== undefined && day === previous + 1 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previous = day;
  }
  const today = dayNumber(Date.now());
  let currentStreak = activeDays.at(-1) !== undefined && activeDays.at(-1)! >= today - 1 ? 1 : 0;
  for (let index = activeDays.length - 2; currentStreak && index >= 0; index -= 1) {
    if (activeDays[index] !== activeDays[index + 1]! - 1) break;
    currentStreak += 1;
  }
  const longestDuration = sessions.reduce((maximum, session) => Math.max(maximum, session.time.updated - session.time.created), 0);
  return [
    { value: formatTokens(totals.reduce((sum, value) => sum + value, 0)), label: "累计 Token 数" },
    { value: formatTokens(Math.max(0, ...totals)), label: "Token 使用峰值" },
    { value: formatDuration(longestDuration), label: "最长任务用时" },
    { value: `${longestStreak} 天`, label: "最长连续天数" },
    { value: `${currentStreak} 天`, label: "当前连续天数" },
  ];
}

function formatTokens(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatDuration(durationMs: number) {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return `${Math.floor(Math.max(0, durationMs) / 1_000)} 秒`;
  const hours = Math.floor(minutes / 60);
  if (!hours) return `${minutes} 分`;
  const days = Math.floor(hours / 24);
  if (days) return `${days} 天 ${hours % 24} 小时`;
  return `${hours} 小时 ${minutes % 60} 分`;
}

// Owner and admin share every administrative capability, so an admin must not
// be labelled as a plain member.
function orgRoleLabel(role: DenOrgSummary["role"]): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    default:
      return "Member";
  }
}

export function ConnectedOrganization({
  org,
}: {
  org: Pick<DenOrgSummary, "id" | "name" | "role" | "slug">;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-green-7 bg-dls-surface px-4 py-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-green-3 text-green-11">
        <Building2 size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-dls-text">{org.name}</div>
        <div className="text-xs text-dls-secondary">{orgRoleLabel(org.role)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-green-11">
        {t("dashboard.connected")}
        <Check size={16} />
      </div>
    </div>
  );
}

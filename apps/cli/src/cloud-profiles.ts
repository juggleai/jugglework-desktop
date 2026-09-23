import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CloudProfile = { token: string; organizationId?: string; user?: { id: string; name?: string; email?: string } };
type ProfileFile = { version: 1; profiles: Record<string, CloudProfile>; lastOrganizationByUser: Record<string, Record<string, string>> };

const emptyFile = (): ProfileFile => ({ version: 1, profiles: {}, lastOrganizationByUser: {} });

export class CloudProfileStore {
  constructor(readonly path: string) {}

  async get(origin: string): Promise<CloudProfile | null> {
    return (await this.read()).profiles[origin] ?? null;
  }

  async rememberedOrganization(origin: string, userId: string): Promise<string | null> {
    return (await this.read()).lastOrganizationByUser[origin]?.[userId] ?? null;
  }

  async set(origin: string, profile: CloudProfile): Promise<void> {
    const data = await this.read();
    data.profiles[origin] = profile;
    if (profile.user?.id && profile.organizationId) {
      (data.lastOrganizationByUser[origin] ??= {})[profile.user.id] = profile.organizationId;
    }
    await this.write(data);
  }

  async selectOrganization(origin: string, organizationId: string | null): Promise<void> {
    const data = await this.read();
    const profile = data.profiles[origin];
    if (!profile) throw new Error("Sign in before selecting an organization.");
    if (organizationId) profile.organizationId = organizationId;
    else delete profile.organizationId;
    if (organizationId && profile.user?.id) {
      (data.lastOrganizationByUser[origin] ??= {})[profile.user.id] = organizationId;
    }
    await this.write(data);
  }

  async remove(origin: string): Promise<void> {
    const data = await this.read();
    delete data.profiles[origin];
    await this.write(data);
  }

  private async read(): Promise<ProfileFile> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return emptyFile();
      const profiles = (value as { profiles?: unknown }).profiles;
      if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return emptyFile();
      const valid: Record<string, CloudProfile> = {};
      for (const [origin, profileValue] of Object.entries(profiles as Record<string, unknown>)) {
        if (!profileValue || typeof profileValue !== "object" || Array.isArray(profileValue)) continue;
        const profile = profileValue as Record<string, unknown>;
        if (typeof profile.token !== "string" || !profile.token) continue;
        valid[origin] = {
          token: profile.token,
          ...(typeof profile.organizationId === "string" ? { organizationId: profile.organizationId } : {}),
          ...(profile.user && typeof profile.user === "object" && !Array.isArray(profile.user) && typeof (profile.user as { id?: unknown }).id === "string"
            ? { user: profile.user as CloudProfile["user"] }
            : {}),
        };
      }
      const remembered = (value as { lastOrganizationByUser?: unknown }).lastOrganizationByUser;
      const lastOrganizationByUser: ProfileFile["lastOrganizationByUser"] = {};
      if (remembered && typeof remembered === "object" && !Array.isArray(remembered)) {
        for (const [origin, users] of Object.entries(remembered as Record<string, unknown>)) {
          if (!users || typeof users !== "object" || Array.isArray(users)) continue;
          lastOrganizationByUser[origin] = Object.fromEntries(Object.entries(users as Record<string, unknown>)
            .filter(([userId, orgId]) => userId.trim() && typeof orgId === "string" && orgId.trim())
            .map(([userId, orgId]) => [userId.trim(), (orgId as string).trim()]));
        }
      }
      return { version: 1, profiles: valid, lastOrganizationByUser };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return emptyFile();
      throw error;
    }
  }

  private async write(value: ProfileFile): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export function cloudProfilePath(configPath: string): string {
  return join(dirname(configPath), "cloud-profiles.json");
}

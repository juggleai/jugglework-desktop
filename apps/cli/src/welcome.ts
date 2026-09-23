import type { CliOptions } from "./args.js";
import { CloudProfileStore, cloudProfilePath } from "./cloud-profiles.js";
import { normalizeCloudUrl } from "./cloud-url.js";

type WelcomeCloudOptions = Pick<CliOptions, "cloudUrl" | "cloudToken" | "cloudOrg" | "configPath">;

export async function hasCloudLogin(options: WelcomeCloudOptions): Promise<boolean> {
  if (options.cloudToken) return true;
  try {
    const origin = normalizeCloudUrl(options.cloudUrl).origin;
    return !!await new CloudProfileStore(cloudProfilePath(options.configPath)).get(origin);
  } catch {
    return false;
  }
}

export async function cloudWelcomeLabel(options: WelcomeCloudOptions): Promise<string> {
  try {
    const origin = normalizeCloudUrl(options.cloudUrl).origin;
    const profile = options.cloudToken ? null : await new CloudProfileStore(cloudProfilePath(options.configPath)).get(origin);
    const organization = options.cloudOrg ?? profile?.organizationId ?? null;
    const organizationLabel = organization ? ` · org ${organization}` : " · no org selected";
    if (options.cloudToken) return `environment token${organizationLabel}`;
    if (!profile) return "not signed in · run jugglework login";
    const identity = typeof profile.user?.email === "string" && profile.user.email
      ? profile.user.email
      : typeof profile.user?.name === "string" && profile.user.name
        ? profile.user.name
        : "account";
    return `saved login: ${identity}${organizationLabel}`;
  } catch {
    return "status unavailable · run jugglework doctor";
  }
}

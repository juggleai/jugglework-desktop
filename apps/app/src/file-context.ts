import { createDenClient, initializeDenBootstrapConfig, readDenSettings, readDenLastOrganization, resolveDenDefaultOrganization, isDenSessionRevokedError } from "@/app/lib/den";
import { getResolvedThemeMode } from "@/app/theme";
import { initLocale } from "@/i18n";

/** 只读取已有登录身份和偏好，返回非凭据策略；不挂载主窗口或会话消费者。 */
async function initializeFileContext() {
  const appearance = { lang: initLocale(), theme: getResolvedThemeMode() };
  await initializeDenBootstrapConfig();
  const settings = readDenSettings();
  const signedOut = { baseUrl: settings.baseUrl, signedIn: false, userId: null, organizationId: null, config: {} };
  if (!settings.authToken) return { appearance, context: signedOut };
  try {
    const client = createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken });
    const user = await client.getSession();
    const organizations = await client.listOrgs();
    const organization = resolveDenDefaultOrganization(organizations.orgs, { rememberedOrgId: readDenLastOrganization(user.id), currentOrgId: settings.activeOrgId, serverActiveOrgId: organizations.activeOrgId });
    if (!organization) return { appearance, context: signedOut };
    const config = await client.getDesktopConfig(organization.id);
    return { appearance, context: { baseUrl: settings.baseUrl, signedIn: true, userId: user.id, organizationId: organization.id, config } };
  } catch (error) {
    // TIPS: 失效登录清除旧能力；暂时断网保留 Main 已应用的缓存，不把错误转为开放默认策略。
    return { appearance, ...(isDenSessionRevokedError(error) ? { context: signedOut } : {}) };
  }
}

const bridge = (window as Window & { __JUGGLEWORK_FILE_CONTEXT__?: { complete: (result: unknown) => Promise<void> } }).__JUGGLEWORK_FILE_CONTEXT__;
void initializeFileContext().then((result) => bridge?.complete(result)).catch(() => bridge?.complete({}));
